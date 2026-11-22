import asyncio
import hashlib
import importlib.util
import io
import json
import socket
import subprocess
import sys
import tempfile
import threading
import tomllib
import unittest
from pathlib import Path
from unittest.mock import patch

from swarm import codex, host_tools, shared_catalog
from swarm.store import Store

ROOT = Path(__file__).resolve().parents[1]


def load_script(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


provision = load_script("provision", "scripts/host-worker/provision.py")
worker = load_script("worker", "scripts/host-worker/worker.py")


class HostWorkerTest(unittest.TestCase):
    def test_dependencies_follow_observed_docker_runtime(self):
        observed = {
            "platform": "wsl2",
            "architecture": "x86_64",
            "systemd": {"ready": True, "docker_unit_load": "not-found"},
            "cgroups": {"ready": True},
            "docker": {"daemon": "reachable", "socket": "present"},
        }
        with (
            patch.object(worker, "environment", side_effect=lambda: json.dumps(observed)),
            patch.object(worker.shutil, "which", return_value="/usr/bin/gpg"),
            patch.object(worker, "command") as command,
        ):
            worker.ensure_dependencies()
            command.assert_not_called()
            observed["docker"] = {"daemon": "unreachable", "socket": "missing"}
            with self.assertRaisesRegex(RuntimeError, "Docker Desktop integration"):
                worker.ensure_dependencies()
            command.assert_not_called()
            observed["platform"] = "native-linux"
            with patch.object(Path, "is_file", return_value=True):
                worker.ensure_dependencies()
            self.assertEqual(command.call_args_list[1].args[0][-1], "docker.io")
            self.assertEqual(command.call_args_list[2].args[0][-1], "docker.service")

    def test_only_fixed_host_actions(self):
        for data in (
            b'{"action":"shell"}\n',
            b'{"action":"start","unit":"other"}\n',
            b"{}",
            b"x" * 513,
            b'{"action":{}}\n',
        ):
            with self.subTest(data=data), patch.object(worker, "execute") as execute:
                dest = io.BytesIO()
                worker.serve(io.BytesIO(data), dest)
                self.assertFalse(json.loads(dest.getvalue())["ok"])
                execute.assert_not_called()

    def test_service_refuses_unmanaged_unit(self):
        with tempfile.TemporaryDirectory() as tmp:
            principal = Path(tmp) / "principal"
            principal.write_text("nobody")
            with (
                patch.object(worker, "RELEASE", Path(tmp)),
                patch.object(worker, "owns_unit", return_value=False),
                patch.object(worker, "command") as command,
            ):
                with self.assertRaisesRegex(RuntimeError, "definition differs"):
                    worker.execute("restart")
                command.assert_not_called()

    def test_adapter_reaches_private_socket_and_reports_result(self):
        with tempfile.TemporaryDirectory() as tmp, socket.socket(socket.AF_UNIX) as listener:
            name = str(Path(tmp) / "deployment.sock")
            listener.bind(name)
            listener.listen(1)
            received = []

            def handle():
                conn, _ = listener.accept()
                with conn, conn.makefile("rb") as reader:
                    received.append(json.loads(reader.readline()))
                    conn.sendall(b'{"ok":true,"message":"active"}\n')

            thread = threading.Thread(target=handle, daemon=True)
            thread.start()
            with patch.object(host_tools, "SOCKET", name):
                self.assertEqual(host_tools.service({"action": "status"}), "active")
            thread.join(2)
            self.assertEqual(received, [{"action": "status"}])
            with patch.object(host_tools, "SOCKET", str(Path(tmp) / "absent")):
                with self.assertRaisesRegex(FileNotFoundError, "has not been provisioned"):
                    host_tools.service({"action": "install"})

    def test_batch_inputs(self):
        for args in (
            {"action": "ready", "name": "job"},
            {"action": "start"},
            {"action": "plan", "name": "../host", "source": "pass"},
            {"action": "submit", "name": "batch", "file": "/etc/shadow"},
        ):
            with self.assertRaises(ValueError):
                host_tools.batch(args)

    def test_batch_source_passes_only_on_stdin(self):
        with tempfile.TemporaryDirectory() as tmp:
            connector = Path(tmp) / "batch.py"
            connector.write_text(
                "import json, sys\nprint(json.dumps([sys.argv[1:], sys.stdin.read()]))\n"
            )
            with patch.object(host_tools, "CONNECTOR", connector):
                source = "print('λ')\n"
                result = host_tools.batch({"action": "plan", "name": "example", "source": source})
                self.assertEqual(json.loads(result), [["plan", "example", "-"], source])
                result = host_tools.batch({"action": "logs", "name": "example", "stream": "stderr"})
                self.assertEqual(json.loads(result)[0], ["logs", "example", "--stream", "stderr"])

    def test_source_and_installed_zipapp_mcp_entrypoints(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / "operator.pyz"
            subprocess.run(
                [sys.executable, ROOT / "scripts/build.py", "--output", archive], check=True
            )
            zipped = subprocess.check_output(
                [
                    sys.executable,
                    "-I",
                    "-c",
                    "import json,sys; sys.path.insert(0,sys.argv[1]); from swarm.codex import host_tool_config; print(json.dumps(host_tool_config()))",
                    archive,
                ],
                text=True,
                cwd=tmp,
            )
            for config in (codex.host_tool_config(), json.loads(zipped)):
                options = tomllib.loads(config[1])["mcp_servers"]["swarm_host"]
                request = {"id": 1, "method": "tools/list", "jsonrpc": "2.0"}
                output = subprocess.check_output(
                    [options["command"], *options["args"]],
                    input=json.dumps(request) + "\n",
                    text=True,
                    cwd=options["cwd"],
                )
                names = [t["name"] for t in json.loads(output)["result"]["tools"]]
                self.assertEqual(names, ["nomad_service", "nomad_batch"])

    def test_tools_offered_only_to_owner_workspaces(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = Store(Path(tmp))
            shared_catalog.configure(store)
            peer = store.peer_project(store.invite("peer"))
            for project, allowed in (
                ("inbox", True),
                (shared_catalog.PROJECT, False),
                (peer, False),
            ):
                job = {"project": project}
                with patch(
                    "swarm.codex.asyncio.create_subprocess_exec", side_effect=ValueError("stopped")
                ) as spawn:
                    with self.assertRaisesRegex(ValueError, "stopped"):
                        asyncio.run(codex.run(store, job, "codex"))
                    self.assertEqual("-c" in spawn.call_args.args, allowed)

    def test_enrollment_refuses_tampered_catalog(self):
        with tempfile.TemporaryDirectory() as tmp:
            catalog = Path(tmp)
            name = "projects/local-nomad/install.py"
            path = catalog / name
            path.parent.mkdir(parents=True)
            path.write_bytes(b"vetted")
            manifest = {
                "revision": "a" * 40,
                "files": {name: hashlib.sha256(b"vetted").hexdigest()},
            }
            self.assertEqual(provision.payload(manifest, catalog), {Path(name): b"vetted"})
            path.write_bytes(b"modified")
            with self.assertRaisesRegex(ValueError, "does not match"):
                provision.payload(manifest, catalog)

    def test_pre_enrollment_probe_uses_approved_revision_after_catalog_edits(self):
        with tempfile.TemporaryDirectory() as tmp:
            catalog = Path(tmp)
            name = "connectors/local-nomad/batch.py"
            source = catalog / name
            source.parent.mkdir(parents=True)
            data = b'print("observed native-linux")\n'
            source.write_bytes(data)
            subprocess.run(["git", "init", "-q", tmp], check=True)
            subprocess.run(["git", "-C", tmp, "add", name], check=True)
            subprocess.run(
                [
                    "git",
                    "-C",
                    tmp,
                    "-c",
                    "user.name=test",
                    "-c",
                    "user.email=test@local",
                    "commit",
                    "-qm",
                    "tested probe",
                ],
                check=True,
            )
            ref = subprocess.check_output(
                ["git", "-C", tmp, "rev-parse", "HEAD"], text=True
            ).strip()
            pin = {"revision": ref, "files": {name: hashlib.sha256(data).hexdigest()}}
            (catalog / "host_catalog.json").write_text(json.dumps(pin))
            source.write_bytes(b'raise RuntimeError("Unapproved checkout change")\n')
            with (
                patch.object(host_tools, "host_request", side_effect=FileNotFoundError),
                patch.object(host_tools, "files", return_value=catalog),
                patch.dict("os.environ", SWARM_NOMAD_CATALOG=tmp),
            ):
                self.assertEqual(
                    host_tools.batch({"action": "environment"}), "observed native-linux"
                )
                with self.assertRaises(ValueError):
                    host_tools.batch({"action": "environment", "name": "extra"})
