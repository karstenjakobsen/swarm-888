import asyncio
import logging
import os
import socket
import stat
import time
from collections.abc import Coroutine
from contextlib import closing, suppress
from typing import Any

from pydantic import ValidationError

from .config import Settings
from .goals import StandingGoals
from .memory_review import MemoryReview
from .model import (
    ModelError,
    ModelSession,
    ModelSignInRequired,
    TaskReply,
    ThreadUnavailable,
    codex_session,
    connect_skills,
)
from .operations import ConfiguredFixtureEngine, Operations
from .simulated_model import SimulatedModel
from .state import State
from .task_objectives import missing_evidence, plan_task
from .task_review import recover_reply
from .typed_catalogs import TypedCatalogs
from .worker_auth import WorkerAuth
from .worker_status import HEARTBEAT_INTERVAL, WorkerHeartbeat


class MessageWorker:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.state = State(settings)
        self.memory_review = MemoryReview(self.state)
        self.next_memory_review = 0.0
        self.operations = Operations(self.state)
        self.goals = StandingGoals(settings, self.state)
        self.fixture_engine = ConfiguredFixtureEngine(settings.directory / "fixture-engine.json")
        self.configured_mode = os.environ.get("OPERATOR_MODEL")
        self.mode = self.configured_mode or self.default_mode()
        if self.mode not in ("acknowledge", "codex", "simulated"):
            raise ValueError("OPERATOR_MODEL must be acknowledge, codex, or simulated")
        self.heartbeat = WorkerHeartbeat(settings, self.mode)
        self.wake = asyncio.Event()
        self.idle = asyncio.Event()
        self.idle.set()
        self.auth = WorkerAuth(settings.directory, self.wake.set, self.idle.wait)

    def default_mode(self) -> str:
        configured = self.settings.catalog_config.is_file() or TypedCatalogs(self.state).bindings()
        return "codex" if configured else "acknowledge"

    async def run_turn(
        self, session: ModelSession, task: str, instruction: str | None = None
    ) -> str | None:
        text = instruction or self.state.text(task)
        thread_id = self.state.thread(task)
        if self.state.stopped(task):
            return None
        if thread_id:
            try:
                turn = await session.resume(thread_id, text)
            except ThreadUnavailable:
                if not instruction:
                    raise
                thread_id = None
        if not thread_id:
            if instruction:
                text = (
                    f"Original request: {self.state.text(task)}\nPrevious work may have succeeded. "
                    f"Continue only the requested follow-up.\n{instruction}"
                )
            turn = await session.start(text)
        self.state.remember_thread(task, turn.thread_id, self.mode, turn.turn_id)
        result = asyncio.create_task(session.result(turn))
        try:
            while not result.done():
                for control in self.state.controls(task):
                    if control["kind"] == "stop":
                        await session.interrupt(turn)
                        self.state.control_applied(control["id"])
                        return None
                    await session.steer(turn, control["text"])
                    self.state.control_applied(control["id"])
                await asyncio.wait((result,), timeout=0.25)
            return result.result()
        except TimeoutError:
            await session.interrupt(turn)
            raise
        finally:
            if not result.done():
                result.cancel()
                await asyncio.gather(result, return_exceptions=True)

    async def answer(self, task: str, instruction: str | None = None) -> str | None:
        if self.mode == "simulated":
            async with connect_skills(self.settings, task) as session:
                try:
                    return await self.run_turn(SimulatedModel(session), task)
                except ModelError as error:
                    failure = error
            raise failure
        await plan_task(self.state, task)
        async with codex_session(self.settings, task, self.state.profile()) as session:
            return await self.run_turn(session, task, instruction)

    async def check_model_task(self, task: str) -> None:
        phase, turn_id, instruction = self.state.reserve_model_turn(task)
        if phase == "waiting":
            return
        errors = (ModelError, OSError, TimeoutError, ExceptionGroup, ValidationError)
        try:
            if phase == "start":
                raw = await self.answer(task, instruction)
                if raw is None:
                    return
                reply = TaskReply.model_validate_json(raw)
            else:
                reply = await recover_reply(self.state, task, turn_id, legacy=phase == "legacy")
            if reply.status == "answered" and (missing := await missing_evidence(self.state, task)):
                self.state.continue_unverified(task, missing)
                return
        except ModelSignInRequired:
            self.auth.require_reconnect()
            with self.state.transaction(write=True) as db:
                if db.execute(
                    """SELECT 1 FROM tasks WHERE id=? AND checkpoint='running'
                               AND NOT EXISTS(SELECT 1 FROM credential_requests WHERE task=? AND resume_needed)""",
                    (task, task),
                ).fetchone():
                    self.state.append(
                        db,
                        task,
                        "waiting",
                        "Reconnect the worker in Inspect → Workers. It will check this task after sign-in.",
                        {"action": "worker_signin"},
                    )
            return
        except errors:
            with self.state.transaction() as db:
                planning = self.state.planning_pending(db, task)
            if planning:
                self.state.continue_unverified(
                    task, "Could not establish the task’s requested deliverables."
                )
                return
            if phase == "start":
                # The durable dispatch marker makes the next queue scan inspect evidence
                # instead of sending the owner's original instruction a second time.
                return
            self.state.wait_for_reply(
                task,
                "I couldn't recover a complete answer from the saved work. "
                "Which part of the original request would you like me to retry?",
            )
            return
        if reply.status == "needs_input":
            self.state.wait_for_reply(task, reply.text)
        else:
            summary = (
                "The operator completed the turn."
                if phase == "start"
                else "Recovered the answer from the saved work."
            )
            self.state.finish(task, reply.text, summary, modeled=True)

    async def drain(self):
        if (
            not self.configured_mode
            and self.mode == "acknowledge"
            and self.default_mode() == "codex"
        ):
            self.mode = "codex"
            self.heartbeat.report = self.heartbeat.report.model_copy(update={"mode": self.mode})
            self.heartbeat.next_beat = 0
        while True:
            if self.mode == "codex":
                self.auth.tick()
            task = self.state.claim(
                operations_only=self.mode == "codex" and self.auth.status.state != "ready",
                allow_model_runs=self.mode == "codex",
            )
            if task is None:
                await self.review_memory_when_idle()
                return
            self.idle.clear()
            self.heartbeat.publish(task)
            try:
                await self.run_task(task)
            finally:
                self.idle.set()
                self.heartbeat.publish()

    async def run_task(self, task: str):
        def pause(delay: float):
            self.heartbeat.publish(task)
            time.sleep(delay)

        if self.operations.run(task, self.fixture_engine, pause=pause):
            return
        if self.mode == "acknowledge":
            self.state.finish(
                task, "I received your message.", "The worker acknowledged the owner’s message."
            )
            return
        if self.mode == "codex":
            await self.run_with_heartbeat(task, self.check_model_task(task))
            return
        try:
            answer = await self.run_with_heartbeat(task, self.answer(task))
        except ModelSignInRequired as error:
            self.auth.require_reconnect()
            self.state.fail(task, str(error))
        except ModelError as error:
            self.state.fail(task, str(error))
        except (OSError, TimeoutError, ExceptionGroup) as error:
            logging.getLogger(__name__).warning("Model execution failed: %s", type(error).__name__)
            self.state.fail(task, "The configured model or tool connection did not complete")
        else:
            if answer is not None:
                self.state.finish(task, answer, "The operator completed the turn", modeled=True)

    async def review_memory_when_idle(self) -> None:
        if (
            self.mode != "codex"
            or self.auth.status.state != "ready"
            or time.monotonic() < self.next_memory_review
        ):
            return
        self.next_memory_review = time.monotonic() + 30
        task = self.memory_review.pending()
        if task is None:
            return
        self.idle.clear()
        self.heartbeat.publish(task)
        try:
            await self.run_with_heartbeat(task, self.memory_review.run(task))
            self.next_memory_review = 0.0
        except ModelSignInRequired:
            self.auth.require_reconnect()
        except (ModelError, OSError, TimeoutError, ExceptionGroup) as error:
            logging.getLogger(__name__).warning("Memory review failed: %s", type(error).__name__)
            self.next_memory_review = time.monotonic() + 60
        finally:
            self.idle.set()
            self.heartbeat.publish()

    async def run_with_heartbeat[Result](
        self, task: str, work: Coroutine[Any, Any, Result]
    ) -> Result:
        turn = asyncio.create_task(work)
        try:
            while not turn.done():
                await asyncio.wait((turn,), timeout=HEARTBEAT_INTERVAL)
                self.heartbeat.publish(task)
            return turn.result()
        finally:
            if not turn.done():
                turn.cancel()
                await asyncio.gather(turn, return_exceptions=True)

    async def handle_connection(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        try:
            command = await asyncio.wait_for(reader.readline(), timeout=1)
            if not command:
                self.wake.set()
                return
            if self.mode != "codex" or os.geteuid() == 0:
                return
            if command == b"auth/connect\n":
                self.auth.start()
            elif command == b"auth/cancel\n":
                self.auth.cancel()
            elif command == b"auth/disconnect\n":
                self.auth.disconnect()
            elif command != b"auth/status\n":
                return
            writer.write(self.auth.status.model_dump_json().encode() + b"\n")
            await writer.drain()
        except (OSError, TimeoutError, ValueError):
            pass
        finally:
            writer.close()
            with suppress(OSError):
                await writer.wait_closed()

    def serve(self):
        asyncio.run(self.serve_async())

    async def serve_async(self):
        path = self.settings.socket
        with (
            self.settings.service_lock("worker"),
            closing(socket.socket(socket.AF_UNIX)) as server,
        ):
            # Only the lock holder can replace a stale socket or recover running tasks.
            try:
                mode = path.lstat().st_mode
            except FileNotFoundError:
                pass
            else:
                if not stat.S_ISSOCK(mode):
                    raise FileExistsError(f"Worker socket path is occupied by a non-socket: {path}")
                path.unlink()
            server.bind(str(path))
            try:
                path.chmod(0o600)
                if os.geteuid() == 0:
                    owner = self.settings.directory.stat()
                    os.chown(path, owner.st_uid, owner.st_gid)
                listener = await asyncio.start_unix_server(
                    self.handle_connection, sock=server, limit=128
                )
                async with listener:
                    while True:
                        self.wake.clear()
                        self.heartbeat.publish()
                        await self.drain()
                        self.goals.run_due()
                        with suppress(TimeoutError):
                            await asyncio.wait_for(self.wake.wait(), timeout=2)
            finally:
                await self.auth.close()
                path.unlink(missing_ok=True)


if __name__ == "__main__":
    os.umask(0o077)
    if os.geteuid() == 0 and os.environ.get("OPERATOR_ALLOW_ROOT_WORKER") != "1":
        raise SystemExit("Root worker requires explicit OPERATOR_ALLOW_ROOT_WORKER=1")
    if os.geteuid() == 0 and os.environ.get("OPERATOR_MODEL") != "acknowledge":
        raise SystemExit("Root worker requires OPERATOR_MODEL=acknowledge for fixture operations")
    print(f"Operator worker effective UID={os.geteuid()} GID={os.getegid()}", flush=True)
    MessageWorker(Settings.load()).serve()
