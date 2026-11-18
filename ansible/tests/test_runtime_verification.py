"""Check Ansible's actual restart plan for current, stale, and unavailable runtimes."""

import copy
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parents[2]


class RuntimePlanningTests(unittest.TestCase):
    def test_runtime_mismatch_restarts_without_rebuilding_unchanged_source(self):
        deployment = yaml.safe_load((REPO / "ansible/tasks/deploy.yml").read_text())
        plan = next(
            task
            for task in deployment
            if task.get("name") == "Plan restart for a mismatched running release"
        )
        maintenance = next(
            task
            for task in deployment
            if task.get("name") == "Determine whether maintenance is needed"
        )
        commit = "a" * 40
        cases = [
            ("matching", {"status": 200, "json": {"commit": commit}}, False),
            ("old startup", {"status": 200, "json": {"commit": "b" * 40}}, True),
            ("old endpoint", {"status": 404}, True),
            ("unavailable", {"status": -1}, True),
            ("stopped", {"skipped": True}, False),
        ]
        tasks = []
        for label, probe, expected in cases:
            tasks.extend(
                [
                    {
                        "name": f"Use the {label} runtime observation",
                        "ansible.builtin.set_fact": {
                            "operator_running_before": probe,
                            "operator_runtime_mismatch": False,
                        },
                    },
                    copy.deepcopy(plan),
                    copy.deepcopy(maintenance),
                    {
                        "name": f"Check the {label} restart decision",
                        "ansible.builtin.assert": {
                            "that": [
                                f"operator_runtime_mismatch == {expected}",
                                f"operator_maintenance_required == {expected}",
                                "not operator_build_required",
                            ]
                        },
                    },
                ]
            )
        with tempfile.TemporaryDirectory(prefix="operator-runtime-plan-") as directory:
            root = Path(directory)
            playbook = root / "runtime-plan.json"
            playbook.write_text(
                json.dumps(
                    [
                        {
                            "name": "Test real release restart planning",
                            "hosts": "all",
                            "gather_facts": False,
                            "become": False,
                            "vars": {
                                "operator_target_commit": commit,
                                "operator_build_required": False,
                                "operator_env_plan": {"changed": False},
                                "operator_unit_plan": {"changed": False},
                                "operator_units": [{"name": "swarm-888.service", "enabled": True}],
                                "ansible_facts": {
                                    "services": {"swarm-888.service": {"state": "running"}}
                                },
                            },
                            "tasks": tasks,
                        }
                    ]
                )
            )
            executable = Path(sys.executable).with_name("ansible-playbook")
            command = str(executable) if executable.exists() else shutil.which("ansible-playbook")
            self.assertIsNotNone(command, "Run tests through uv run after uv sync --dev")
            result = subprocess.run(
                [command, "-i", "localhost,", "-c", "local", str(playbook)],
                cwd=REPO,
                env={
                    **os.environ,
                    "ANSIBLE_CONFIG": str(REPO / "ansible.cfg"),
                    "ANSIBLE_HOME": str(root / "ansible-home"),
                    "ANSIBLE_LOCAL_TEMP": str(root / "local-tmp"),
                    "ANSIBLE_REMOTE_TMP": str(root / "remote-tmp"),
                    "ANSIBLE_NOCOLOR": "1",
                },
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
