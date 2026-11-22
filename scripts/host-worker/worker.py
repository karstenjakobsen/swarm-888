#!/usr/bin/python3
"""Systemd socket-activated root worker for the local, pinned Nomad deployment."""

import fcntl
import json
import os
import pwd
import shutil
import subprocess
import sys
from pathlib import Path

RELEASE = Path(__file__).resolve().parent
PROJECT = RELEASE / "catalog/projects/local-nomad"
UNIT = "catalog-nomad.service"
ENV = {
    "PATH": "/usr/sbin:/usr/bin:/sbin:/bin",
    "HOME": "/root",
    "LANG": "C",
    "DEBIAN_FRONTEND": "noninteractive",
}
ACTIONS = {"check", "install", "start", "restart", "stop", "status", "environment"}


def command(args, timeout=600):
    process = subprocess.run(
        args,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        errors="replace",
        cwd="/",
        env=ENV,
        timeout=timeout,
    )
    if process.returncode:
        # This reviewed installer emits short public diagnostics. Keep apt and systemctl logs local.
        if len(args) > 3 and args[2] == str(PROJECT / "install.py"):
            detail = process.stdout.strip().splitlines()
            if detail:
                raise RuntimeError(detail[-1][:500])
        raise RuntimeError(f"{Path(str(args[0])).name} exited with status {process.returncode}")
    return process.stdout.strip()


def environment():
    connector = RELEASE / "catalog/connectors/local-nomad/batch.py"
    return command(["/usr/bin/python3", "-ISB", str(connector), "environment"], 30)


def ensure_dependencies():
    facts = json.loads(environment())
    host = facts["platform"]
    if host == "wsl1":
        raise RuntimeError("WSL1 cannot run this Nomad client. Use WSL2 with systemd.")
    if host not in ("wsl2", "wsl", "native-linux") or facts["architecture"] != "x86_64":
        raise RuntimeError("The pinned Nomad release requires x86-64 Linux")
    manager, docker = facts["systemd"], facts["docker"]
    if not manager["ready"] or not facts["cgroups"]["ready"]:
        raise RuntimeError(
            "Nomad requires a reachable systemd manager and the required cgroup v2 controllers"
        )
    missing = [] if shutil.which("gpg", path=ENV["PATH"]) else ["gnupg"]
    needs_docker = docker["daemon"] != "reachable"
    if needs_docker:
        if docker["socket"] != "missing":
            raise RuntimeError("The existing Docker socket is " + docker["daemon"])
        if manager["docker_unit_load"] == "not-found":
            if host != "native-linux":
                raise RuntimeError(
                    "No local Docker socket or native Docker unit in WSL. Start the configured engine or enable Docker Desktop integration for this distribution."
                )
            missing.append("docker.io")
        elif manager["docker_unit_load"] != "loaded":
            raise RuntimeError("The native Docker unit is " + str(manager["docker_unit_load"]))
    if missing:
        if not Path("/usr/bin/apt-get").is_file():
            raise RuntimeError("This host needs the system packages " + ", ".join(missing))
        command(["/usr/bin/apt-get", "update"])
        command(["/usr/bin/apt-get", "install", "-y", "--no-install-recommends", *missing])
    if needs_docker:
        command(["/usr/bin/systemctl", "--no-ask-password", "enable", "--now", "docker.service"])


def owns_unit():
    fragment = command(["/usr/bin/systemctl", "show", UNIT, "--property=FragmentPath", "--value"])
    drops = command(["/usr/bin/systemctl", "show", UNIT, "--property=DropInPaths", "--value"])
    expected = Path("/etc/systemd/system") / UNIT
    if fragment != str(expected) or drops or expected.is_symlink() or not expected.is_file():
        return False
    mode = expected.stat()
    return (
        mode.st_uid == 0
        and not mode.st_mode & 0o022
        and expected.read_bytes() == (PROJECT / UNIT).read_bytes()
    )


def execute(action):
    if action not in ACTIONS:
        raise ValueError("Unknown host operation")
    if action == "environment":
        return environment()
    principal = (RELEASE / "principal").read_text().strip()
    if pwd.getpwnam(principal).pw_uid == 0:
        raise ValueError("Missing unprivileged operator identity")
    if action == "status":
        return command(
            [
                "/usr/bin/systemctl",
                "show",
                UNIT,
                "-p",
                "LoadState,ActiveState,SubState,Result,ExecMainStatus,NRestarts",
            ],
            20,
        )
    if action in ("check", "install"):
        if action == "install":
            ensure_dependencies()
        return command(
            [
                "/usr/bin/python3",
                "-ISB",
                str(PROJECT / "install.py"),
                action,
                "--operator",
                principal,
            ],
            900,
        )
    if not owns_unit():
        raise RuntimeError("The managed Nomad unit is absent or its definition differs")
    command(["/usr/bin/systemctl", action, UNIT], 150)
    return command(["/usr/bin/systemctl", "show", UNIT, "-p", "ActiveState,SubState"], 20)


def serve(source, dest):
    try:
        payload = source.readline(513)
        if len(payload) > 512 or not payload.endswith(b"\n"):
            raise ValueError("Invalid request framing")
        data = json.loads(payload)
        if not isinstance(data, dict) or set(data) != {"action"} or data["action"] not in ACTIONS:
            raise ValueError("Invalid deployment request")
        # Read-only observations can proceed while one slot is installing.
        if data["action"] in ("environment", "status"):
            message = execute(data["action"])
        else:
            with open("/run/swarm-888-host.lock", "a") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                message = execute(data["action"])
        response = {"ok": True, "message": message[:4000]}
    except (
        ValueError,
        TypeError,
        RuntimeError,
        KeyError,
        OSError,
        subprocess.TimeoutExpired,
    ) as exc:
        response = {"ok": False, "message": str(exc)[:1000]}
    dest.write(json.dumps(response).encode() + b"\n")
    dest.flush()


if __name__ == "__main__":
    if os.geteuid() != 0:
        sys.exit("The deployment worker requires systemd root activation")
    os.umask(0o077)
    serve(sys.stdin.buffer, sys.stdout.buffer)
