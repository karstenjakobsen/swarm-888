import asyncio
import json
from uuid import uuid4

import pytest
from fixture_typed_catalog import PUBLISHER, REPO, typed_remote
from test_message import controller, headers, login

from operator_v1.catalog import CatalogError, run_git
from operator_v1.catalog_publish import CatalogPublishing
from operator_v1.config import Settings
from operator_v1.contracts import CatalogPublishTips
from operator_v1.model import connect_skills
from operator_v1.state import State
from operator_v1.typed_catalogs import TypedCatalogs
from operator_v1.worker import MessageWorker


def test_fresh_owner_connects_three_kinds_at_once(tmp_path, monkeypatch):
    settings = Settings(tmp_path / "state")
    settings.create_owner_key()
    remote, revision = typed_remote(tmp_path / "fixture")
    monkeypatch.setenv("GIT_CONFIG_COUNT", "1")
    monkeypatch.setenv("GIT_CONFIG_KEY_0", f"url.{remote}.insteadOf")
    monkeypatch.setenv("GIT_CONFIG_VALUE_0", REPO)

    async def guides():
        async with connect_skills(settings, None) as mcp:
            discovered = await mcp.call_tool("skill_discover", {})
            assert {item["skill"] for item in discovered.structuredContent["skills"]} == {
                "create-skill",
                "connect-catalog",
            }
            authoring = await mcp.call_tool("skill_authoring_guide", {})
            assert "/seed/" in authoring.structuredContent["path"]
            setup = await mcp.call_tool("catalog_connection_guide", {})
            assert "Inspect" in setup.structuredContent["guide"]

    asyncio.run(guides())
    payload = {"remote": REPO, "kinds": ["skill", "connector", "project"]}
    with controller(settings) as client:
        assert (
            client.post("/api/catalog", json=payload, headers=headers(settings)).status_code == 401
        )
        login(client, settings)
        status = client.get("/api/catalog").json()
        assert status["connections"] == []
        assert [item["skill"] for item in status["builtins"]] == ["create-skill", "connect-catalog"]
        assert client.post("/api/catalog", json=payload).status_code == 403
        for _ in range(2):
            reply = client.post("/api/catalog", json=payload, headers=headers(settings))
            assert reply.status_code == 200, reply.text
            connections = reply.json()["connections"]
            assert {item["kind"] for item in connections} == {"skill", "connector", "project"}
            assert len({item["branch_id"] for item in connections}) == 1
            assert {item["revision"] for item in connections} == {revision}
            assert all(len(item["items"]) == 1 for item in connections)
        assert client.get("/api/snapshot").json()["catalog"]["branch"] == "main"
    assert len(list((settings.directory / "typed-catalogs").iterdir())) == 1
    assert len(list(settings.directory.glob("catalog-*.lock"))) == 1
    assert run_git("rev-parse", "main", cwd=remote).stdout.strip() == revision


def test_different_repositories_and_explicit_switch(tmp_path):
    first, _ = typed_remote(tmp_path / "first")
    second, _ = typed_remote(tmp_path / "second")
    catalogs = TypedCatalogs(State(Settings(tmp_path / "state")))
    catalogs.connect(str(first), "main", ["skill"], publisher=PUBLISHER)
    catalogs.connect(str(second), "main", ["project"], publisher=PUBLISHER)
    with pytest.raises(CatalogError, match="Confirm a catalog switch for skill"):
        catalogs.connect(str(second), "main", ["skill", "connector"], publisher=PUBLISHER)
    assert {kind for kind, _ in catalogs.bindings()} == {"skill", "project"}
    catalogs.connect(str(second), "main", ["skill", "connector"], publisher=PUBLISHER, replace=True)
    bindings = catalogs.bindings()
    assert len(bindings) == 3
    assert {binding.catalog.config.remote for _, binding in bindings} == {str(second)}
    _, item, revision = catalogs.write_item(
        "project",
        "karstenjakobsen-project-kj-api",
        {
            "name": "KJ API",
            "description": "Updated project",
            "repo": "https://example.invalid/api-v2.git",
        },
    )
    project = catalogs.for_kind("project")
    assert project.revision == revision
    assert item.path == "kj-api/operator.yaml"
    assert project.item("project", item.manifest.canonical_id).manifest.repo.endswith("api-v2.git")


