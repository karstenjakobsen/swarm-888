"""Trusted stdio MCP adapter for the enrolled local deployment worker and batch connector."""

import hashlib
import json
import os
import re
import socket
import subprocess
import sys
import tempfile
from importlib.resources import files
from pathlib import Path

SOCKET = "/run/swarm-888-host.sock"
CONNECTOR = Path("/opt/swarm-888-host/current/catalog/connectors/local-nomad/batch.py")
SERVICE_ACTIONS = ["status", "check", "install", "start", "stop", "restart"]
BATCH_ACTIONS = ["environment", "ready", "plan", "submit", "status", "wait", "logs", "cleanup"]
TOOLS = [
    {
        "name": "nomad_service",
        "description": "Manage this host's single-node Nomad systemd deployment. Install reconciles packages, generated credentials, and service readiness. Other service actions affect only this deployment.",
        "inputSchema": {
            "type": "object",
            "properties": {"action": {"type": "string", "enum": SERVICE_ACTIONS}},
            "required": ["action"],
            "additionalProperties": False,
        },
    },
    {
        "name": "nomad_batch",
        "description": "Inspect the host platform and Docker runtime with environment before installation. Use ready, plan, submit, status, wait, logs, and cleanup for Python batch jobs. Supply Python source text for plan and submit.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": BATCH_ACTIONS},
                "name": {"type": "string", "pattern": "^[a-z][a-z0-9-]{0,47}$"},
                "source": {"type": "string", "maxLength": 49152},
                "stream": {"type": "string", "enum": ["stdout", "stderr"]},
            },
            "required": ["action"],
            "additionalProperties": False,
        },
    },
]


def host_request(args):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.settimeout(1000)
        try:
            sock.connect(SOCKET)
        except FileNotFoundError:
            raise FileNotFoundError(
                "The local root deployment worker has not been provisioned. System installations enroll it at first boot."
            ) from None
        sock.sendall(json.dumps(args).encode() + b"\n")
        with sock.makefile("rb") as reader:
            response = json.loads(reader.readline(16000))
    if not response["ok"]:
        raise RuntimeError(response["message"])
    return response["message"]


def service(args):
    if set(args) != {"action"} or args["action"] not in SERVICE_ACTIONS:
        raise ValueError("Unknown Nomad deployment operation")
    return host_request(args)


def environment():
    try:
        return host_request({"action": "environment"})
    except FileNotFoundError, ConnectionRefusedError:
        pass
    # A user-only installation can run the credential-free probe before host enrollment.
    # Snapshot only checksum-pinned Python modules, so edits to a shared checkout cannot
    # change what runs outside an individual Codex workspace.
    directory = os.environ.get("SWARM_NOMAD_CATALOG")
    if not directory:
        raise RuntimeError("Sync the shared catalog to inspect an unenrolled host")
    resource = files("swarm") if __package__ else Path(__file__).parent
    manifest = json.loads((resource / "host_catalog.json").read_text())
    with tempfile.TemporaryDirectory(prefix="swarm-nomad-environment-") as tmp:
        for name, expected in manifest["files"].items():
            rel = Path(name)
            if rel.parent != Path("connectors/local-nomad") or rel.suffix != ".py":
                continue
            blob = subprocess.run(
                [
                    "/usr/bin/git",
                    "--no-replace-objects",
                    "-C",
                    directory,
                    "cat-file",
                    "blob",
                    manifest["revision"] + ":" + name,
                ],
                stdin=subprocess.DEVNULL,
                capture_output=True,
                timeout=10,
                cwd="/",
                env={
                    "PATH": "/usr/bin:/bin",
                    "GIT_CONFIG_NOSYSTEM": "1",
                    "GIT_CONFIG_GLOBAL": "/dev/null",
                },
            )
            if blob.returncode:
                raise RuntimeError(
                    "The checkout needs the pinned Nomad catalog revision " + manifest["revision"]
                )
            data = blob.stdout
            if hashlib.sha256(data).hexdigest() != expected:
                raise ValueError("Host probe does not match the operator release pin")
            (Path(tmp) / rel.name).write_bytes(data)
        probe = subprocess.run(
            ["/usr/bin/python3", "-ISB", str(Path(tmp) / "batch.py"), "environment"],
            capture_output=True,
            text=True,
            cwd=tmp,
            timeout=30,
            env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8"},
        )
        if probe.returncode:
            raise RuntimeError(probe.stderr.strip()[:1000] or "Host environment probe failed")
        return probe.stdout.strip()


