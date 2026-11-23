import json
from pathlib import Path
from uuid import uuid4

import pytest
from test_message import controller, login
from test_skills import bootstrap

from operator_v1.backup import export, restore
from operator_v1.catalog import Catalog
from operator_v1.catalog_migration import CatalogMigration
from operator_v1.config import Settings
from operator_v1.skill_program import SkillDefinition
from operator_v1.skills import Skills
from operator_v1.state import State
from operator_v1.typed_catalogs import TypedCatalogs


def legacy_fixture(directory: Path) -> tuple[Settings, str, str]:
    directory.mkdir()
    settings, _ = bootstrap(directory)
    settings.create_owner_key()
    state = State(settings)
    task = state.submit(uuid4(), "Read the old fixture")
    state.claim()
    catalog = Catalog.load(settings)
    skills = Skills(catalog, state, task)
    definition = SkillDefinition.model_validate(
        {
            "name": "Legacy fixture",
            "purpose": "Read the old fixture",
            "procedure": ["Return the test observation."],
            "program": {
                "source": "executable",
                "entrypoint": "run.lua",
                "input_schema": {"type": "object"},
            },
            "tests": [{"name": "fixture", "arguments": {}, "expected": "retained"}],
        }
    )
    draft = skills.scaffold("legacy-fixture", definition, 'return function() return "retained" end')
    skills.test(**draft)
    skills.activate(**draft)
    skills.invoke("legacy-fixture", {})
    state.finish(task, "retained", "Observed the fixture", modeled=True)
    (catalog.checkout / "projects" / "legacy-api.json").write_text(
        json.dumps(
            {
                "name": "Legacy API",
                "description": "Existing project",
                "repo": "https://example.invalid/api.git",
            }
        )
    )
    (catalog.checkout / "connectors" / "legacy-mcp.json").write_text(
        json.dumps(
            {
                "name": "Legacy MCP",
                "endpoint": "http://127.0.0.1:8765/mcp",
                "secret_ref": "legacy-mcp",
                "auth": "bearer",
                "tool": "read_fixture",
            }
        )
    )
    catalog.git("add", "-A")
    catalog.git("commit", "-m", "Add existing catalog entries")
    catalog.push()
    return settings, task, draft["revision"]


def test_migration_resumes_on_a_copy_and_preserves_task_and_revision(tmp_path, monkeypatch):
    original, task, pinned = legacy_fixture(tmp_path / "existing")
    backup = tmp_path / "existing.tar.gz"
    export(original, backup)
    copy = Settings(tmp_path / "copy")
    checkout = tmp_path / "migrated-checkout"
    restore(copy, backup, checkout)
    state = State(copy)
    catalog = Catalog.load(copy)
    migration = CatalogMigration(state)
    publisher = "karstenjakobsen"
    base = catalog.git("rev-parse", "HEAD").strip()
    plan = migration.migrate(publisher, apply=False)
    assert plan["base_revision"] == base
    assert {item["kind"] for item in plan["items"]} == {"skill", "connector", "project"}
    assert catalog.git("status", "--porcelain") == ""
    assert migration.receipt() is None

    def interrupt(_catalog, _receipt):
        raise InterruptedError("Interrupted after the migration commit")

    with monkeypatch.context() as patch:
        patch.setattr(migration, "finish", interrupt)
        with pytest.raises(InterruptedError):
            migration.migrate(publisher, apply=True)
    interrupted = catalog.git("rev-parse", "HEAD").strip()
    assert interrupted != base
    assert not TypedCatalogs(state).bindings()
    migration = CatalogMigration(State(copy))
    assert migration.migrate(publisher, apply=True)["revision"] == interrupted
    assert len(TypedCatalogs(state).bindings()) == 3
    assert migration.receipt()["completed"] == 1
    before = (copy.directory / "operator.sqlite3").read_bytes()
    assert migration.migrate(publisher, apply=True)["revision"] == interrupted
    assert (copy.directory / "operator.sqlite3").read_bytes() == before
    assert catalog.git("rev-parse", "HEAD").strip() == interrupted
    assert catalog.git("status", "--porcelain") == ""
    assert catalog.remote_revision() == base

    with controller(copy) as client:
        login(client, copy)
        snapshot = client.get("/api/snapshot").json()
        assert snapshot["tasks"][0]["id"] == task
        assert any(event["data"].get("revision") == pinned for event in snapshot["events"])
    invoked = Skills(None, state).invoke("legacy-fixture", {})
    assert invoked == {"skill": "legacy-fixture", "revision": pinned, "result": "retained"}
    assert Catalog.load(original).git("rev-parse", "HEAD").strip() == base

    migrated_backup = tmp_path / "migrated.tar.gz"
    export(copy, migrated_backup)
    restored = Settings(tmp_path / "restored")
    restore(restored, migrated_backup)
    restored_state = State(restored)
    restored_bindings = TypedCatalogs(restored_state).bindings()
    assert {binding.revision for _, binding in restored_bindings} == {interrupted}
    assert all(
        binding.catalog.checkout.is_relative_to(restored.directory)
        for _, binding in restored_bindings
    )
    assert len(TypedCatalogs(restored_state).status()) == 3
    assert Skills(None, restored_state).invoke("legacy-fixture", {}) == invoked
