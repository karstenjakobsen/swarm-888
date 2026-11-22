from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from swarm.application import Application
from swarm.catalog import Catalog
from swarm.state import State

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture(autouse=True)
def isolate_installation_config(monkeypatch, request):
    for key in (
        "SWARM_NOTIFY_URL",
        "SWARM_INGRESS_CONFIG",
        "SWARM_NOTIFY_DIR",
        "SWARM_CATALOG",
        "SWARM_REMOTE",
        "SWARM_BRANCH",
        "SWARM_FIXTURE_FD",
        "SWARM_INSTRUCTIONS",
        "SWARM_PURPOSE",
    ):
        monkeypatch.delenv(key, raising=False)
    if request.node.get_closest_marker("live") is None:
        monkeypatch.delenv("SWARM_CODEX_AUTH", raising=False)


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now

    def advance(self, seconds=10):
        self.now += seconds


class NoRuntime:
    def __init__(self):
        self.calls = 0

    async def run(self, app, task):
        self.calls += 1
        raise AssertionError("Unexpected model call")

    async def interrupt(self):
        pass

    async def steer(self, text):
        pass


class AuthorRuntime(NoRuntime):
    """Deterministic agent transcript, using only the public model tool contracts."""

    def __init__(self):
        super().__init__()
        self.trace = []

    async def run(self, app, task):
        self.calls += 1
        tools = app.tools(task["id"])

        def call(key, **args):
            self.trace.append(key)
            return tools.call(key, args)

        if task["kind"] in ("maintain", "publish"):
            package = call(
                "skill_template", kind="permissions" if task["kind"] == "maintain" else "publishing"
            )
            rev = call("skill_stage", package=package)["revision"]
            assert call("skill_test", revision=rev)["passed"]
            call("skill_activate", revision=rev)
            return "completed"
        goal = task["goal"]
        fixture = goal.split("\n", 1)[1]
        found = call("skill_search", query="failed-services")["skills"]
        if not found or goal.startswith("Correct"):
            call("skill_read", name="skill-author")
            package = call("skill_template")
            package.update(
                name="failed-services",
                instructions="Summarize service names with a failed state.",
                sql="SELECT json_object('failed',json_group_array(substr(line,1,instr(line,' ')-1))) FROM lines WHERE substr(line,instr(line,' ')+1)='failed'",
                tests=[
                    {
                        "input": {"text": "sample.service failed"},
                        "expected": {"failed": ["sample.service"]},
                    }
                ],
            )
            if found:
                package["sql"] = package["sql"].replace(
                    "substr(line,instr(line,' ')+1)", "lower(substr(line,instr(line,' ')+1))"
                )
                package["tests"] = [
                    {
                        "input": {"text": "unit.service FAILED"},
                        "expected": {"failed": ["unit.service"]},
                    }
                ]
            rev = call("skill_stage", package=package)["revision"]
            assert call("skill_test", revision=rev)["passed"]
            call("skill_activate", revision=rev)
        call("skill_run", name="failed-services", arguments={"text": fixture})
        return "completed"


@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
def app(tmp_path, clock):
    s = State(tmp_path / "state", clock)
    return Application(s, Catalog(s), AuthorRuntime())


@pytest.fixture
def run():
    return asyncio.run
