import asyncio
import json
import os
from pathlib import Path
from uuid import uuid4

from mcp import ClientSession
from mcp.client.stdio import stdio_client
from test_skills import ROOT, bootstrap

from operator_v1.catalog import run_git
from operator_v1.model import skill_server
from operator_v1.simulated_model import inspection_definition
from operator_v1.state import State


def test_catalog_fast_forward_conflict_and_offline_skill(tmp_path, monkeypatch):
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
    monkeypatch.setenv("PATH", str(tmp_path) + os.pathsep + os.environ["PATH"])

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
                "skill_scaffold", {"skill": "inspect-docker", "definition": inspection_definition()}
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
