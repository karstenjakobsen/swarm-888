"""Read-only post-reboot acceptance check for a designated disposable VPS."""

import json
import os
import sqlite3
import stat
import subprocess
from contextlib import closing
from pathlib import Path
from uuid import UUID

import httpx
import pytest

from swarm.state import name, state_path


@pytest.mark.live
def test_unattended_repair_after_reboot():
    previous = os.getenv("SWARM_TEST_PREVIOUS_BOOT_ID")
    goal = os.getenv("SWARM_TEST_BOOT_GOAL")
    if not previous or not goal:
        pytest.skip("Supply the previous boot ID and the disposable standing goal ID")
    current = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
    assert UUID(current) != UUID(previous)
    boot = int(
        next(
            line.split()[1]
            for line in Path("/proc/stat").read_text().splitlines()
            if line.startswith("btime ")
        )
    )
    subprocess.run(
        ["systemctl", "--user", "is-active", "swarm-worker.service", "swarm-controller.service"],
        check=True,
    )
    root = state_path()
    with closing(sqlite3.connect((root / "state.sqlite").as_uri() + "?mode=ro", uri=True)) as db:
        db.row_factory = sqlite3.Row
        g = db.execute("SELECT * FROM goals WHERE id=?", (goal,)).fetchone()
        assert g and g["status"] == "active"
        checks = [
            json.loads(row[0])
            for row in db.execute(
                "SELECT data FROM events WHERE task=? AND kind='goal.check' AND at>=? AND json_extract(data,'$.goal')=? ORDER BY id",
                (g["authority"], boot, goal),
            )
        ]
        assert checks and checks[0]["status"] == "drifted"
        ops = db.execute(
            """SELECT i.id,i.status AS incident,o.status,o.rev,o.evidence FROM incidents i
               JOIN operations o ON o.task=i.id WHERE i.goal=? AND o.authority=? AND o.target=?
               AND json_extract(i.evidence,'$.at')>=?""",
            (goal, g["authority"], g["resource"], boot),
        ).fetchall()
        assert len(ops) == 1
        op = ops[0]
        assert op["incident"] == "resolved" and op["status"] == "verified" and op["rev"] == g["rev"]
        observed = json.loads(op["evidence"])
        assert observed["status"] == "healthy" and observed["observed"] == g["mode"]
        assert stat.S_IMODE((root / "fixtures" / name(g["resource"])).stat().st_mode) == int(
            g["mode"], 8
        )
        assert not db.execute(
            "SELECT 1 FROM events WHERE task=? AND kind='codex.activity' AND at>=?",
            (g["authority"], boot),
        ).fetchone()
    with httpx.Client(
        transport=httpx.HTTPTransport(uds=str(root / "worker.sock")), base_url="http://worker"
    ) as client:
        response = client.post("/rpc", json={"method": "summary"})
        response.raise_for_status()
        assert response.json()["uid"] == os.getuid()
    port = int(os.getenv("SWARM_PORT", "8880"))
    with httpx.Client(trust_env=False) as client:
        login = client.get(f"http://127.0.0.1:{port}/")
    assert login.status_code == 200 and 'name="key"' in login.text
    print(
        "boot",
        current,
        "goal",
        goal,
        "incident",
        op["id"],
        "mode",
        observed["observed"],
        "revision",
        op["rev"],
    )