def batch(args):
    action = args.get("action")
    if action not in BATCH_ACTIONS:
        raise ValueError("Unknown batch operation")
    if action == "environment":
        if set(args) != {"action"}:
            raise ValueError("Environment detection takes no additional arguments")
        return environment()
    keys = {"action"}
    params = [action]
    if action != "ready":
        keys.add("name")
        name = args.get("name")
        if not isinstance(name, str) or not re.fullmatch(r"[a-z][a-z0-9-]{0,47}", name):
            raise ValueError("Invalid job name")
        params.append(name)
    if action in ("plan", "submit"):
        keys.add("source")
    if action == "logs" and "stream" in args:
        keys.add("stream")
        if args["stream"] not in ("stdout", "stderr"):
            raise ValueError("Expected stdout or stderr")
        params.extend(["--stream", args["stream"]])
    if set(args) != keys:
        raise ValueError("Incorrect arguments for " + action)
    source = ""
    if "source" in keys:
        source = args["source"]
        if not isinstance(source, str) or not 0 < len(source.encode()) <= 49152:
            raise ValueError("Expected 1–49152 bytes of Python source")
        params.append("-")
    if not CONNECTOR.is_file():
        raise RuntimeError("The local Nomad connector has not been provisioned")
    p = subprocess.run(
        ["/usr/bin/python3", "-ISB", str(CONNECTOR), *params],
        input=source.encode("utf-8"),
        capture_output=True,
        timeout=240,
        cwd="/",
        env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
    )
    output = p.stdout.decode("utf-8", errors="replace")
    if p.returncode:
        detail = p.stderr.decode("utf-8", errors="replace").strip()
        if not detail and action == "plan":
            # The batch CLI prints the plan, including placement failures, on stdout.
            detail = output.strip()
        raise RuntimeError(detail[:2000] or f"Connector exited with status {p.returncode}")
    result = output if action == "logs" else output.rstrip()
    return result[:64000] + ("\n[Output truncated]" if len(result) > 64000 else "")


def handle(request):
    method = request.get("method")
    if method == "initialize":
        proposed = request.get("params", {}).get("protocolVersion")
        version = (
            proposed
            if proposed in ("2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25")
            else "2025-06-18"
        )
        return {
            "protocolVersion": version,
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "swarm-local-host", "version": "1"},
        }
    if method == "tools/list":
        return {"tools": TOOLS}
    if method == "ping":
        return {}
    if method == "tools/call":
        p = request.get("params", {})
        tools = {"nomad_service": service, "nomad_batch": batch}
        name, arguments = p.get("name"), p.get("arguments")
        if not isinstance(name, str) or name not in tools or not isinstance(arguments, dict):
            raise ValueError("Unknown deployment tool or invalid arguments")
        try:
            output = tools[name](arguments)
            return {"content": [{"type": "text", "text": output}]}
        except (
            KeyError,
            ValueError,
            TypeError,
            RuntimeError,
            OSError,
            subprocess.TimeoutExpired,
        ) as exc:
            return {"isError": True, "content": [{"type": "text", "text": str(exc)}]}
    raise KeyError(method)


def main():
    os.umask(0o077)
    for line in sys.stdin.buffer:
        ident = None
        try:
            msg = json.loads(line)
            if (
                not isinstance(msg, dict)
                or msg.get("jsonrpc") != "2.0"
                or not isinstance(msg.get("method"), str)
            ):
                raise TypeError("Invalid request")
            if "id" not in msg:
                continue
            ident = msg.get("id")
            if type(ident) not in (str, int):
                ident = None
                raise TypeError("Invalid request ID")
            if not isinstance(msg.get("params", {}), dict):
                raise ValueError("Expected named parameters")
            response = {"result": handle(msg)}
        except json.JSONDecodeError, UnicodeDecodeError, RecursionError:
            response = {"error": {"code": -32700, "message": "Invalid JSON"}}
        except TypeError as exc:
            response = {"error": {"code": -32600, "message": str(exc)}}
        except KeyError:
            response = {"error": {"code": -32601, "message": "Unknown method"}}
        except ValueError as exc:
            response = {"error": {"code": -32602, "message": str(exc)}}
        print(json.dumps({"jsonrpc": "2.0", "id": ident, **response}), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
