import asyncio
import stat
import time
from pathlib import Path
from uuid import uuid4

from mcp import ClientSession
from mcp.client.stdio import stdio_client
from test_skills import bootstrap

from operator_v1.backup import export, restore
from operator_v1.config import Settings
from operator_v1.goals import StandingGoals
from operator_v1.model import skill_server
from operator_v1.state import State


def definition(mask: str, *, regression: bool = False) -> dict:
    tests = [
        {
            "name": "existing read-write case",
            "rows": [{"expectedMode": "600"}],
            "expected": [{"mode": "600"}],
        }
    ]
    if regression:
        tests.append(
            {
                "name": "preserve owner execute",
                "rows": [{"expectedMode": "700"}],
                "expected": [{"mode": "700"}],
            }
        )
    return {
        "name": "Maintain fixture permissions",
        "purpose": "Check and repair permission bits on a test-owned fixture file.",
        "procedure": [
            "Read the fixture mode.",
            "Apply the goal mode using the repair mask.",
            "Read back the result.",
        ],
        "program": {"source": "file.mode", "repair_mask": mask},
        "tests": tests,
    }


def mode(path: Path) -> int:
    return stat.S_IMODE(path.stat().st_mode)


def test_paused_goal_and_regression_repair_keep_the_same_incident_budget(tmp_path):
    settings, _ = bootstrap(tmp_path)
    settings.create_owner_key()
    state = State(settings)
    directory = settings.directory / "defense"
    directory.mkdir(mode=0o700)
    fixture = directory / "proof.txt"
    fixture.touch(mode=0o700)
    task = state.submit(uuid4(), "Maintain fixture permissions.")
    now = [time.time() + 1]
    # Calls are synchronous with the controllable clock so intervals are exact.
    goals = StandingGoals(settings, state, clock=lambda: now[0])

    async def exercise():
        async with (
            stdio_client(skill_server(settings, task)) as (read, write),
            ClientSession(read, write) as session,
        ):
            await session.initialize()

            async def call(name, **arguments):
                response = await session.call_tool(name, arguments)
                assert not response.isError, response.content
                return response.structuredContent

            async def build(mask, *, regression=False):
                revision = await call(
                    "skill_scaffold",
                    skill="fixture-mode",
                    definition=definition(mask, regression=regression),
                )
                return revision, await call("skill_test", **revision)

            old, tested = await build("600")
            assert tested["passed"]
            await call("skill_activate", **old)
            goal = await call(
                "goal_create", filename=fixture.name, mode="700", interval=2, skill="fixture-mode"
            )
            goals.run_due()
            assert mode(fixture) == 0o700
            assert not any(event.data.get("action") == "model" for event in state.after(0))
            await call("goal_change", **goal, status="paused")
            fixture.chmod(0o644)
            now[0] += 10
            goals.run_due()
            assert mode(fixture) == 0o644
            with state.transaction() as db:
                assert db.execute("SELECT COUNT(*) FROM incidents").fetchone()[0] == 0

            await call("goal_change", **goal, status="active")
            now[0] += 3
            goals.run_due()
            assert mode(fixture) == 0o600
            with state.transaction() as db:
                first = db.execute("SELECT * FROM incidents").fetchone()
                assert first["attempts"] == 1
                assert first["revision"] == old["revision"]
            stale, tested = await build("600", regression=True)
            assert not tested["passed"]
            assert (await session.call_tool("skill_activate", stale)).isError
            fixed, tested = await build("777", regression=True)
            assert tested["passed"] and len(tested["tests"]) == 2
            await call("skill_activate", **fixed)
            restarted = StandingGoals(settings, State(settings), clock=lambda: now[0])
            now[0] += 3
            restarted.run_due()
            assert mode(fixture) == 0o700
            with state.transaction() as db:
                row = db.execute("SELECT * FROM incidents").fetchone()
                assert row["id"] == first["id"]
                assert row["deadline"] == first["deadline"]
                assert row["attempts"] == 2
                assert row["revision"] == fixed["revision"]
                assert row["status"] == "resolved"

            fixture.unlink()
            for _ in range(12):
                now[0] += 3
                restarted.run_due()
            with state.transaction() as db:
                unknown = db.execute("SELECT * FROM incidents WHERE status='unknown'").fetchone()
                assert unknown["notified"] == 1
                assert unknown["attempts"] == 0
                assert unknown["observations"] == goals.max_observations
            await call("goal_change", **goal, status="retired")

    asyncio.run(exercise())
    actions = [event.data.get("action") for event in state.after(0)]
    assert actions.count("incident_repair") == 2
    assert actions.count("incident_recovered") == 1
    assert actions.count("incident_unknown") == 1
    archive = tmp_path / "defense.tar.gz"
    export(settings, archive)
    restored = Settings(tmp_path / "restored")
    restore(restored, archive)
    with state.transaction() as original, State(restored).transaction() as recovered:
        for table in ("standing_goals", "incidents"):
            assert list(map(dict, original.execute(f"SELECT * FROM {table}"))) == list(
                map(dict, recovered.execute(f"SELECT * FROM {table}"))
            )
