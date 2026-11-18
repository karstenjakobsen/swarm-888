"""Exercise deployment templates and build fingerprints without changing the host."""

import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
ANSIBLE = REPO / "ansible"
FINGERPRINT = ANSIBLE / "files/source_fingerprint.py"


class TemplateIntegrationTests(unittest.TestCase):
    """Render through Ansible so its Jinja whitespace settings are exercised."""

    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="operator-template-test-")
        cls.addClassCleanup(cls.temporary.cleanup)
        cls.directory = Path(cls.temporary.name)
        cls.passwords = {
            "single_quote": 'dummy password # $ \\ slash and "double quotes"',
            "backtick": "dummy password # $ \\ slash and 'single' plus \"double\"",
        }
        cls.units = [
            {"kind": "controller", "description": "Test controller"},
            {"kind": "user", "description": "Test user worker"},
            {"kind": "root", "description": "Test root worker"},
        ]
        play = {
            "name": "Render deployment templates for tests",
            "hosts": "all",
            "gather_facts": False,
            "become": False,
            "vars_files": [str(ANSIBLE / "vars/defaults.yml")],
            "tasks": [
                {
                    "name": "Render each service kind",
                    "ansible.builtin.template": {
                        "src": str(ANSIBLE / "templates/operator.service.j2"),
                        "dest": str(cls.directory / "{{ item.kind }}.service"),
                        "mode": "0600",
                    },
                    "loop": cls.units,
                },
                {
                    "name": "Render services using an external environment file",
                    "ansible.builtin.template": {
                        "src": str(ANSIBLE / "templates/operator.service.j2"),
                        "dest": str(cls.directory / "custom-{{ item.kind }}.service"),
                        "mode": "0600",
                    },
                    "vars": {"operator_env_file": str(cls.directory / "custom.env")},
                    "loop": cls.units,
                },
                {
                    "name": "Render quoted environment values",
                    "ansible.builtin.template": {
                        "src": str(ANSIBLE / "templates/operator.env.j2"),
                        "dest": str(cls.directory / "{{ item.name }}.env"),
                        "mode": "0600",
                    },
                    "vars": {"operator_admin_password": "{{ item.password }}"},
                    "loop": [
                        {"name": name, "password": password}
                        for name, password in cls.passwords.items()
                    ],
                },
            ],
        }
        playbook = cls.directory / "render.json"
        playbook.write_text(json.dumps([play]))
        overrides = cls.directory / "overrides.json"
        overrides.write_text(
            json.dumps(
                {
                    "operator_user": "operator-test",
                    "operator_account": {"uid": os.getuid()},
                    "operator_checkout": str(REPO),
                    "operator_node_version": "26.13.1",
                }
            )
        )
        executable = Path(sys.executable).with_name("ansible-playbook")
        command = str(executable) if executable.exists() else shutil.which("ansible-playbook")
        if command is None:
            raise RuntimeError("Run these tests through uv run after uv sync --dev")
        environment = {
            **os.environ,
            "ANSIBLE_CONFIG": str(REPO / "ansible.cfg"),
            "ANSIBLE_HOME": str(cls.directory / "ansible-home"),
            "ANSIBLE_LOCAL_TEMP": str(cls.directory / "local-tmp"),
            "ANSIBLE_REMOTE_TMP": str(cls.directory / "remote-tmp"),
            "ANSIBLE_NOCOLOR": "1",
        }
        result = subprocess.run(
            [command, "-i", "localhost,", "-c", "local", str(playbook), "-e", f"@{overrides}"],
            cwd=REPO,
            env=environment,
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
        if result.returncode:
            raise RuntimeError(f"Template rendering failed:\n{result.stdout}\n{result.stderr}")

    def service_lines(self, kind):
        return (self.directory / f"{kind}.service").read_text().splitlines()

    def test_service_directives_are_separate_lines(self):
        for unit in self.units:
            kind = unit["kind"]
            with self.subTest(kind=kind):
                lines = self.service_lines(kind)
                after = "After=network-online.target"
                if kind != "controller":
                    after += " swarm-888.service"
                self.assertIn(after, lines)
                self.assertIn("[Service]", lines)
                self.assertIn("UMask=0077", lines)
                self.assertIn("KillMode=mixed", lines)
                self.assertIn("WantedBy=multi-user.target", lines)
                start = next(
                    line.removeprefix("ExecStart=")
                    for line in lines
                    if line.startswith("ExecStart=")
                )
                self.assertNotIn("UMask", start)
                arguments = shlex.split(start)
                self.assertEqual(arguments[0], "/opt/node-v26.13.1/bin/node")
                self.assertIn(f"--env-file={REPO}/.env", arguments)
                entry = "controller" if kind == "controller" else "worker"
                self.assertIn(f"{REPO}/src/{entry}.ts", arguments)

    def test_custom_environment_file_is_used_by_all_services(self):
        for unit in self.units:
            kind = unit["kind"]
            with self.subTest(kind=kind):
                lines = (self.directory / f"custom-{kind}.service").read_text().splitlines()
                arguments = shlex.split(
                    next(
                        line.removeprefix("ExecStart=")
                        for line in lines
                        if line.startswith("ExecStart=")
                    )
                )
                self.assertIn(f"--env-file={self.directory}/custom.env", arguments)
                self.assertNotIn(f"--env-file={REPO}/.env", arguments)
                self.assertIn(f"WorkingDirectory={REPO}", lines)

    def test_worker_identities_and_root_command(self):
        for unit in self.units:
            kind = unit["kind"]
            with self.subTest(kind=kind):
                lines = self.service_lines(kind)
                account = "root" if kind == "root" else "operator-test"
                self.assertIn(f"User={account}", lines)
                self.assertIn(f"Group={account}", lines)
                self.assertIn(f'Environment="APP_CONTROLLER_UID={os.getuid()}"', lines)
                mode = "root" if kind == "root" else "user"
                self.assertIn(f'Environment="APP_WORKER_MODE={mode}"', lines)
                required = "true" if kind == "root" else "false"
                self.assertIn(f'Environment="APP_REQUIRE_ROOT_WORKER={required}"', lines)
                identifier = "root" if kind == "root" else ""
                self.assertIn(f'Environment="APP_WORKER_ID={identifier}"', lines)
                start = next(
                    line.removeprefix("ExecStart=")
                    for line in lines
                    if line.startswith("ExecStart=")
                )
                arguments = shlex.split(start)
                self.assertNotIn(f"{REPO}/src/root-worker.ts", arguments)
                if kind == "root":
                    self.assertEqual(arguments[arguments.index("--id") + 1], "root")
                    self.assertEqual(arguments[arguments.index("--name") + 1], "Root worker")
                    self.assertEqual(arguments[arguments.index("--model") + 1], "gpt-6.1-sol")
                    self.assertEqual(arguments[arguments.index("--effort") + 1], "high")
                if kind != "controller":
                    self.assertEqual(arguments[-2:], ["--mode", mode])

    def test_generated_environment_round_trips_through_node(self):
        node = REPO / "node_modules/node/bin/node"
        if not node.is_file():
            self.skipTest("Install npm dependencies to check parsing with the pinned Node runtime")
        for name, password in self.passwords.items():
            with self.subTest(quoting=name):
                environment_file = self.directory / f"{name}.env"
                result = subprocess.run(
                    [
                        str(node),
                        f"--env-file={environment_file}",
                        "--input-type=module",
                        "--eval",
                        "console.log(JSON.stringify({password:process.env.ADMIN_PASSWORD,"
                        "state:process.env.APP_STATE_DIR,port:process.env.APP_PORT}))",
                    ],
                    env={
                        key: value
                        for key, value in os.environ.items()
                        if key not in {"ADMIN_PASSWORD", "APP_STATE_DIR", "APP_PORT"}
                    },
                    capture_output=True,
                    text=True,
                    timeout=10,
                    check=True,
                )
                values = json.loads(result.stdout)
                self.assertEqual(values["password"], password)
                self.assertEqual(
                    values["state"], "/home/operator-test/.local/share/vps-ai-operator"
                )
                self.assertEqual(values["port"], "3001")


class SourceFingerprintTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="operator-fingerprint-test-")
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.write("package.json", '{"name":"fixture"}')
        self.write("src/main.ts", "console.log('fixture');")

    def write(self, relative, contents):
        path = self.directory / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(contents)
        return path

    def fingerprint(self):
        return subprocess.run(
            [sys.executable, str(FINGERPRINT), str(self.directory)],
            capture_output=True,
            text=True,
            timeout=10,
            check=True,
        ).stdout.strip()

    def test_deterministic_hash(self):
        initial = self.fingerprint()
        self.assertRegex(initial, r"^[0-9a-f]{64}$")
        self.assertEqual(self.fingerprint(), initial)

    def test_source_and_build_inputs_change_hash(self):
        inputs = [
            ".nvmrc",
            "package.json",
            "package-lock.json",
            "tsconfig.json",
            "vite.config.ts",
            "index.html",
            "src/main.ts",
            "scripts/build.ts",
            "migrations/001.sql",
            "skills/test/SKILL.md",
            "web/main.tsx",
            "generated/README.md",
        ]
        for relative in inputs:
            with self.subTest(path=relative):
                previous = self.fingerprint()
                path = self.write(relative, "changed build input")
                self.assertNotEqual(self.fingerprint(), previous)
                path.unlink()

    def test_local_secrets_installed_files_and_outputs_do_not_change_hash(self):
        initial = self.fingerprint()
        for relative in [".env", "node_modules/pkg/index.js", ".git/HEAD", "dist/web/index.html"]:
            with self.subTest(path=relative):
                self.write(relative, "excluded content")
                self.assertEqual(self.fingerprint(), initial)

    def test_source_paths_and_file_removal_change_hash(self):
        initial = self.fingerprint()
        source = self.directory / "src/main.ts"
        renamed = source.with_name("renamed.ts")
        source.rename(renamed)
        renamed_hash = self.fingerprint()
        self.assertNotEqual(renamed_hash, initial)
        renamed.unlink()
        self.assertNotEqual(self.fingerprint(), renamed_hash)


if __name__ == "__main__":
    unittest.main()
