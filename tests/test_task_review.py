import asyncio
import json
from contextlib import asynccontextmanager
from uuid import uuid4

import pytest

from operator_v1.config import Settings
from operator_v1.model import CodexSession, ModelError, Turn
from operator_v1.state import State
from operator_v1.worker import MessageWorker


def test_saved_message_replaces_deltas_and_omits_commentary(tmp_path):
    state = State(Settings(tmp_path))

    async def run():
        session = CodexSession(tmp_path, state.profile())
        turn = Turn("thread", "turn")
        ids = {"threadId": turn.thread_id, "turnId": turn.turn_id}
        for item, phase, pieces in [
            ("progress", "commentary", ["Looking", "."]),
            ("answer", "final_answer", ["Read the connector instructions", "."]),
        ]:
            for piece in pieces:
                session.notify("item/agentMessage/delta", {**ids, "itemId": item, "delta": piece})
            session.notify(
                "item/completed",
                {
                    **ids,
                    "item": {
                        "id": item,
                        "type": "agentMessage",
                        "phase": phase,
                        "text": "".join(pieces),
                    },
                },
            )
        session.notify(
            "turn/completed",
            {"threadId": "thread", "turn": {"id": "turn", "status": "completed", "items": []}},
        )
        return await session.result(turn)

    assert asyncio.run(run()) == "Read the connector instructions."


def test_watchdog_uses_last_model_progress(tmp_path, monkeypatch):
    monkeypatch.setattr("operator_v1.model.TURN_IDLE_TIMEOUT", 0.15)
    state = State(Settings(tmp_path))

    async def run():
        session = CodexSession(tmp_path, state.profile())
        turn = Turn("thread", "turn")
        pending = asyncio.create_task(session.result(turn))
        for _ in range(4):
            await asyncio.sleep(0.05)
            session.notify(
                "item/agentMessage/delta",
                {"threadId": "thread", "turnId": "turn", "itemId": "answer", "delta": "text"},
            )
        assert not pending.done()
        with pytest.raises(TimeoutError, match="stopped reporting progress"):
            await asyncio.wait_for(pending, 1)

    asyncio.run(run())


def test_migration_restores_only_missing_answer_without_dispatch(tmp_path, monkeypatch):
    settings = Settings(tmp_path)
    state = State(settings)
    broken, healthy = [state.submit(uuid4(), "Explain the DNS connector.") for _ in range(2)]
    for task, answer in [(broken, ".\n\n."), (healthy, "Use its manifest.")]:
        assert state.claim() == task
        state.remember_thread(task, task, "codex")
        state.finish(task, answer, "Completed", modeled=True)
    with state.transaction(write=True) as db:
        db.execute("DROP TABLE model_runs")
        db.execute("PRAGMA user_version=15")

    class History:
        async def request(self, method, params):
            assert method == "thread/read" and params == {"threadId": broken, "includeTurns": True}
            return {
                "thread": {
                    "turns": [
                        {
                            "id": "prior",
                            "status": "completed",
                            "items": [
                                {
                                    "type": "agentMessage",
                                    "phase": "final_answer",
                                    "text": "Read the instructions in the connector manifest.",
                                }
                            ],
                        }
                    ]
                }
            }

    @asynccontextmanager
    async def only_history(*args, answer_review):
        assert answer_review

        class Session:
            rpc = History()

        yield Session()

    monkeypatch.setattr("operator_v1.task_review.codex_session", only_history)
    monkeypatch.setenv("OPERATOR_MODEL", "codex")
    worker = MessageWorker(settings)
    assert state.claim() == broken
    asyncio.run(worker.run_task(broken))
    assert State(settings).claim() is None
    events = state.snapshot().events
    assert [e.text for e in events if e.task == broken and e.kind == "answered"] == [
        ".\n\n.",
        "Read the instructions in the connector manifest.",
    ]
    assert not any(e.task == healthy and e.data.get("action") == "answer_review" for e in events)


def test_bad_answer_review_pause_and_owner_reply_survive_restart(tmp_path, monkeypatch):
    monkeypatch.setenv("OPERATOR_MODEL", "codex")
    worker = MessageWorker(Settings(tmp_path))
    state = worker.state
    task = state.submit(uuid4(), "Summarize the requested zone.")
    sent = []

    async def answer(self, task, instruction=None):
        sent.append(instruction)
        if instruction:
            return json.dumps({"status": "answered", "text": "The requested zone is example.org."})
        self.state.remember_thread(task, "original", "codex", "exact")
        return json.dumps({"status": "answered", "text": ".\n\n."})

    monkeypatch.setattr(MessageWorker, "answer", answer)

    class Review:
        rpc = None

        async def request(self, method, params):
            return {
                "thread": {
                    "turns": [
                        {
                            "id": "different",
                            "status": "completed",
                            "items": [
                                {
                                    "type": "agentMessage",
                                    "phase": "final_answer",
                                    "text": json.dumps(
                                        {"status": "answered", "text": "Stale answer"}
                                    ),
                                }
                            ],
                        }
                    ]
                }
            }

        async def start(self, text):
            assert "Summarize the requested zone." in text
            return Turn("review", "review-turn")

        async def result(self, _turn):
            return json.dumps({"status": "needs_input", "text": "Which zone should I summarize?"})

    @asynccontextmanager
    async def session(*args, answer_review):
        assert answer_review
        review = Review()
        review.rpc = review
        yield review

    monkeypatch.setattr("operator_v1.task_review.codex_session", session)
    assert state.claim() == task
    asyncio.run(worker.run_task(task))
    assert not any(e.kind == "completed" for e in state.snapshot().events)
    worker = MessageWorker(Settings(tmp_path))
    assert state.claim() == task
    asyncio.run(worker.run_task(task))
    for _ in range(3):
        assert state.claim() is None
    assert [e.text for e in state.snapshot().events if e.kind == "waiting"] == [
        "Which zone should I summarize?"
    ]
    assert state.snapshot().tasks[0].outcome.label == "Waiting for you"
    key = uuid4()
    for _ in range(2):
        state.control(task, key, "steer", "example.org")
    assert state.claim() == task
    asyncio.run(worker.run_task(task))
    assert len(sent) == 2 and sent[0] is None and sent[1].endswith("Owner reply: example.org")
    assert state.claim() is None
    assert state.snapshot().tasks[0].outcome.label == "Answered"


def test_stopped_task_cannot_be_reopened_by_failed_review(tmp_path, monkeypatch):
    monkeypatch.setenv("OPERATOR_MODEL", "codex")
    worker = MessageWorker(Settings(tmp_path))
    task = worker.state.submit(uuid4(), "Check this.")
    assert worker.state.claim() == task
    worker.state.reserve_model_turn(task)

    async def failed_review(*args, **kwargs):
        worker.state.control(task, uuid4(), "stop")
        raise ModelError("No saved result")

    monkeypatch.setattr("operator_v1.worker.recover_reply", failed_review)
    asyncio.run(worker.run_task(task))
    assert worker.state.claim() is None
    assert worker.state.snapshot().events[-1].kind == "stopped"
