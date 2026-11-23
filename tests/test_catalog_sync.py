import asyncio
import json
from pathlib import Path
from uuid import uuid4

import pytest
from fixture_inspection import inspection_request, write_policy
from mcp import ClientSession
from mcp.client.stdio import stdio_client
from test_message import controller, headers, login
from test_skills import ROOT, bootstrap

from operator_v1.catalog import Catalog, CatalogError, run_git
from operator_v1.config import Settings
from operator_v1.model import skill_server
from operator_v1.skill_program import SkillDefinition
from operator_v1.skills import Skills
from operator_v1.state import State


def test_owner_catalog_setup_and_explicit_publish(tmp_path, monkeypatch):
    seed_dir = tmp_path / "seeded"
    seed_dir.mkdir()
    _, env = bootstrap(seed_dir)
    remote = Path(env["OPERATOR_CATALOG_REMOTE"])
    revision = run_git("rev-parse", "main", cwd=remote).stdout.strip()
    url = "git@github.com:owner/catalog.git"
    monkeypatch.setenv("GIT_CONFIG_COUNT", "1")
    monkeypatch.setenv("GIT_CONFIG_KEY_0", f"url.{remote}.insteadOf")
    monkeypatch.setenv("GIT_CONFIG_VALUE_0", url)
    settings = Settings(tmp_path / "owner")
    settings.create_owner_key()
    with controller(settings) as client:
        body = {"remote": url}
        assert client.get("/api/catalog").status_code == 401
        assert client.post("/api/catalog", json=body, headers=headers(settings)).status_code == 401
        login(client, settings)
        assert client.post("/api/catalog", json=body).status_code == 403
        assert (
            client.post(
                "/api/catalog", json={"remote": "ext::command"}, headers=headers(settings)
            ).status_code
            == 422
        )
        first_key = client.post("/api/catalog/key", headers=headers(settings)).json()["public_key"]
        assert first_key.startswith("ssh-ed25519 ")
        assert (
            client.post("/api/catalog/key", headers=headers(settings)).json()["public_key"]
            == first_key
        )
        assert (settings.directory / "catalog-ssh" / "identity").stat().st_mode & 0o777 == 0o600
        for _ in range(2):
            response = client.post("/api/catalog", json=body, headers=headers(settings))
            assert response.status_code == 200, response.text
            status = response.json()
            assert status["authoring_revision"] == status["remote_revision"] == revision
            assert status["published_revision"] is None
        assert run_git("rev-parse", "main", cwd=remote).stdout.strip() == revision
        assert (
            client.post("/api/catalog/publish", headers=headers(settings)).json()[
                "published_revision"
            ]
            is None
        )

        state = State(settings)
        task = state.submit(uuid4(), "Create a permissions fixture skill")
        skills = Skills(Catalog.load(settings), state, task)
        candidate = skills.scaffold(
            "fixture-mode",
            SkillDefinition.model_validate(
                {
                    "name": "Fixture mode",
                    "purpose": "Maintain fixture permissions.",
                    "procedure": ["Apply the intended mode."],
                    "program": {"source": "file.mode"},
                    "tests": [
                        {
                            "name": "600",
                            "rows": [{"expectedMode": "600"}],
                            "expected": [{"mode": "600"}],
                        }
                    ],
                }
            ),
        )
        blocked = client.post("/api/catalog/publish", headers=headers(settings)).json()
        assert "Test and activate" in blocked["publish_error"]
        assert run_git("rev-parse", "main", cwd=remote).stdout.strip() == revision
        assert skills.test(**candidate)["passed"]
        skills.activate(**candidate)
        published = client.post("/api/catalog/publish", headers=headers(settings)).json()
        assert published["publish_error"] is None
        assert published["published_revision"] == candidate["revision"]
        assert run_git("rev-parse", "main", cwd=remote).stdout.strip() == candidate["revision"]


def test_seed_empty_main_and_retry_push(tmp_path, monkeypatch):
    remote = tmp_path / "remote.git"
    run_git("init", "--bare", "--initial-branch=main", str(remote))
    starter = tmp_path / "starter"
    run_git("clone", str(remote), str(starter))
    run_git("commit", "--allow-empty", "-m", "Initialize main", cwd=starter)
    run_git("push", "origin", "main", cwd=starter)
    initial = run_git("rev-parse", "HEAD", cwd=starter).stdout.strip()

    settings = Settings(tmp_path / "state")
    settings.prepare()
    checkout = tmp_path / "catalog"

    def fail_push(_catalog):
        raise CatalogError("Temporary push failure")

    with monkeypatch.context() as patch:
        patch.setattr(Catalog, "push", fail_push)
        with pytest.raises(CatalogError, match="Temporary push failure"):
            Catalog.initialize(settings, str(remote), "main", checkout)
    assert not settings.catalog_config.exists()
    seed = run_git("rev-parse", "HEAD", cwd=checkout).stdout.strip()
    assert run_git("rev-parse", "HEAD^", cwd=checkout).stdout.strip() == initial
    assert run_git("rev-parse", "main", cwd=remote).stdout.strip() == initial

    catalog = Catalog.initialize(settings, str(remote), "main", checkout)
    assert catalog.config.seed_revision == seed
    assert run_git("rev-parse", "main", cwd=remote).stdout.strip() == seed
    assert Catalog.initialize(settings, str(remote), "main", checkout).config == catalog.config


