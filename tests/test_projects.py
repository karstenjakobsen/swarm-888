import json
import subprocess

import pytest

from swarm.application import Application
from swarm.backup import export_state, restore_state
from swarm.catalog import Catalog
from swarm.state import State


class ProjectAuthor:
    async def run(self, app, task):
        tools = app.tools(task["id"])
        base = tools.call("project_status", {})["commit"]
        if not base:
            tools.call(
                "project_save",
                {
                    "base": "",
                    "files": {
                        "data/status.json": '{"status":"ok"}',
                        "README.md": "Read data/status.json.",
                    },
                    "message": "Add the status document and instructions",
                },
            )
        assert json.loads(tools.call("project_read", {"path": "data/status.json"})["text"]) == {
            "status": "ok"
        }
        return "completed"


def test_author_project_from_conversation_and_restore(app, tmp_path, run):
    app.runtime = ProjectAuthor()
    task = app.submit("Create a project named heartbeat containing a status document")
    run(app.step())
    tools = app.tools(task)
    current = tools.project_status()
    assert current["files"] == ["README.md", "data/status.json"]
    ref = json.loads((app.catalog.path / "projects/heartbeat.json").read_text())
    checkout = tmp_path / "working-copy"
    subprocess.run(
        ["git", "clone", "-q", str(app.state.path / ref["repository"]), str(checkout)], check=True
    )
    assert json.loads((checkout / "data/status.json").read_text()) == {"status": "ok"}
    edit = app.submit("Update the project heartbeat with new documentation")
    app.state.change("UPDATE tasks SET status='running' WHERE id=?", edit)
    tools = app.tools(edit)
    changed = tools.project_save(
        current["commit"], {"README.md": "Updated instructions"}, "Improve documentation"
    )
    with pytest.raises(ValueError, match="changed"):
        tools.project_save(current["commit"], {"README.md": "Overwrite"}, "Stale edit")
    with pytest.raises(ValueError, match="relative"):
        tools.project_save(changed["commit"], {"../outside": "no"}, "Invalid path")
    with pytest.raises(ValueError, match="project task"):
        app.tools(app.submit("Summarize this log")).project_save("", {"a": "x"}, "Unrelated edit")
    backup = tmp_path / "backup.zip"
    export_state(app.state.path, backup)
    restored_path = tmp_path / "restored"
    restore_state(backup, restored_path)
    state = State(restored_path)
    restored = Application(state, Catalog(state), ProjectAuthor())
    assert restored.tools(task).project_read("README.md") == {
        "commit": changed["commit"],
        "path": "README.md",
        "text": "Updated instructions",
    }


def test_project_commit_recovers_after_git_branch_advances(app, run, monkeypatch):
    task = app.submit("/project heartbeat create a status document")
    app.state.change("UPDATE tasks SET status='running' WHERE id=?", task)
    define = app.catalog.define

    def lose_reply(*args):
        raise OSError("Worker killed after the branch advanced")

    monkeypatch.setattr(app.catalog, "define", lose_reply)
    with pytest.raises(OSError):
        app.tools(task).project_save("", {"data/status.json": '{"status":"ok"}'}, "First version")
    frozen = app.tools(task).project_status()["commit"]
    monkeypatch.setattr(app.catalog, "define", define)
    fresh = Application(app.state, app.catalog, ProjectAuthor())
    fresh.recover()
    run(fresh.step())
    op = fresh.state.one("SELECT * FROM operations WHERE task=?", task)
    assert op["status"] == "verified" and json.loads(op["evidence"])["commit"] == frozen
    assert fresh.tools(task).project_status()["commit"] == frozen
    checkpoint = json.loads(
        fresh.state.one("SELECT checkpoint FROM tasks WHERE id=?", task)["checkpoint"]
    )
    assert checkpoint["outstanding"] == []