def test_task_authors_and_invokes_exact_revision_after_pull(tmp_path, monkeypatch):
    settings = Settings(tmp_path / "state")
    remote, _ = typed_remote(tmp_path / "fixture")
    state = State(settings)
    catalogs = TypedCatalogs(state)
    binding = catalogs.connect(
        str(remote), "main", ["skill", "connector", "project"], publisher=PUBLISHER
    )
    catalog = binding.catalog
    branch_id = catalog.branch_id
    fixture = tmp_path / "authoring.json"
    fixture.write_text(
        json.dumps(
            {
                "query": "fixture lookup",
                "skill": "fixture-lookup",
                "input": "selector",
                "entrypoint": 'return function(args) return "old:" .. args.selector end',
                "definition": {
                    "name": "Fixture lookup",
                    "purpose": "Fixture lookup by selector",
                    "procedure": ["Read the fixture selector."],
                    "program": {
                        "source": "executable",
                        "entrypoint": "run.lua",
                        "dependencies": [],
                        "input_schema": {
                            "type": "object",
                            "properties": {"selector": {"type": "string"}},
                            "required": ["selector"],
                        },
                    },
                    "tests": [
                        {
                            "name": "fixture",
                            "arguments": {"selector": "swarm.test=a"},
                            "expected": "old:swarm.test=a",
                        }
                    ],
                },
            }
        )
    )
    monkeypatch.setenv("OPERATOR_MODEL", "simulated")
    monkeypatch.setenv("OPERATOR_SIMULATED_SKILL", str(fixture))
    worker = MessageWorker(settings)
    skill = f"{PUBLISHER}-skill-fixture-lookup"
    creating = state.submit(uuid4(), "Look up fixture `swarm.test=a`")
    worker.drain()
    active = state.active_skill_revision(skill)
    assert active == catalog.git("rev-parse", "HEAD").strip()
    assert catalogs.for_kind("skill").item("skill", skill).path == "fixture-lookup/operator.yaml"
    connector = catalogs.for_kind("connector").item(
        "connector", f"{PUBLISHER}-connector-digital-ocean"
    )
    fields = connector.manifest.model_dump(exclude={"schema_version", "kind", "canonical_id"})
    fields["name"] = "Updated connector fixture"
    _, _, connector_revision = catalogs.write_item(
        "connector", connector.manifest.canonical_id, fields
    )
    publishing = CatalogPublishing(state)
    preview = publishing.preview(branch_id)
    assert [commit.revision for commit in preview.commits] == [active, connector_revision]
    assert {item.kind for item in preview.items} == {"skill", "connector"}
    publishing.publish(
        branch_id,
        CatalogPublishTips(
            local_revision=preview.local_revision,
            remote_revision=preview.remote_revision,
        ),
    )
    assert run_git("rev-parse", "main", cwd=remote).stdout.strip() == connector_revision
    assert catalogs.for_branch(branch_id).published_revision == connector_revision
    collaborator = tmp_path / "collaborator"
    run_git("clone", str(remote), str(collaborator))
    code = collaborator / "fixture-lookup" / "run.lua"
    code.write_text('return function(args) return "new:" .. args.selector end\n')
    run_git("commit", "-am", "Change implementation only", cwd=collaborator)
    run_git("push", "origin", "main", cwd=collaborator)
    catalogs.pull(branch_id)
    assert catalogs.for_kind("skill").revision != active

    reuse = state.submit(uuid4(), "Look up fixture `swarm.test=b`")
    worker.drain()
    with state.transaction() as db:
        rows = db.execute(
            "SELECT task,skill,revision,result FROM skill_calls ORDER BY id"
        ).fetchall()
    assert [tuple(row) for row in rows] == [
        (creating, skill, active, json.dumps("old:swarm.test=a")),
        (reuse, skill, active, json.dumps("old:swarm.test=b")),
    ]
    assert state.active_skill_revision(skill) == active

    accepted = catalogs.for_kind("skill").revision
    project = collaborator / "kj-api" / "operator.yaml"
    project.write_text(project.read_text().replace(f"{PUBLISHER}-project-kj-api", skill))
    run_git("commit", "-am", "Introduce a duplicate canonical ID", cwd=collaborator)
    run_git("push", "origin", "main", cwd=collaborator)
    with pytest.raises(CatalogError, match="Duplicate canonical ID"):
        catalogs.pull(branch_id)
    assert catalogs.for_kind("skill").revision == accepted
    assert catalog.git("rev-parse", "HEAD").strip() == accepted
    assert state.active_skill_revision(skill) == active


def test_skills_only_preview_includes_unconnected_and_asset_only_paths(tmp_path):
    remote, base = typed_remote(tmp_path / "fixture")
    state = State(Settings(tmp_path / "state"))
    binding = TypedCatalogs(state).connect(str(remote), "main", ["skill"], publisher=PUBLISHER)
    catalog = binding.catalog
    source = catalog.checkout
    (source / "check-disk/run.lua").write_text('return function() return "changed" end\n')
    connector = source / "digital-ocean/operator.yaml"
    connector.write_text(connector.read_text().replace("DigitalOcean fixture", "Updated fixture"))
    (source / "other.txt").write_text("Also part of the push.\n")
    catalog.git("add", "-A")
    catalog.git("commit", "-m", "Change skill asset, connector and unrelated file")
    publishing = CatalogPublishing(state)
    preview = publishing.preview(catalog.branch_id)
    assert preview.remote_revision == base
    assert preview.commits[0].paths == [
        "check-disk/run.lua",
        "digital-ocean/operator.yaml",
        "other.txt",
    ]
    assert {item.kind: item.paths for item in preview.items} == {
        "skill": ["check-disk/run.lua"],
        "connector": ["digital-ocean/operator.yaml"],
    }
    (source / "another.txt").write_text("Changed since review.\n")
    catalog.git("add", "-A")
    catalog.git("commit", "-m", "Add another pending file")
    with pytest.raises(CatalogError, match="fresh publish preview"):
        publishing.publish(
            catalog.branch_id,
            CatalogPublishTips(
                local_revision=preview.local_revision,
                remote_revision=preview.remote_revision,
            ),
        )
    assert run_git("rev-parse", "main", cwd=remote).stdout.strip() == base
    updated = publishing.preview(catalog.branch_id)
    collaborator = tmp_path / "remote-writer"
    run_git("clone", str(remote), str(collaborator))
    run_git("commit", "--allow-empty", "-m", "Advance the remote branch", cwd=collaborator)
    run_git("push", "origin", "main", cwd=collaborator)
    with pytest.raises(CatalogError, match="fresh publish preview"):
        publishing.publish(
            catalog.branch_id,
            CatalogPublishTips(
                local_revision=updated.local_revision,
                remote_revision=updated.remote_revision,
            ),
        )
    assert catalog.git("rev-parse", "HEAD").strip() == updated.local_revision
