import json
import subprocess
from concurrent.futures import ThreadPoolExecutor
from threading import Event

import pytest
from conftest import FIXTURES, AuthorRuntime

from swarm.application import Application
from swarm.backup import export_state, restore_state
from swarm.catalog import Catalog, Package
from swarm.state import State


def task_result(app, run, goal):
    task = app.submit(goal)
    run(app.step())
    assert app.state.one("SELECT status FROM tasks WHERE id=?", task)["status"] == "answered"
    call = app.state.one("SELECT * FROM calls WHERE task=?", task)
    return task, call, json.loads(call["result"])


def test_author_restart_reuse_and_sourced_log(app, run):
    assert [x["name"] for x in app.catalog.search()] == ["skill-author"]
    original, first, answer = task_result(
        app,
        run,
        "Build a reusable failed-service summary.\n" + (FIXTURES / "first.log").read_text(),
    )
    assert answer == {"failed": ["orders.service", "mailer.service"]}
    assert app.catalog.attest(first["id"], answer, "Independent fixture oracle") == {
        "passed": True,
        "verified_reuse": False,
    }
    app.catalog.attest(first["id"], answer, "Repeated independent check")
    verified = [
        e
        for e in app.state.events(task=original)
        if e["kind"] == "run.status" and e["data"]["status"] == "verified"
    ]
    assert len(verified) == 1 and verified[0]["id"] <= app.task_summary(original)["event_cursor"]
    origin = app.catalog.revision(first["rev"])["origin"]
    assert app.catalog.git("show", origin + ":skills/failed-services/package.json")
    assert app.runtime.trace[-4:] == ["skill_stage", "skill_test", "skill_activate", "skill_run"]
    runtime = AuthorRuntime()
    fresh = Application(app.state, Catalog(app.state), runtime)
    later, second, answer = task_result(
        fresh, run, "Summarize this supplied log.\n" + (FIXTURES / "held-out.log").read_text()
    )
    assert later != original and second["rev"] == first["rev"]
    assert runtime.trace == ["skill_search", "skill_run"]
    expected = {"failed": ["queue.service", "reports.service"]}
    assert answer == expected
    assert fresh.catalog.attest(second["id"], expected, "Checked held-out source lines")[
        "verified_reuse"
    ]
    assert sum(r["verified_reuse"] for r in fresh.skill_view("failed-services")["calls"]) == 1
    assert fresh.summary()["goals"] == []
    assert not list((fresh.state.path / "secrets").iterdir())
    assert not list((fresh.state.path / "workspaces").iterdir())
    assert any(
        "unrelated-action" in str(e["data"]) for e in fresh.state.events() if e["task"] == later
    )


def test_check_applies_to_the_current_runs_answer(app, run):
    task, first, answer = task_result(app, run, "Build summary.\norders.service failed")
    # Earlier checkpoints stored the call ID without its run.
    app.state.change(
        "UPDATE tasks SET checkpoint=json_remove(checkpoint,'$.last_verified.run') WHERE id=?", task
    )
    app.catalog.attest(first["id"], answer, "Match")
    assert app.task_summary(task)["status"] == "verified"
    app.catalog.attest(first["id"], {"failed": []}, "Corrected independent expectation")
    assert app.task_summary(task)["status"] == "answered"
    run(app.follow(task, "Check the next observation"))

    class ReplyRuntime(AuthorRuntime):
        async def run(self, app, task):
            return "completed"

    app.runtime = ReplyRuntime()
    run(app.step())
    app.catalog.attest(first["id"], answer, "Recheck earlier result")
    assert app.task_summary(task)["status"] == "answered"


def test_check_received_before_turn_completion_is_applied(app, run):
    class GradedRuntime(AuthorRuntime):
        async def run(self, app, task):
            result = await super().run(app, task)
            call = app.state.one("SELECT id FROM calls WHERE task=?", task["id"])
            app.catalog.attest(call["id"], {"failed": ["orders.service"]}, "Graded while running")
            assert app.task_summary(task["id"])["status"] == "running"
            return result

    app.runtime = GradedRuntime()
    task = app.submit("Build summary.\norders.service failed")
    run(app.step())
    assert app.task_summary(task)["status"] == "verified"


@pytest.mark.parametrize(
    "schema",
    [
        {"type": "object", "properties": []},
        {"type": "object", "properties": {"nested": 7}},
        {"type": "object", "required": 7},
        {"type": ["object"]},
    ],
)
def test_invalid_schema_rejected_before_staging(app, schema):
    task = app.submit("Create a skill")
    app.state.change("UPDATE tasks SET status='running' WHERE id=?", task)
    tools = app.tools(task)
    package = tools.skill_template()
    package["input_schema"] = schema
    head = app.catalog.git("rev-parse", "HEAD")
    with pytest.raises(ValueError):
        tools.call("skill_stage", {"package": package})
    assert app.catalog.git("rev-parse", "HEAD") == head
    assert [s["name"] for s in app.catalog.search()] == ["skill-author"]


def test_regression_old_and_new_cases(app, run):
    task_result(app, run, "Build skill.\n" + (FIXTURES / "first.log").read_text())
    _, bad, _ = task_result(app, run, "Summarize.\n" + (FIXTURES / "regression.log").read_text())
    assert not app.catalog.attest(
        bad["id"], {"failed": ["archive.service"]}, "Uppercase status missed"
    )["passed"]
    _, fixed, result = task_result(
        app, run, "Correct uppercase regression.\n" + (FIXTURES / "regression.log").read_text()
    )
    assert fixed["rev"] != bad["rev"]
    assert result == {"failed": ["archive.service"]}
    evidence = app.catalog.revision(fixed["rev"])["tests"]
    assert len(evidence) == 2 and all(r["actual"] == r["expected"] for r in evidence)
    assert (
        json.loads(app.state.one("SELECT checked FROM calls WHERE id=?", bad["id"])["checked"])[
            "passed"
        ]
        is False
    )


