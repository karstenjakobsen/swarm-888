import json

import pytest
from conftest import NoRuntime

from swarm.application import Application
from swarm.catalog import Catalog, FailedInvocation, Package


def checked_failure(catalog: Catalog):
    old = Package(
        name="failed-services",
        instructions="Return failed service names from SERVICE STATUS lines, ignoring case.",
        sql="SELECT json_object('failed',json_group_array(substr(line,1,instr(line,' ')-1))) FROM lines WHERE substr(line,instr(line,' ')+1)='failed'",
        tests=[
            {
                "input": {"text": "starter.service failed"},
                "expected": {"failed": ["starter.service"]},
            }
        ],
    )
    rev = catalog.stage("original-author", old)["revision"]
    assert catalog.test("original-author", rev)["passed"]
    catalog.activate("original-author", rev)
    assert catalog.run("original-author", old.name, {"text": "demo.service failed"})["result"] == {
        "failed": ["demo.service"]
    }
    args = {"text": "billing.service active\narchive.service FAILED"}
    result = catalog.run("failure-check", old.name, args)
    assert result["result"] == {"failed": []}
    assert not catalog.attest(
        result["call"],
        {"failed": ["archive.service"]},
        "Independent grader parsed uppercase status",
    )["passed"]
    return old, result


def checked_helper_failure(catalog: Catalog):
    old = Package(
        name="service-port",
        instructions="Return the supplied integer port. When it is omitted, return port 80.",
        sql="SELECT json_object('port',coalesce(json_extract(:input,'$.port'),json('missing')))",
        tests=[{"input": {"port": 443}, "expected": {"port": 443}}],
    )
    rev = catalog.stage("port-author", old)["revision"]
    assert catalog.test("port-author", rev)["passed"]
    catalog.activate("port-author", rev)
    assert catalog.run("port-author", old.name, {"port": 8080})["result"] == {"port": 8080}
    with pytest.raises(FailedInvocation) as exc:
        catalog.run("port-check", old.name, {"service": "orders"})
    call = exc.value.call
    assert catalog.attest(call, {"port": 80}, "Independent check of the default port") == {
        "passed": False,
        "verified_reuse": False,
    }
    return old, {"call": call, "revision": rev}


def test_failed_helper_can_be_reproduced_and_corrected_after_restart(app, run):
    old, failure = checked_helper_failure(app.catalog)
    app.state.secret("fixture-token", "fixture-port-secret")
    with pytest.raises(FailedInvocation) as exc:
        app.catalog.run("redaction-check", old.name, {"service": "fixture-port-secret"})
    assert app.catalog.evidence(exc.value.call)["arguments"] == {"service": "[redacted]"}
    source = app.catalog.evidence(failure["call"])
    assert source["actual"] is None and source["failure"]["exit_status"] == 1
    task = app.submit("/learn " + failure["call"])

    class FixPort(NoRuntime):
        async def run(self, fresh, row):
            tools = fresh.tools(row["id"])
            record = tools.call("skill_evidence", {"call": failure["call"]})
            assert record == source
            fixed = old.model_dump()
            fixed["sql"] = fixed["sql"].replace("json('missing')", "80")
            fixed["tests"] = [{"input": {}, "expected": {"port": 80}}]
            rev = tools.call("skill_stage", {"package": fixed})["revision"]
            assert tools.call("skill_test", {"revision": rev})["passed"]
            tools.call("skill_activate", {"revision": rev})
            return "completed"

    fresh = Application(app.state, Catalog(app.state), FixPort())
    fresh.recover()
    run(fresh.step())
    assert fresh.task_summary(task)["status"] == "verified"
    events = {e["kind"]: e["data"] for e in fresh.state.events() if e["task"] == task}
    assert events["learning.reproduced"]["failure"] == source["failure"]
    assert events["learning.result"]["result"] == {"port": 80}
    assert events["learning.result"]["revision"] != failure["revision"]
    assert fresh.catalog.evidence(failure["call"]) == source


def test_revision_requires_a_regression_and_passes_private_input(app, run):
    old, failure = checked_failure(app.catalog)
    task = app.submit("/learn " + failure["call"])
    app.state.change("UPDATE tasks SET status='running' WHERE id=?", task)
    tools = app.tools(task)
    with pytest.raises(ValueError, match="outside"):
        tools.call("catalog_sync", {})
    evidence = tools.call("skill_evidence", {"call": failure["call"]})
    assert evidence["actual"] == {"failed": []} and not evidence["check"]["passed"]
    fixed = old.model_dump()
    fixed["sql"] = fixed["sql"].replace(
        "WHERE substr(line,instr(line,' ')+1)", "WHERE lower(substr(line,instr(line,' ')+1))"
    )

    def stage():
        rev = tools.call("skill_stage", {"package": fixed})["revision"]
        assert tools.call("skill_test", {"revision": rev})["passed"]
        return rev

    rev = stage()
    with pytest.raises(ValueError, match="regression case"):
        tools.call("skill_activate", {"revision": rev})
    fixed["tests"].append({"input": {"text": "a FAILED"}, "expected": {"failed": ["a"]}})
    rev = stage()
    assert tools.call("skill_activate", {"revision": rev})["revision"] == rev
    app.recover()
    run(app.step())
    assert app.task_summary(task)["status"] == "verified" and app.runtime.calls == 0
    assert app.catalog.evidence(failure["call"]) == evidence
    assert (
        json.loads(
            app.state.one("SELECT data FROM events WHERE task=? AND kind='learning.result'", task)[
                "data"
            ]
        )["result"]
        == evidence["check"]["expected"]
    )


def test_improvement_deadline_survives_restart(app, clock, run):
    _, failure = checked_failure(app.catalog)
    task = app.submit("/learn " + failure["call"])
    app.state.change("UPDATE tasks SET status='running' WHERE id=?", task)
    app.recover()
    clock.advance(301)
    run(app.step())
    assert app.task_summary(task)["status"] == "failed"
    assert app.runtime.calls == 0 and app.catalog.active("failed-services") == failure["revision"]


def test_historical_call_recovers_only_matching_recorded_arguments(app):
    _, failure = checked_failure(app.catalog)
    call = failure["call"]
    original = app.catalog.evidence(call)
    app.state.change("DELETE FROM call_inputs WHERE call=?", call)
    assert app.catalog.evidence(call)["arguments"] is None
    for arguments in (original["arguments"], {"text": "a different invocation"}):
        app.state.event(
            "failure-check",
            "tool.started",
            {"tool": "skill_run", "arguments": {"name": "failed-services", "arguments": arguments}},
        )
    assert app.catalog.evidence(call) == original
