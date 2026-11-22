"""Provision and verify the isolated VPS fixture through the local API and MCP."""

import argparse
import asyncio
import json
import os
import stat
import time
from pathlib import Path
from uuid import NAMESPACE_URL, uuid5

import httpx

from operator_v1.config import Settings
from operator_v1.model import connect_skills
from operator_v1.state import State

ORIGIN = "http://127.0.0.1:18080"
PIN = "13f38198f37d320d397e4bec260400bf51924f6a"
FIXTURE = "vps-acceptance-permissions.txt"
MODE_SKILL = "vps-acceptance-file-mode"
POLICY_SKILL = "vps-acceptance-command-policy"
MEMORY = "Server-212 VPS acceptance uses an isolated permissions fixture."
INTERVAL = 4


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def wait_for(get, message: str):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        result = get()
        if result:
            return result
        time.sleep(0.2)
    raise RuntimeError(message)


async def call(mcp, name: str, **arguments):
    result = await mcp.call_tool(name, arguments)
    if result.isError or result.structuredContent is None:
        raise RuntimeError(f"{name}: {result.content}")
    return result.structuredContent


async def activate(mcp, skill: str, definition: dict, **files) -> str:
    candidate = await call(mcp, "skill_scaffold", skill=skill, definition=definition, **files)
    tested = await call(mcp, "skill_test", **candidate)
    require(tested["passed"], f"Self-tests failed for {skill}")
    await call(mcp, "skill_activate", **candidate)
    return candidate["revision"]


def active_revision(mcp_result: dict, skill: str) -> str:
    return next(item["revision"] for item in mcp_result["skills"] if item["skill"] == skill)


def write_policy(settings: Settings) -> None:
    path = settings.directory / "skill-dependencies.json"
    policies = json.loads(path.read_text()) if path.exists() else {}
    rule = {
        "executable": "/opt/swarm-operator-tools/acceptance-probe",
        "commands": [{"prefix": ["allowed"]}],
    }
    require(policies.get("acceptance-probe", rule) == rule, "Probe policy name is already in use")
    if "acceptance-probe" not in policies:
        policies["acceptance-probe"] = rule
        staged = path.with_suffix(".acceptance.tmp")
        staged.write_text(json.dumps(policies, indent=2) + "\n")
        staged.chmod(0o600)
        staged.replace(path)


