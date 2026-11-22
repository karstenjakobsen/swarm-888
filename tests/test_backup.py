import asyncio
import os
import stat
from uuid import uuid4

import pytest
from mcp import ClientSession
from mcp.client.stdio import stdio_client
from test_message import controller, login
from test_operations import initialized

from operator_v1.backup import export, restore
from operator_v1.catalog import Catalog
from operator_v1.config import Settings
from operator_v1.model import skill_server
from operator_v1.state import State


def test_restore_reopens_tasks_and_runs_the_pinned_skill_offline(tmp_path, monkeypatch):
    settings, _, revision = initialized(tmp_path)
    state = State(settings)
    task = state.submit(uuid4(), "Inspect the fixtures")
    state.claim()
    work = settings.directory / "workspaces" / task
    work.mkdir(parents=True)
    (work / "result.txt").write_text("retained workspace")
    state.finish(task, "No fixtures", "Finished")
    before = state.snapshot()
    archive = tmp_path / "operator.tar.gz"
    with settings.service_lock("worker"), pytest.raises(BlockingIOError):
        export(settings, archive)
    export(settings, archive)
    assert stat.S_IMODE(archive.stat().st_mode) == 0o600
    config = Catalog.load(settings)
    config.checkout.rename(tmp_path / "offline-checkout")
    restored = Settings(tmp_path / "restored")
    restore(restored, archive, tmp_path / "restored-catalog")
    assert before == State(restored).snapshot()
    assert (
        restored.directory / "workspaces" / task / "result.txt"
    ).read_text() == "retained workspace"
    assert Catalog.load(restored).git("rev-parse", "HEAD").strip() == revision
    with controller(restored) as client:
        login(client, restored)
        snapshot = client.get("/api/snapshot").json()
        assert snapshot["cursor"] == before.cursor
        assert snapshot["tasks"][0]["id"] == task

    docker = tmp_path / "docker"
    docker.write_text("#!/bin/sh\nexit 0\n")
    docker.chmod(0o755)
    monkeypatch.setenv("PATH", str(tmp_path) + os.pathsep + os.environ["PATH"])

    async def invoke():
        async with (
            stdio_client(skill_server(restored, None)) as (read, write),
            ClientSession(read, write) as session,
        ):
            await session.initialize()
            answer = await session.call_tool(
                "run_inspect-docker", {"selector": "swarm.test=restored"}
            )
            assert answer.structuredContent["revision"] == revision

    asyncio.run(invoke())
