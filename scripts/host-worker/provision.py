#!/usr/bin/python3
"""Enroll the local systemd deployment worker during trusted machine provisioning."""

import argparse
import hashlib
import json
import os
import pwd
import re
import stat
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.request import urlopen

HERE = Path(__file__).resolve().parent
BASE = Path("/opt/swarm-888-host")
UNITS = Path("/etc/systemd/system")
MARKER = "# Managed by Swarm 888 host worker\n"
SOCKET = "swarm-888-host.socket"
SOCKET_PATH = Path("/run/swarm-888-host.sock")
SERVICE = "swarm-888-host@.service"


def payload(manifest, catalog=None):
    if not re.fullmatch(r"[a-f0-9]{40}", manifest["revision"]):
        raise ValueError("Invalid pinned catalog revision")
    result = {}
    for relative, expected in manifest["files"].items():
        path = Path(relative)
        if (
            path.is_absolute()
            or ".." in path.parts
            or path.parts[:2] not in (("projects", "local-nomad"), ("connectors", "local-nomad"))
        ):
            raise ValueError("Unexpected catalog payload path")
        url = f"https://raw.githubusercontent.com/karstenjakobsen/packages-888/{manifest['revision']}/{relative}"
        source = (catalog / path).open("rb") if catalog else urlopen(url, timeout=40)
        with source:
            data = source.read(1024 * 1024 + 1)
        if len(data) > 1024 * 1024 or hashlib.sha256(data).hexdigest() != expected:
            raise ValueError("Catalog file does not match the pinned release: " + relative)
        result[path] = data
    return result


def unit_contents(user):
    return {
        SERVICE: MARKER
        + """[Unit]
Description=Swarm 888 local Nomad deployment request

[Service]
Type=exec
User=root
ExecStart=/usr/bin/python3 -I -B /opt/swarm-888-host/current/worker.py
StandardInput=socket
StandardOutput=socket
StandardError=journal
UMask=0077
NoNewPrivileges=yes
PrivateTmp=yes
TimeoutStopSec=15
RuntimeMaxSec=20min
""",
        SOCKET: MARKER
        + f"""[Unit]
Description=Swarm 888 operator deployment socket

[Socket]
ListenStream={SOCKET_PATH}
SocketUser={user}
SocketMode=0600
Accept=yes
MaxConnections=32
RemoveOnStop=yes

[Install]
WantedBy=sockets.target
""",
    }


def regular_destination(path):
    try:
        entry = path.lstat()
    except FileNotFoundError:
        return
    if (
        not stat.S_ISREG(entry.st_mode)
        or entry.st_uid != os.geteuid()
        or entry.st_mode & 0o022
        or not path.read_text().startswith(MARKER)
    ):
        raise ValueError("Refusing to replace an unmanaged unit: " + str(path))


def install(user, catalog):
    if os.geteuid() != 0:
        raise PermissionError(
            "Initial enrollment must be performed by the host provisioner as root"
        )
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_-]{0,63}", user):
        raise ValueError("Invalid operator service account name")
    uid = pwd.getpwnam(user).pw_uid
    if uid == 0:
        raise ValueError("Select the existing unprivileged operator service account")
    manifest = json.loads((HERE.parents[1] / "swarm" / "host_catalog.json").read_text())
    files = payload(manifest, catalog)
    units = unit_contents(user)
    for filename in units:
        regular_destination(UNITS / filename)
    os.umask(0o022)
    BASE.mkdir(mode=0o755, exist_ok=True)
    if (
        BASE.is_symlink()
        or not BASE.is_dir()
        or BASE.stat().st_uid != 0
        or BASE.stat().st_mode & 0o022
    ):
        raise ValueError("Deployment worker directory must be root-owned")
    contents = {Path("catalog") / name: value for name, value in files.items()}
    contents[Path("worker.py")] = (HERE / "worker.py").read_bytes()
    contents[Path("principal")] = user.encode()
    digest = hashlib.sha256()
    for path, data in sorted(contents.items()):
        digest.update(str(path).encode() + b"\0" + hashlib.sha256(data).digest())
    target = BASE / ("release-" + digest.hexdigest()[:24])
    with tempfile.TemporaryDirectory(dir=BASE, prefix=".enroll-") as tmp:
        tmp = Path(tmp)
        if not target.exists():
            stage = tmp / "release"
            for rel, data in contents.items():
                out = stage / rel
                out.parent.mkdir(parents=True, exist_ok=True)
                out.write_bytes(data)
            stage.rename(target)
        link = tmp / "current"
        link.symlink_to(target.name)
        link.replace(BASE / "current")
    changed = False
    for name, value in units.items():
        dest = UNITS / name
        if dest.exists() and dest.read_text() == value:
            continue
        with tempfile.NamedTemporaryFile(dir=UNITS, delete=False) as f:
            tmpfile = Path(f.name)
            try:
                f.write(value.encode())
                f.flush()
                os.fchmod(f.fileno(), 0o644)
                tmpfile.replace(dest)
            finally:
                tmpfile.unlink(missing_ok=True)
        changed = True
    subprocess.run(["/usr/bin/systemctl", "daemon-reload"], check=True)
    subprocess.run(["/usr/bin/systemctl", "enable", SOCKET], check=True)
    # A previous enrollment may have written the units but stopped before rebinding the socket.
    try:
        bound = SOCKET_PATH.lstat()
        rebind = bound.st_uid != uid or bound.st_mode != (stat.S_IFSOCK | 0o600)
    except FileNotFoundError:
        rebind = True
    subprocess.run(
        ["/usr/bin/systemctl", "restart" if changed or rebind else "start", SOCKET], check=True
    )
    print(f"Deployment worker is available to {user} on {SOCKET_PATH}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--user", required=True)
    parser.add_argument(
        "--catalog", type=Path, help="Read the same hash-pinned files from a local checkout"
    )
    args = parser.parse_args()
    try:
        install(args.user, args.catalog)
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as exc:
        sys.exit(str(exc))