def test_git_backup_restore(app, tmp_path, run):
    remote = tmp_path / "origin.git"
    subprocess.run(["git", "init", "--bare", "-b", "main", remote], check=True, capture_output=True)
    app.catalog.remote = str(remote)
    app.catalog.git("remote", "add", "origin", str(remote))
    task, call, _ = task_result(app, run, "Create report.\n" + (FIXTURES / "first.log").read_text())
    app.tools(task).memory_write("orders", "deploy on Tuesday")
    app.catalog.sync()
    second = State(tmp_path / "other")
    cat = Catalog(second, remote=str(remote))
    assert cat.git("rev-parse", "HEAD") == app.catalog.git("rev-parse", "HEAD")
    cat.define("projects", "orders", {"repository": "https://example.org/orders.git"})
    cat.sync()
    app.catalog.sync()
    assert (app.catalog.path / "projects/orders.json").exists()
    app.catalog.define("projects", "orders", {"repository": "one"})
    cat.define("projects", "orders", {"repository": "two"})
    cat.sync()
    with pytest.raises(ValueError):
        app.catalog.sync()
    assert (
        json.loads((app.catalog.path / "projects/orders.json").read_text())["repository"] == "one"
    )
    app.state.secret("digitalocean", "test-token-value")
    backup = tmp_path / "backup.zip"
    export_state(app.state.path, backup)
    restore_state(backup, tmp_path / "restored")
    restored = State(tmp_path / "restored")
    fresh = Application(restored, Catalog(restored), AuthorRuntime())
    assert fresh.summary()["installation"] == app.summary()["installation"]
    assert fresh.tools(task).memory_search("Tuesday")["entries"][0]["scope"] == "orders"
    assert (
        fresh.catalog.run(task, "failed-services", {"text": "new.service failed"})["revision"]
        == call["rev"]
    )
    assert not list((restored.path / "secrets").iterdir())


def test_backup_rejects_paths_overlapping_catalog(app, tmp_path, monkeypatch):
    catalog = tmp_path / "external-catalog"
    catalog.mkdir()
    monkeypatch.setenv("SWARM_CATALOG", str(catalog))
    archive = catalog / "backup.zip"
    with pytest.raises(ValueError, match="outside"):
        export_state(app.state.path, archive)
    assert not list(catalog.iterdir())
    monkeypatch.setenv("SWARM_CATALOG", str(tmp_path))
    with pytest.raises(ValueError, match="private state"):
        export_state(app.state.path, tmp_path / "backup.zip")


def test_inflight_pinning(app, monkeypatch):
    package = app.tools("author").skill_template()

    def install(text):
        package["sql"] = "SELECT json_object('version','" + text + "')"
        package["tests"] = [{"input": {}, "expected": {"version": text}}]
        # Choose different inputs for distinct test behavior; earlier checks are retained.
        if text == "B":
            package["sql"] = (
                "SELECT json_object('version',CASE WHEN json_extract(:input,'$.new') THEN 'B' ELSE 'A' END)"
            )
            package["tests"] = [{"input": {"new": True}, "expected": {"version": "B"}}]
        rev = app.catalog.stage("author", Package(**package))["revision"]
        assert app.catalog.test("author", rev)["passed"]
        app.catalog.activate("author", rev)
        return rev

    a = install("A")
    started, release = Event(), Event()
    evaluate = app.catalog.evaluate

    def delayed(rev, args):
        if args.get("hold"):
            started.set()
            assert release.wait(10)
        return evaluate(rev, args)

    monkeypatch.setattr(app.catalog, "evaluate", delayed)
    with ThreadPoolExecutor() as pool:
        first = pool.submit(app.catalog.run, "use", "count-lines", {"hold": True})
        assert started.wait(5)
        b = install("B")
        release.set()
        assert first.result()["revision"] == a
    assert app.catalog.run("use", "count-lines", {"new": True})["revision"] == b
    package["sql"] = "ATTACH '/etc/passwd' AS target"
    broken = app.catalog.stage("edit", Package(**package))["revision"]
    assert not app.catalog.test("edit", broken)["passed"]
    with pytest.raises(ValueError):
        app.catalog.activate("edit", broken)
    assert app.catalog.active("count-lines") == b
    app.catalog.rollback("owner", "count-lines", a)
    assert app.catalog.active("count-lines") == a


def test_activation_preserves_active_revision_if_tested_object_is_lost(app):
    spec = app.tools("author").skill_template()
    first = app.catalog.stage("author", Package(**spec))["revision"]
    assert app.catalog.test("author", first)["passed"]
    app.catalog.activate("author", first)
    spec["instructions"] += " Return the line count."
    second = app.catalog.stage("update", Package(**spec))["revision"]
    assert app.catalog.test("update", second)["passed"]
    (app.state.path / "objects" / second).unlink()
    with pytest.raises(ValueError, match="object is unavailable"):
        app.catalog.activate("update", second)
    assert app.catalog.run("use", "count-lines", {"text": "one"})["revision"] == first
    assert not app.state.rows("SELECT id FROM activations WHERE rev=?", second)