class Acceptance:
    def __init__(self, settings: Settings, client: httpx.Client):
        self.settings = settings
        self.state = State(settings)
        self.client = client
        self.fixture = settings.directory / "defense" / FIXTURE
        self.dispatches = settings.directory / "acceptance-dispatches.txt"
        self.baseline = settings.directory / "vps-acceptance-before.json"
        self.headers = {"Origin": ORIGIN, "X-Operator-Action": "1"}

    def login(self) -> None:
        result = self.client.post(
            "/api/session",
            headers=self.headers,
            json={"key": self.settings.read_owner_key().decode()},
        )
        require(result.status_code == 204, f"Sign-in returned {result.status_code}")

    def snapshot(self) -> dict:
        response = self.client.get("/api/snapshot")
        response.raise_for_status()
        return response.json()

    def submit(self) -> str:
        result = self.client.post(
            "/api/commands",
            headers=self.headers,
            json={
                "kind": "message",
                "requestId": str(uuid5(NAMESPACE_URL, "swarm-operator/server-212/vps-acceptance")),
                "text": "Authorize one permissions acceptance fixture and a harmless command policy test.",
            },
        )
        require(result.status_code == 202, f"Task submission returned {result.status_code}")
        return result.json()["taskId"]

    def report(self, goal: str) -> dict:
        snapshot = self.snapshot()
        matching = [event for event in snapshot["events"] if event["data"].get("goal") == goal]
        repairs = [
            event["seq"] for event in matching if event["data"].get("action") == "incident_repair"
        ]
        checks = [
            event["seq"]
            for event in matching
            if event["data"].get("action") == "goal_checked"
            and event["data"].get("status") == "holding"
        ]
        with self.state.transaction() as db:
            row = db.execute(
                "SELECT id,task,filename,expected,skill,status,interval FROM standing_goals WHERE id=?",
                (goal,),
            ).fetchone()
        require(row is not None, "Standing goal is missing")
        return {
            "boot_id": Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
            "framework_revision": Path("/opt/swarm-operator/.framework-revision")
            .read_text()
            .strip(),
            "profile": snapshot["profile"],
            "goal": dict(row),
            "file_mode": f"{stat.S_IMODE(self.fixture.stat().st_mode):04o}",
            "healthy_checks": checks,
            "repair_events": repairs,
            "cursor": snapshot["cursor"],
        }

    async def before(self) -> dict:
        if self.baseline.exists():
            return json.loads(self.baseline.read_text())
        self.fixture.parent.mkdir(mode=0o700, exist_ok=True)
        if not self.fixture.exists():
            self.fixture.touch(mode=0o600, exist_ok=False)
        write_policy(self.settings)
        task = self.submit()
        wait_for(
            lambda: any(
                entry["id"] == task and entry["checkpoint"] == "completed"
                for entry in self.snapshot()["tasks"]
            ),
            "Root worker did not acknowledge the authorized fixture task",
        )
        async with connect_skills(self.settings, task) as mcp:
            policy_sha = await activate(
                mcp,
                POLICY_SKILL,
                {
                    "name": "VPS acceptance command policy",
                    "purpose": "Check argument authorization with a harmless probe.",
                    "procedure": ["Request the probe with the supplied argument."],
                    "program": {
                        "source": "executable",
                        "entrypoint": "run.lua",
                        "dependencies": ["acceptance-probe"],
                        "input_schema": {
                            "type": "object",
                            "properties": {"value": {"type": "string"}},
                            "required": ["value"],
                            "additionalProperties": False,
                        },
                    },
                    "tests": [
                        {
                            "name": "mock the approved invocation",
                            "arguments": {"value": "allowed"},
                            "commands": [
                                {
                                    "dependency": "acceptance-probe",
                                    "argv": ["allowed"],
                                    "stdout": "allowed",
                                }
                            ],
                            "expected": ["allowed"],
                        }
                    ],
                },
                entrypoint='return function(args) return {run("acceptance-probe", args.value)} end',
            )
            existing = self.dispatches.read_text().splitlines() if self.dispatches.exists() else []
            approved = await call(
                mcp, "skill_invoke", skill=POLICY_SKILL, arguments={"value": "allowed"}
            )
            require(
                approved["result"] == ["allowed"],
                "Approved command did not return its expected output",
            )
            after_allow = self.dispatches.read_text().splitlines()
            require(
                after_allow == [*existing, "allowed"],
                "Probe did not observe exactly one approved dispatch",
            )
            denied = await mcp.call_tool(
                "skill_invoke", {"skill": POLICY_SKILL, "arguments": {"value": "denied"}}
            )
            denial = " ".join(item.text for item in denied.content if item.type == "text")
            require(
                denied.isError and "outside the owner-authorized dependency policy" in denial,
                "Unapproved command was not denied by the executor",
            )
            require(
                self.dispatches.read_text().splitlines() == after_allow, "Denied command dispatched"
            )

            mode_sha = await activate(
                mcp,
                MODE_SKILL,
                {
                    "name": "VPS acceptance file permissions",
                    "purpose": "Maintain one owned acceptance fixture.",
                    "procedure": ["Apply the owner-authorized file mode and verify it."],
                    "program": {"source": "file.mode"},
                    "tests": [
                        {
                            "name": "private fixture permissions",
                            "rows": [{"expectedMode": "600"}],
                            "expected": [{"mode": "600"}],
                        }
                    ],
                },
            )
            written = await call(
                mcp,
                "memory_write",
                title="VPS acceptance fixture",
                scope="acceptance",
                kind="fact",
                text=MEMORY,
            )
            goal = (
                await call(
                    mcp,
                    "goal_create",
                    filename=FIXTURE,
                    mode="600",
                    skill=MODE_SKILL,
                    interval=INTERVAL,
                )
            )["goal"]
        wait_for(lambda: self.report(goal)["healthy_checks"], "Initial healthy check did not run")
        existing_repairs = self.report(goal)["repair_events"]
        if not existing_repairs:
            self.fixture.chmod(0o644)
        wait_for(
            lambda: (
                len(self.report(goal)["repair_events"]) == 1
                and self.report(goal)["file_mode"] == "0600"
            ),
            "The expected single file repair did not finish",
        )
        result = {
            **self.report(goal),
            "task": task,
            "skills": {POLICY_SKILL: policy_sha, MODE_SKILL: mode_sha},
            "memory": written,
            "policy": {"approved_dispatches": 1, "denied_dispatches": 0, "denial": denial},
        }
        require(result["framework_revision"] == PIN, "Wrong framework pin")
        self.baseline.write_text(json.dumps(result, indent=2) + "\n")
        return result

    async def after(self) -> dict:
        before = json.loads(self.baseline.read_text())
        goal = before["goal"]["id"]
        result = self.report(goal)
        require(result["boot_id"] != before["boot_id"], "The VPS boot ID is unchanged")
        for name in ("framework_revision", "profile", "goal"):
            require(result[name] == before[name], f"Lost persisted {name}")
        async with connect_skills(self.settings, before["task"]) as mcp:
            discovery = await call(mcp, "skill_discover")
            for name, revision in before["skills"].items():
                require(
                    active_revision(discovery, name) == revision, f"Lost active revision of {name}"
                )
            memory = await call(
                mcp,
                "memory_read",
                memory=before["memory"]["memory"],
                reason="Verify reboot persistence",
            )
            require(
                memory["text"] == MEMORY and memory["revision"] == before["memory"]["revision"],
                "Lost saved memory",
            )
        cursor = result["cursor"]
        wait_for(
            lambda: any(seq > cursor for seq in self.report(goal)["healthy_checks"]),
            "The worker did not perform a fresh healthy check after reboot",
        )
        result = self.report(goal)
        require(result["file_mode"] == "0600", "The fixture mode changed across reboot")
        require(
            result["repair_events"] == before["repair_events"],
            "Healthy fixture triggered another repair",
        )
        return {
            **result,
            "skills": before["skills"],
            "memory": before["memory"],
            "post_reboot_repairs": 0,
        }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("phase", choices=("before", "after"))
    args = parser.parse_args()
    os.umask(0o077)
    with httpx.Client(base_url=ORIGIN, trust_env=False) as client:
        check = Acceptance(Settings.load(), client)
        check.login()
        print(json.dumps(asyncio.run(getattr(check, args.phase)()), sort_keys=True))


if __name__ == "__main__":
    main()
