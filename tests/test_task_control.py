import asyncio
from uuid import uuid4

from test_message import controller, headers, login

from operator_v1.config import Settings
from operator_v1.model import Turn
from operator_v1.worker import MessageWorker


class ActiveModel:
    def __init__(self):
        self.instruction = asyncio.Event()
        self.messages: list[str] = []
        self.interrupted = False

    async def start(self, text: str) -> Turn:
        self.messages.append(text)
        return Turn("model-thread", "model-turn")

    async def resume(self, thread_id: str, text: str) -> Turn:
        self.messages.append(text)
        return Turn(thread_id, "model-turn")

    async def steer(self, turn: Turn, text: str) -> None:
        assert turn.turn_id == "model-turn"
        self.messages.append(text)
        self.instruction.set()

    async def interrupt(self, turn: Turn) -> None:
        assert turn.turn_id == "model-turn"
        self.interrupted = True

    async def result(self, _turn: Turn) -> str:
        await asyncio.Event().wait()
        raise AssertionError("Test turn should stop before producing an answer")


def test_owner_controls_reach_active_turn_and_remain_idempotent(tmp_path):
    settings = Settings(tmp_path)
    settings.create_owner_key()
    worker = MessageWorker(settings)
    with controller(settings) as client:
        login(client, settings)
        body = {"kind": "message", "requestId": str(uuid4()), "text": "Inspect fixture."}
        task = client.post("/api/commands", json=body, headers=headers(settings)).json()["taskId"]
        assert worker.state.claim() == task
        endpoint = f"/api/tasks/{task}/control"

        async def exercise():
            model = ActiveModel()
            pending = asyncio.create_task(worker.run_turn(model, task))
            steer = {"kind": "steer", "requestId": str(uuid4()), "text": "Include exited fixtures."}
            assert client.post(endpoint, json=steer).status_code == 403
            for _ in range(2):
                assert (
                    client.post(endpoint, json=steer, headers=headers(settings)).status_code == 204
                )
            await asyncio.wait_for(model.instruction.wait(), 3)
            stop = {"kind": "stop", "requestId": str(uuid4())}
            for _ in range(2):
                assert (
                    client.post(endpoint, json=stop, headers=headers(settings)).status_code == 204
                )
            assert await asyncio.wait_for(pending, 3) is None
            assert model.messages == ["Inspect fixture.", steer["text"]]
            assert model.interrupted

        asyncio.run(exercise())
        snapshot = client.get("/api/snapshot").json()
        assert snapshot["tasks"][0]["outcome"]["key"] == "stopped"
        assert snapshot["tasks"][0]["checkpoint"] == "completed"
        assert sum(event["kind"] == "stopped" for event in snapshot["events"]) == 1
