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
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="operator-git-auth-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.checkout = self.root / "packages"
        self.checkout.mkdir()
        subprocess.run(["git", "init", "--quiet", str(self.checkout)], check=True)
        self.identity = self.root / ".ssh/id_ed25519_packages"

    def provision(self, *, expect_success=True):
        playbook = self.root / "play.json"
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
        variables = self.root / "vars.json"
        variables.write_text(
            json.dumps(
                {
                    "ansible_become": False,
                    "operator_user": pwd.getpwuid(os.getuid()).pw_name,
                    "operator_group": grp.getgrgid(os.getgid()).gr_name,
                    "operator_home": str(self.root),
                    "operator_github_ssh_known_hosts": False,
                    "operator_git_ssh_keys": [
                        {
                            "name": "packages",
                            "path": str(self.identity),
                            "repository_dir": str(self.checkout),
                        }
                    ],
                }
            )
        )
        executable = Path(sys.executable).with_name("ansible-playbook")
        command = str(executable) if executable.exists() else shutil.which("ansible-playbook")
        self.assertIsNotNone(command)
        result = subprocess.run(
            [command, "-i", "localhost,", "-c", "local", str(playbook), "-e", f"@{variables}"],
            cwd=REPO,
            env={
                **os.environ,
                "ANSIBLE_CONFIG": str(REPO / "ansible.cfg"),
                "ANSIBLE_HOME": str(self.root / "ansible-home"),
                "ANSIBLE_LOCAL_TEMP": str(self.root / "local-tmp"),
                "ANSIBLE_REMOTE_TMP": str(self.root / "remote-tmp"),
                "ANSIBLE_NOCOLOR": "1",
            },
            text=True,
            capture_output=True,
            timeout=45,
            check=False,
        )
        if expect_success:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        return result.stdout + result.stderr

    def test_dedicated_identity_is_private_preserved_and_scoped_to_its_checkout(self):
        for attempt in range(2):
            output = self.provision()
            self.assertEqual(stat.S_IMODE(self.identity.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(self.identity.parent.stat().st_mode), 0o700)
            public_key = self.identity.with_suffix(".pub").read_text()
            self.assertTrue(public_key.startswith("ssh-ed25519 "))
            if attempt == 0:
                original_public_key = public_key
            else:
                self.assertEqual(public_key, original_public_key)
                self.assertRegex(output, r"changed=0\b")
        ssh_command = subprocess.run(
            ["git", "-C", str(self.checkout), "config", "--local", "--get", "core.sshCommand"],
            text=True,
            capture_output=True,
            check=True,
        ).stdout.strip()
        self.assertEqual(
            ssh_command,
            f"ssh -i {self.identity} -o IdentitiesOnly=yes -o BatchMode=yes "
            "-o StrictHostKeyChecking=yes",
        )

    def test_symlinked_ssh_directory_does_not_change_its_target(self):
        target = self.root / "other-directory"
        target.mkdir(mode=0o755)
        self.identity.parent.symlink_to(target, target_is_directory=True)
        output = self.provision(expect_success=False)
        self.assertIn("must not use symlinks", output)
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o755)
        self.assertFalse((target / self.identity.name).exists())

    def test_symlinked_private_identity_does_not_change_its_target(self):
        self.identity.parent.mkdir(mode=0o700)
        target = self.root / "other-file"
        target.write_text("Keep this unrelated file unchanged.\n")
        target.chmod(0o640)
        self.identity.symlink_to(target)
        output = self.provision(expect_success=False)
        self.assertIn("must not use symlinks", output)
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o640)
        self.assertEqual(target.read_text(), "Keep this unrelated file unchanged.\n")

    def test_hardlinked_private_identity_does_not_change_its_target(self):
        self.identity.parent.mkdir(mode=0o700)
        target = self.root / "other-file"
        target.write_text("Keep this unrelated file unchanged.\n")
        target.chmod(0o640)
        os.link(target, self.identity)
        output = self.provision(expect_success=False)
        self.assertIn("regular files with one hard link", output)
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o640)
        self.assertEqual(target.read_text(), "Keep this unrelated file unchanged.\n")


if __name__ == "__main__":
    unittest.main()
