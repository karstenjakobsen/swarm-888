import asyncio
import logging
import os
import socket
import stat
import time
from contextlib import closing, suppress

from .config import Settings
from .goals import StandingGoals
from .model import ModelError, ModelSession, ModelSignInRequired, codex_session, connect_skills
from .operations import ConfiguredFixtureEngine, Operations
from .simulated_model import SimulatedModel
from .state import State
from .typed_catalogs import TypedCatalogs
from .worker_auth import WorkerAuth
from .worker_status import HEARTBEAT_INTERVAL, WorkerHeartbeat


class MessageWorker:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.state = State(settings)
        self.operations = Operations(self.state)
        self.goals = StandingGoals(settings, self.state)
        self.fixture_engine = ConfiguredFixtureEngine(settings.directory / "fixture-engine.json")
        self.configured_mode = os.environ.get("OPERATOR_MODEL")
        self.mode = self.configured_mode or self.default_mode()
        if self.mode not in ("acknowledge", "codex", "simulated"):
            raise ValueError("OPERATOR_MODEL must be acknowledge, codex, or simulated")
        self.heartbeat = WorkerHeartbeat(settings, self.mode)
        self.wake = asyncio.Event()
        self.auth = WorkerAuth(settings.directory, self.wake.set)

    def default_mode(self) -> str:
        configured = self.settings.catalog_config.is_file() or TypedCatalogs(self.state).bindings()
        return "codex" if configured else "acknowledge"

    async def run_turn(self, session: ModelSession, task: str) -> str | None:
        text = self.state.text(task)
        thread_id = self.state.thread(task)
        turn = await session.resume(thread_id, text) if thread_id else await session.start(text)
        self.state.remember_thread(task, turn.thread_id, self.mode)
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

    async def answer(self, task: str) -> str | None:
        if self.mode == "simulated":
            async with connect_skills(self.settings, task) as session:
                try:
                    return await self.run_turn(SimulatedModel(session), task)
                except ModelError as error:
                    failure = error
            raise failure
        async with codex_session(self.settings, task, self.state.profile()) as session:
            return await self.run_turn(session, task)

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
                operations_only=self.mode == "codex" and self.auth.status.state != "ready"
            )
            if task is None:
                return
            self.heartbeat.publish(task)
            try:
                await self.run_task(task)
            finally:
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
        try:
            answer = await self.answer_with_heartbeat(task)
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

    async def answer_with_heartbeat(self, task: str) -> str | None:
        turn = asyncio.create_task(self.answer(task))
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
