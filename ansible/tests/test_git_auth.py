"""Provision disposable repository SSH identities without a network connection."""

import grp
import json
import os
import pwd
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


class GitIdentityTests(unittest.TestCase):
    def test_dedicated_identity_is_private_preserved_and_scoped_to_its_checkout(self):
        with tempfile.TemporaryDirectory(prefix="operator-git-auth-") as temporary:
            root = Path(temporary)
            checkout = root / "packages"
            checkout.mkdir()
            subprocess.run(["git", "init", "--quiet", str(checkout)], check=True)
            identity = root / ".ssh/id_ed25519_packages"
            playbook = root / "play.json"
            playbook.write_text(
                json.dumps(
                    [
                        {
                            "name": "Provision a disposable package identity",
                            "hosts": "all",
                            "gather_facts": False,
                            "tasks": [
                                {
                                    "name": "Configure repository authentication",
                                    "ansible.builtin.include_tasks": str(
                                        REPO / "ansible/tasks/git-auth.yml"
                                    ),
                                }
                            ],
                        }
                    ]
                )
            )
            variables = root / "vars.json"
            variables.write_text(
                json.dumps(
                    {
                        "ansible_become": False,
                        "operator_user": pwd.getpwuid(os.getuid()).pw_name,
                        "operator_group": grp.getgrgid(os.getgid()).gr_name,
                        "operator_home": str(root),
                        "operator_github_ssh_known_hosts": False,
                        "operator_git_ssh_keys": [
                            {
                                "name": "packages",
                                "path": str(identity),
                                "repository_dir": str(checkout),
                            }
                        ],
                    }
                )
            )
            executable = Path(sys.executable).with_name("ansible-playbook")
            command = str(executable) if executable.exists() else shutil.which("ansible-playbook")
            self.assertIsNotNone(command)
            environment = {
                **os.environ,
                "ANSIBLE_CONFIG": str(REPO / "ansible.cfg"),
                "ANSIBLE_HOME": str(root / "ansible-home"),
                "ANSIBLE_LOCAL_TEMP": str(root / "local-tmp"),
                "ANSIBLE_REMOTE_TMP": str(root / "remote-tmp"),
                "ANSIBLE_NOCOLOR": "1",
            }
            arguments = [
                command,
                "-i",
                "localhost,",
                "-c",
                "local",
                str(playbook),
                "-e",
                f"@{variables}",
            ]
            for attempt in range(2):
                result = subprocess.run(
                    arguments,
                    cwd=REPO,
                    env=environment,
                    text=True,
                    capture_output=True,
                    timeout=45,
                    check=False,
                )
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertEqual(stat.S_IMODE(identity.stat().st_mode), 0o600)
                self.assertEqual(stat.S_IMODE(identity.parent.stat().st_mode), 0o700)
                public_key = identity.with_suffix(".pub").read_text()
                self.assertTrue(public_key.startswith("ssh-ed25519 "))
                if attempt == 0:
                    original_public_key = public_key
                else:
                    self.assertEqual(public_key, original_public_key)
                    self.assertRegex(result.stdout, r"changed=0\b")
            ssh_command = subprocess.run(
                ["git", "-C", str(checkout), "config", "--local", "--get", "core.sshCommand"],
                text=True,
                capture_output=True,
                check=True,
            ).stdout.strip()
            self.assertEqual(
                ssh_command,
                f"ssh -i {identity} -o IdentitiesOnly=yes -o BatchMode=yes "
                "-o StrictHostKeyChecking=yes",
            )


if __name__ == "__main__":
    unittest.main()
