import asyncio
import os
import stat

import pytest
from conftest import NoRuntime

from swarm.application import Application
from swarm.catalog import Catalog


def bind(app, run):
    file = app.state.path / "fixtures" / "demo"
    file.write_text("fixture")
    file.chmod(0o600)
    task = app.submit("/maintain demo 600 fixture-permissions 1")
    run(app.step())
    assert app.runtime.calls == 1
    return file, app.state.one("SELECT * FROM goals WHERE authority=?", task)


def test_standing_goal_restart_healthy_drift_pause(app, run, clock):
    path, goal = bind(app, run)
    fresh = Application(app.state, Catalog(app.state), NoRuntime())
    fresh.recover()
    clock.advance()
    run(fresh.step())
    assert fresh.maintenance.summaries() == []
    path.chmod(0o644)
    clock.advance()
    run(fresh.step())
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    inc = fresh.maintenance.summaries()[0]
    assert (
        inc["repairs"] == 1 and inc["status"] == "resolved" and inc["evidence"]["observed"] == "600"
    )
    assert fresh.state.one("SELECT * FROM operations WHERE task=?", inc["id"])["rev"] == goal["rev"]
    fresh.submit("/pause " + goal["id"])
    run(fresh.step())
    path.chmod(0o644)
    clock.advance()
    run(fresh.step())
    assert stat.S_IMODE(path.stat().st_mode) == 0o644
    fresh.submit("/resume " + goal["id"])
    run(fresh.step())
    run(fresh.step())
    assert stat.S_IMODE(path.stat().st_mode) == 0o600 and fresh.runtime.calls == 0


def test_budget_across_restart_and_followup(app, run, clock, monkeypatch):
    path, goal = bind(app, run)
    path.chmod(0o644)
    monkeypatch.setattr(os, "fchmod", lambda *_: None)
    run(app.step())
    inc = app.maintenance.summaries()[0]
    assert inc["status"] == "open" and inc["repairs"] == 1

    class IncidentRuntime(NoRuntime):
        async def run(self, app, task):
            self.calls += 1
            tools = app.tools(task["id"])
            if task["kind"] == "diagnose":
                tools.call("skill_read", {"name": goal["skill"]})
            else:
                package = dict(app.catalog.revision(goal["rev"])["spec"])
                package["instructions"] += " Verify the observed result after a lost repair reply."
                candidate = tools.call("skill_stage", {"package": package})["revision"]
                assert tools.call("skill_test", {"revision": candidate})["passed"]
                tools.call("skill_activate", {"revision": candidate})
            return "completed"

    fresh = Application(app.state, Catalog(app.state), IncidentRuntime())
    for command in ("/diagnose " + inc["id"], "/improve " + inc["id"]):
        key = fresh.submit(command)
        run(fresh.step())
        assert fresh.state.one("SELECT status FROM tasks WHERE id=?", key)["status"] in {
            "answered",
            "failed",
        }
    assert fresh.runtime.calls == 2
    stages = fresh.state.rows("SELECT rev FROM revisions WHERE author=?", key)
    assert len(stages) == 1 and stages[0]["rev"] != goal["rev"]
    for _ in range(20):
        clock.advance(6)
        run(fresh.step())
    final = fresh.maintenance.summaries()[0]
    assert final["attempts"] == fresh.maintenance.limit
    assert final["status"] == "unresolved"
    assert len(fresh.state.rows("SELECT * FROM alerts")) == 1
    assert len(list((fresh.state.path / "notifications").glob("*.json"))) == 1
    repairs = final["repairs"]
    clock.advance(200)
    run(fresh.step())
    assert fresh.maintenance.summaries()[0]["repairs"] == repairs


def test_host_crash_after_chmod(app, run, clock, monkeypatch):
    path, _ = bind(app, run)
    path.chmod(0o644)
    actual = os.fchmod
    counter = []

    class Crash(BaseException):
        pass

    def lost(fd, mode):
        actual(fd, mode)
        counter.append(mode)
        raise Crash

    monkeypatch.setattr(os, "fchmod", lost)
    with pytest.raises(Crash):
        run(app.step())
    fresh = Application(app.state, Catalog(app.state), NoRuntime())
    clock.advance()
    run(fresh.step())
    assert counter == [0o600]
    assert fresh.state.one("SELECT * FROM operations")["status"] == "verified"
    assert fresh.maintenance.summaries()[0]["status"] == "resolved"


def test_unknown_elapsed_and_hardlink(app, clock, run):
    path, _ = bind(app, run)
    os.link(path, path.with_suffix(".link"))
    run(app.step())
    inc = app.maintenance.summaries()[0]
    assert inc["evidence"]["status"] == "unknown" and inc["repairs"] == 0
    clock.advance(181)
    run(app.step())
    assert app.maintenance.summaries()[0]["status"] == "unresolved"


def test_serialized_tasks(app):
    async def scenario():
        started, release = asyncio.Event(), asyncio.Event()
        order = []

        class Waiting(NoRuntime):
            async def run(self, app, task):
                order.append(task["id"])
                started.set()
                await release.wait()
                return "completed"

        app.runtime = Waiting()
        a, b = app.submit("first"), app.submit("second")
        first = asyncio.create_task(app.step())
        await started.wait()
        second = asyncio.create_task(app.step())
        await asyncio.sleep(0.02)
        assert order == [a]
        release.set()
        await asyncio.gather(first, second)
        assert order == [a, b]

    asyncio.run(scenario())