def test_switch_catalog_preserves_state(tmp_path):
    old_dir, new_dir = tmp_path / "old", tmp_path / "new"
    old_dir.mkdir()
    new_dir.mkdir()
    settings, old_env = bootstrap(old_dir)
    _, new_env = bootstrap(new_dir)
    state = State(settings)
    profile = state.profile()
    task = state.submit(uuid4(), "Keep this task across the catalog switch")
    old = Catalog.load(settings)
    with state.transaction(write=True) as db:
        skills = Skills(old, state, task)
        skills.register(
            db, "retained", old.config.seed_revision, "Retained test skill", "file.mode"
        )
        db.execute("INSERT INTO active_skills VALUES (?,?)", ("retained", old.config.seed_revision))

    checkout = old_dir / "replacement"
    with pytest.raises(CatalogError, match="already bound"):
        Catalog.initialize(settings, new_env["OPERATOR_CATALOG_REMOTE"], "main", checkout)
    replacement = Catalog.initialize(
        settings,
        new_env["OPERATOR_CATALOG_REMOTE"],
        "main",
        checkout,
        replace_from=old_env["OPERATOR_CATALOG_REMOTE"],
        seed_if_empty=False,
    )
    Skills(replacement, state).install_seed(replace=True)
    assert Catalog.load(settings).config == replacement.config
    assert state.active_skill_revision("create-skill") == replacement.config.seed_revision
    assert state.active_skill_revision("retained") == old.config.seed_revision
    assert state.profile() == profile
    assert state.snapshot().tasks[0].id == task
    assert len(list((settings.directory / "catalog-history").glob("*.json"))) == 1
    assert Path(old.config.checkout).is_dir()


def test_catalog_fast_forward_conflict_and_offline_skill(tmp_path):
    settings, env = bootstrap(tmp_path)
    checkout = Path(env["OPERATOR_CATALOG_CHECKOUT"])
    remote = Path(env["OPERATOR_CATALOG_REMOTE"])
    collaborator = tmp_path / "collaborator"
    run_git("clone", "--branch", "main", str(remote), str(collaborator))

    def sync(action, *, check=True):
        import subprocess

        return subprocess.run(
            ["make", f"catalog-{action}"],
            cwd=ROOT,
            env=env,
            check=check,
            capture_output=True,
        )

    task = State(settings).submit(uuid4(), "Inspect demo project")
    project = collaborator / "projects" / "example.json"
    project.write_text(
        json.dumps(
            {
                "name": "Example project",
                "description": "Fixture project",
                "repo": "https://user:synthetic@example.invalid/app.git?key=synthetic",
            }
        )
    )
    run_git("add", "--", "projects", cwd=collaborator)
    run_git("commit", "-m", "Define example project", cwd=collaborator)
    run_git("push", cwd=collaborator)
    sync("pull")

    helper = tmp_path / "docker"
    helper.write_text("#!/bin/sh\nexit 0\n")
    helper.chmod(0o755)
    write_policy(settings.directory, str(helper))

    async def build():
        async with (
            stdio_client(skill_server(settings, task)) as (read, write),
            ClientSession(read, write) as session,
        ):
            await session.initialize()
            read_project = await session.call_tool("project_read", {"project": "example"})
            assert read_project.structuredContent["repo"] == "https://example.invalid/app.git"
            assert read_project.structuredContent["catalog"]["path"] == "projects/example.json"
            result = await session.call_tool(
                "skill_scaffold", {"skill": "inspect-docker", **inspection_request()}
            )
            assert not result.isError, result.content
            candidate = result.structuredContent
            assert (await session.call_tool("skill_test", candidate)).structuredContent["passed"]
            assert not (await session.call_tool("skill_activate", candidate)).isError
            return candidate["revision"]

    revision = asyncio.run(build())
    sync("push")
    run_git("pull", "--ff-only", cwd=collaborator)
    assert run_git("rev-parse", "HEAD", cwd=collaborator).stdout.strip() == revision
    relative = "projects/example.json"
    for repo, text in ((checkout, "local"), (collaborator, "other owner")):
        (repo / relative).write_text(text)
        run_git("commit", "-m", text, "--", relative, cwd=repo)
    run_git("push", cwd=collaborator)
    assert sync("pull", check=False).returncode != 0
    assert sync("push", check=False).returncode != 0
    assert (checkout / relative).read_text() == "local"
    assert run_git("show", f"FETCH_HEAD:{relative}", cwd=checkout).stdout == "other owner"
    remote.rename(remote.with_name("offline.git"))

    async def invoke_offline():
        async with (
            stdio_client(skill_server(settings, task)) as (read, write),
            ClientSession(read, write) as session,
        ):
            await session.initialize()
            result = await session.call_tool(
                "run_inspect-docker", {"selector": "swarm.test=offline"}
            )
            assert result.structuredContent == {
                "skill": "inspect-docker",
                "revision": revision,
                "result": [],
            }

    asyncio.run(invoke_offline())
