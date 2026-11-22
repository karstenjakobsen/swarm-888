import asyncio
import os
import shlex
import subprocess
from pathlib import Path
from uuid import uuid4

from mcp import ClientSession, types
from mcp.client.stdio import stdio_client

from operator_v1.config import Settings
from operator_v1.model import skill_server
from operator_v1.simulated_model import inspection_definition
from operator_v1.state import State

ROOT = Path(__file__).resolve().parents[1]


def bootstrap(tmp_path: Path) -> tuple[Settings, dict[str, str]]:
    remote = tmp_path / "remote.git"
    subprocess.run(["git", "init", "--bare", str(remote)], check=True, capture_output=True)
    settings = Settings(tmp_path / "state")
    env = {
        **os.environ,
        "OPERATOR_STATE_DIR": str(settings.directory),
        "OPERATOR_CATALOG_REMOTE": str(remote),
        "OPERATOR_CATALOG_CHECKOUT": str(tmp_path / "catalog"),
    }
    subprocess.run(["make", "catalog-init"], cwd=ROOT, env=env, check=True, capture_output=True)
    return settings, env


def test_bootstrap_and_hot_plug(tmp_path, monkeypatch):
    settings, env = bootstrap(tmp_path)
    state = State(settings)
    task = state.submit(uuid4(), "Inspect the fixture")
    state.claim()
    # The default suite exercises the helper and MCP without a Docker daemon.
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    docker = bin_dir / "docker"
    docker.write_text('#!/bin/sh\n[ "$1" = ps ] && [ "$3" = --filter ]\n')
    docker.chmod(0o755)
    monkeypatch.setenv("PATH", str(bin_dir) + os.pathsep + os.environ["PATH"])

    async def exercise():
        changed = asyncio.Event()

        async def notifications(message):
            if isinstance(message, types.ServerNotification) and isinstance(
                message.root, types.ToolListChangedNotification
            ):
                changed.set()

        async with (
            stdio_client(skill_server(settings, task)) as (read, write),
            ClientSession(read, write, message_handler=notifications) as session,
        ):
            await session.initialize()

            async def call(name, **arguments):
                result = await session.call_tool(name, arguments)
                assert not result.isError, result.content
                return result.structuredContent

            assert [item["skill"] for item in (await call("skill_discover"))["skills"]] == [
                "create-skill"
            ]
            assert (await call("skill_discover", query="inspect docker"))["skills"] == []
            assert (await call("skill_authoring_guide"))["template"]["program"]
            candidate = await call(
                "skill_scaffold", skill="inspect-docker", definition=inspection_definition()
            )
            assert len(candidate["revision"]) == 40
            assert (await call("skill_test", **candidate))["passed"]
            await call("skill_activate", **candidate)
            await asyncio.wait_for(changed.wait(), timeout=3)
            assert "run_inspect-docker" in {
                tool.name for tool in (await session.list_tools()).tools
            }
            assert (await call("run_inspect-docker", selector="swarm.test=empty"))["result"] == []
            assert (
                await call("skill_invoke", skill="inspect-docker", selector="swarm.test=empty")
            )["revision"] == candidate["revision"]
            return candidate["revision"]

    revision = asyncio.run(exercise())
    subprocess.run(["make", "catalog-init"], cwd=ROOT, env=env, check=True, capture_output=True)
    with state.transaction() as db:
        assert (
            db.execute(
                "SELECT revision FROM active_skills WHERE skill='inspect-docker'"
            ).fetchone()[0]
            == revision
        )
        assert db.execute("SELECT COUNT(*) FROM skill_calls").fetchone()[0] == 2
    actions = [event.data.get("action") for event in state.after(0) if event.kind == "evidence"]
    assert actions == [
        "skill_discovery",
        "skill_discovery",
        "authoring_guide",
        "skill_built",
        "skill_tested",
        "skill_activated",
        "skill_invoked",
        "skill_invoked",
    ]


def test_revision_pinning_failed_candidate_and_rollback(tmp_path, monkeypatch):
    settings, _ = bootstrap(tmp_path)
    tool_dir = tmp_path / "bin"
    tool_dir.mkdir()
    started = tmp_path / "started"
    release = tmp_path / "release"
    docker = tool_dir / "docker"
    docker.write_text(
        "#!/bin/sh\n"
        'if [ "$4" = label=swarm.test=hold ]; then\n'
        f"  touch {shlex.quote(str(started))}\n"
        f"  for attempt in $(seq 1 160); do [ -f {shlex.quote(str(release))} ] && exit 0; sleep .05; done\n"
        "  exit 1\n"
        "fi\n"
        "exit 0\n"
    )
    docker.chmod(0o755)
    monkeypatch.setenv("PATH", str(tool_dir) + os.pathsep + os.environ["PATH"])

    async def exercise():
        async with (
            stdio_client(skill_server(settings, None)) as (read, write),
            ClientSession(read, write) as session,
        ):
            await session.initialize()

            async def call(name, **arguments):
                result = await session.call_tool(name, arguments)
                assert not result.isError, result.content
                return result.structuredContent

            async def candidate(definition):
                return await call("skill_scaffold", skill="inspect-docker", definition=definition)

            async def active():
                return (await call("skill_discover", query="docker"))["skills"][0]["revision"]

            first = await candidate(inspection_definition())
            assert (await call("skill_test", **first))["passed"]
            await call("skill_activate", **first)
            pending = asyncio.create_task(call("run_inspect-docker", selector="swarm.test=hold"))
            try:
                async with asyncio.timeout(5):
                    while not started.exists():
                        await asyncio.sleep(0.02)
                second = await candidate(
                    {**inspection_definition(), "name": "Docker inspection v2"}
                )
                assert (await call("skill_test", **second))["passed"]
                await call("skill_activate", **second)
                assert await active() == second["revision"]
                assert (await call("run_inspect-docker", selector="swarm.test=other"))[
                    "revision"
                ] == second["revision"]
            finally:
                release.touch()
            assert (await pending)["revision"] == first["revision"]

            definition = inspection_definition()
            definition["tests"][2]["expected"] = [{"name": "invalid expected output"}]
            broken = await candidate(definition)
            assert not (await call("skill_test", **broken))["passed"]
            assert (await session.call_tool("skill_activate", broken)).isError
            assert await active() == second["revision"]
            assert (await call("skill_rollback", **first))["changed"]
            assert await active() == first["revision"]
            assert (await call("run_inspect-docker", selector="swarm.test=other"))[
                "revision"
            ] == first["revision"]

    asyncio.run(exercise())
