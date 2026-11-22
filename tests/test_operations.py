import asyncio
import json
import os
import signal
import subprocess
from pathlib import Path
from uuid import uuid4

import pytest
from fixture_inspection import inspection_request
from mcp import ClientSession
from mcp.client.stdio import stdio_client
from test_message import controller, headers, login, process, wait_until
from test_skills import bootstrap

from operator_v1.model import skill_server
from operator_v1.operations import Observation, Operations
from operator_v1.state import State


def initialized(tmp_path):
    settings, env = bootstrap(tmp_path)
    settings.create_owner_key()

    async def activate():
        async with (
            stdio_client(skill_server(settings, None)) as (read, write),
            ClientSession(read, write) as session,
        ):
            await session.initialize()
            built = await session.call_tool(
                "skill_scaffold", {"skill": "inspect-docker", **inspection_request()}
            )
            assert not built.isError
            tested = await session.call_tool("skill_test", built.structuredContent)
            assert tested.structuredContent["passed"]
            assert not (await session.call_tool("skill_activate", built.structuredContent)).isError
            return built.structuredContent["revision"]

    return settings, env, asyncio.run(activate())


def request_start(client, settings, target):
    path = "/api/operations/docker-start"
    body = {"requestId": str(uuid4()), "target": target, "skill": "inspect-docker"}
    assert client.post(path, json=body, headers=headers(settings)).status_code == 401
    login(client, settings)
    assert client.post(path, json=body).status_code == 403
    accepted = client.post(path, json=body, headers=headers(settings))
    assert accepted.status_code == 202
    assert client.post(path, json=body, headers=headers(settings)).json() == accepted.json()
    assert (
        client.post(path, json={**body, "target": "f" * 64}, headers=headers(settings)).status_code
        == 409
    )
    return accepted.json()["taskId"]


class LostResult:
    def observe(self, _target: str) -> Observation:
        return "stopped"

    def start(self, _target: str) -> None:
        raise InterruptedError("Simulate worker interruption after dispatch")


class Unreadable:
    def __init__(self):
        self.observations = 0

    def observe(self, _target: str) -> Observation:
        self.observations += 1
        return "unreadable"

    def start(self, _target: str) -> None:
        pytest.fail("Recovery must never dispatch a second write")


def test_unreadable_recovery_is_bounded_and_visible(tmp_path):
    settings, _, revision = initialized(tmp_path)
    original = State(settings)
    with controller(settings) as client:
        task = request_start(client, settings, "a" * 64)
        assert original.claim() == task
        with pytest.raises(InterruptedError):
            Operations(original).run(task, LostResult(), pause=lambda _: None)
        recovered = State(settings)
        engine = Unreadable()
        assert recovered.claim() == task
        assert Operations(recovered).run(task, engine, pause=lambda _: None)
        assert engine.observations == Operations.max_observations - 1
        assert recovered.claim() is None
        with recovered.transaction() as db:
            operation = db.execute("SELECT * FROM operations WHERE task=?", (task,)).fetchone()
            assert operation["dispatches"] == 1
            assert operation["observations"] == Operations.max_observations
            assert operation["revision"] == revision
        result = client.get("/api/snapshot").json()["tasks"][0]
        assert result["outcome"]["key"] == "unknown"


@pytest.mark.skipif(os.environ.get("OPERATOR_ACCEPTANCE_DOCKER") != "1", reason="Uses real Docker")
def test_real_docker_recovers_after_worker_process_dies(tmp_path):
    settings, env, revision = initialized(tmp_path)

    def engine(*args):
        return subprocess.run(
            ["docker", *args], check=True, text=True, capture_output=True, timeout=15
        ).stdout.strip()

    print("Docker engine:", engine("context", "show"), engine("info", "--format", "{{.Name}}"))
    label = "swarm.operator.acceptance=" + uuid4().hex
    target = engine(
        "container",
        "create",
        "--pull=never",
        "--label",
        label,
        os.environ.get("OPERATOR_FIXTURE_IMAGE", "alpine:3.22"),
        "sleep",
        "120",
    )
    try:
        config = settings.directory / "fixture-engine.json"
        config.write_text(
            json.dumps([os.sys.executable, str(Path(__file__).with_name("fixture_engine.py"))])
        )
        with controller(settings) as client:
            task = request_start(client, settings, target)
            code = """
import os
import signal
from operator_v1.config import Settings
from operator_v1.operations import ConfiguredFixtureEngine
from operator_v1.worker import MessageWorker

class DieAfterDispatch(ConfiguredFixtureEngine):
    def start(self, target):
        super().start(target)
        os.kill(os.getpid(), signal.SIGKILL)

worker = MessageWorker(Settings.load())
worker.fixture_engine = DieAfterDispatch(worker.settings.directory / "fixture-engine.json")
worker.serve()
"""
            killed = subprocess.run(
                [os.sys.executable, "-c", code], env=env, check=False, timeout=25
            )
            assert killed.returncode == -signal.SIGKILL
            state = State(settings)
            with state.transaction() as db:
                assert (
                    db.execute(
                        "SELECT checkpoint FROM operations WHERE task=?", (task,)
                    ).fetchone()[0]
                    == "dispatching"
                )
            assert (
                engine("container", "inspect", "--format", "{{.State.Running}}", target) == "true"
            )
            with process(["operator_v1.worker"], env):
                wait_until(
                    lambda: (
                        client.get("/api/snapshot").json()["tasks"][0]["checkpoint"] == "completed"
                    )
                )
                outcome = client.get("/api/snapshot").json()["tasks"][0]["outcome"]
                assert outcome["key"] == "verified"
            with state.transaction() as db:
                assert tuple(
                    db.execute(
                        "SELECT revision,dispatches,observations FROM operations WHERE task=?",
                        (task,),
                    ).fetchone()
                ) == (revision, 1, 2)
    finally:
        if engine(
            "container", "ls", "-aq", "--filter", f"label={label}", "--filter", f"id={target}"
        ):
            engine("container", "rm", "-f", target)
