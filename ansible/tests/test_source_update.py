"""Exercise the real deployment tasks against disposable local Git repositories."""

import json
import os
import pwd
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
ANSIBLE = REPO / "ansible"


class SourceUpdateIntegrationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="operator-source-update-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.origin = self.root / "origin"
        self.checkout = self.root / "checkout"
        self.origin.mkdir()
        self.git(self.origin, "init", "--quiet", "--initial-branch=main")
        (self.origin / ".gitignore").write_text(".env\nnode_modules/\ndist/\n")
        (self.origin / "package.json").write_text('{"name":"deployment-fixture"}\n')
        (self.origin / "release.txt").write_text("First release\n")
        self.commit(self.origin, "First release")
        self.git(self.root, "clone", "--quiet", str(self.origin), str(self.checkout))
        self.initial = self.git(self.checkout, "rev-parse", "HEAD")
        self.environment_file = self.checkout / ".env"
        self.environment_file.write_text("ADMIN_PASSWORD=fixture-private-value\n")

    def git(self, directory, *arguments):
        return subprocess.run(
            [
                "git",
                "-c",
                "core.hooksPath=/dev/null",
                "-c",
                "commit.gpgSign=false",
                "-c",
                "user.name=Deployment fixture",
                "-c",
                "user.email=deployment@example.invalid",
                "-C",
                str(directory),
                *arguments,
            ],
            env={**os.environ, "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null"},
            capture_output=True,
            text=True,
            timeout=15,
            check=True,
        ).stdout.strip()

    def commit(self, directory, message):
        self.git(directory, "add", ".")
        self.git(directory, "commit", "--quiet", "-m", message)
        return self.git(directory, "rev-parse", "HEAD")

    def advance_origin(self, text="Second release\n"):
        (self.origin / "release.txt").write_text(text)
        return self.commit(self.origin, "Next release")

    def deploy(self, version="main", *, check_mode=False, expect_success=True):
        result_file = self.root / "source-result.json"
        if result_file.exists():
            result_file.unlink()
        tasks = [
            {
                "name": "Plan the requested source update",
                "ansible.builtin.include_tasks": str(ANSIBLE / "tasks/source-plan.yml"),
            },
            {
                "name": "Select the planned release",
                "ansible.builtin.include_tasks": str(ANSIBLE / "tasks/source-update.yml"),
                "when": "not ansible_check_mode and operator_source_changed",
            },
            {
                "name": "Record the selected release for assertions",
                "ansible.builtin.copy": {
                    "dest": str(result_file),
                    "content": "{{ {'commit': operator_target_commit, "
                    "'changed': operator_source_changed} | to_json }}",
                    "mode": "0600",
                },
                "check_mode": False,
            },
        ]
        playbook = self.root / "source-update.json"
        playbook.write_text(
            json.dumps(
                [
                    {
                        "name": "Test deployment source selection",
                        "hosts": "all",
                        "gather_facts": False,
                        "become": False,
                        "tasks": tasks,
                    }
                ]
            )
        )
        overrides = self.root / "vars.json"
        overrides.write_text(
            json.dumps(
                {
                    "ansible_become": False,
                    "operator_manage_checkout": True,
                    "operator_user": pwd.getpwuid(os.getuid()).pw_name,
                    "operator_account": {"uid": os.getuid()},
                    "operator_checkout": str(self.checkout),
                    "operator_repo_url": str(self.origin),
                    "operator_repo_version": version,
                    "operator_env_file": str(self.environment_file),
                    "operator_existing": {"results": [{"stat": {"exists": True}}] * 4},
                }
            )
        )
        executable = Path(sys.executable).with_name("ansible-playbook")
        command = str(executable) if executable.exists() else shutil.which("ansible-playbook")
        if command is None:
            raise RuntimeError("Run these tests using uv run after uv sync --dev")
        arguments = [
            command,
            "-i",
            "localhost,",
            "-c",
            "local",
            str(playbook),
            "-e",
            f"@{overrides}",
        ]
        if check_mode:
            arguments.append("--check")
        result = subprocess.run(
            arguments,
            cwd=REPO,
            env={
                **os.environ,
                "ANSIBLE_CONFIG": str(REPO / "ansible.cfg"),
                "ANSIBLE_HOME": str(self.root / "ansible-home"),
                "ANSIBLE_LOCAL_TEMP": str(self.root / "local-tmp"),
                "ANSIBLE_REMOTE_TMP": str(self.root / "remote-tmp"),
                "ANSIBLE_NOCOLOR": "1",
                "GIT_CONFIG_NOSYSTEM": "1",
                "GIT_CONFIG_GLOBAL": "/dev/null",
            },
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
        if expect_success:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            return json.loads(result_file.read_text())
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        return result.stdout + result.stderr

    def test_updates_main_to_remote_commit_and_preserves_ignored_environment(self):
        expected = self.advance_origin()
        result = self.deploy()
        self.assertEqual(result, {"commit": expected, "changed": True})
        self.assertEqual(self.git(self.checkout, "rev-parse", "HEAD"), expected)
        self.assertEqual((self.checkout / "release.txt").read_text(), "Second release\n")
        self.assertEqual(
            self.environment_file.read_text(), "ADMIN_PASSWORD=fixture-private-value\n"
        )

    def test_same_release_has_no_source_change_on_repeat(self):
        expected = self.advance_origin()
        self.deploy()
        result = self.deploy()
        self.assertEqual(result, {"commit": expected, "changed": False})
        self.assertEqual(self.git(self.checkout, "rev-parse", "HEAD"), expected)

    def test_can_select_a_non_main_release_branch(self):
        self.git(self.origin, "checkout", "--quiet", "-b", "release/next")
        expected = self.advance_origin("Release branch\n")
        result = self.deploy("release/next")
        self.assertEqual(result["commit"], expected)
        self.assertEqual(self.git(self.checkout, "rev-parse", "HEAD"), expected)
        self.assertEqual((self.checkout / "release.txt").read_text(), "Release branch\n")

    def test_check_mode_previews_new_main_without_changing_worktree(self):
        expected = self.advance_origin()
        result = self.deploy(check_mode=True)
        self.assertEqual(result, {"commit": expected, "changed": True})
        self.assertEqual(self.git(self.checkout, "rev-parse", "HEAD"), self.initial)
        self.assertEqual((self.checkout / "release.txt").read_text(), "First release\n")

    def test_tracked_or_untracked_owner_changes_are_not_discarded(self):
        self.advance_origin()
        for relative in ["release.txt", "owner-note.txt"]:
            with self.subTest(path=relative):
                path = self.checkout / relative
                previous = path.read_text() if path.exists() else None
                path.write_text("Unfinished owner work\n")
                self.deploy(expect_success=False)
                self.assertEqual(self.git(self.checkout, "rev-parse", "HEAD"), self.initial)
                self.assertEqual(path.read_text(), "Unfinished owner work\n")
                if previous is None:
                    path.unlink()
                else:
                    path.write_text(previous)

    def test_divergent_local_commits_are_not_overwritten(self):
        self.advance_origin()
        (self.checkout / "owner-note.txt").write_text("Local committed change\n")
        local = self.commit(self.checkout, "Owner local commit")
        self.deploy(expect_success=False)
        self.assertEqual(self.git(self.checkout, "rev-parse", "HEAD"), local)
        self.assertEqual((self.checkout / "owner-note.txt").read_text(), "Local committed change\n")

    def test_release_cannot_replace_private_environment_with_a_tracked_file(self):
        (self.origin / ".env").write_text("ADMIN_PASSWORD=incorrect-release-value\n")
        self.git(self.origin, "add", "--force", ".env")
        expected = self.commit(self.origin, "Accidentally tracked environment")
        self.assertNotEqual(expected, self.initial)
        self.deploy(expect_success=False)
        self.assertEqual(self.git(self.checkout, "rev-parse", "HEAD"), self.initial)
        self.assertEqual(
            self.environment_file.read_text(), "ADMIN_PASSWORD=fixture-private-value\n"
        )

    def test_missing_remote_ref_is_rejected_before_source_update(self):
        self.advance_origin()
        output = self.deploy("missing-release-branch", expect_success=False)
        self.assertIn("could not be resolved", output)
        self.assertEqual(self.git(self.checkout, "rev-parse", "HEAD"), self.initial)
        self.assertEqual((self.checkout / "release.txt").read_text(), "First release\n")
        self.assertEqual(
            self.environment_file.read_text(), "ADMIN_PASSWORD=fixture-private-value\n"
        )


if __name__ == "__main__":
    unittest.main()
