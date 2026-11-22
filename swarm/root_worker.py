"""Optional Linux fixture worker. The privileged parent uses only the standard library.

Run this file with python -I -S. Drop all privilege before importing the application
or using the development environment. The inherited socket carries small JSON packets.
"""

import argparse
import json
import os
import pwd
import re
import signal
import socket
import stat
import sys
from pathlib import Path

MODES = {"400", "440", "444", "600", "640", "644", "660"}


def fixture_action(
    directory: int, owner: int, resource: str, expected: str | None = None, mode: str | None = None
) -> str:
    if not re.fullmatch("[a-z][a-z0-9-]{0,47}", resource) or mode is not None and mode not in MODES:
        raise ValueError("Invalid fixture request")
    # O_PATH inspects the inode without opening devices, FIFOs or file contents.
    fd = os.open(resource, os.O_PATH | os.O_NOFOLLOW, dir_fd=directory)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != owner:
            raise ValueError("Expected a single-link regular file owned by the operator")
        actual = format(stat.S_IMODE(info.st_mode), "03o")
        if mode is not None and actual == expected:
            # Reopen the pinned inode instead of resolving the user-controlled path again.
            handle = os.open(f"/proc/self/fd/{fd}", os.O_RDONLY | os.O_NONBLOCK)
            try:
                os.fchmod(handle, int(mode, 8))
            finally:
                os.close(handle)
        return actual
    finally:
        os.close(fd)


class FixtureWorker:
    def __init__(self, root: Path, fd: int | None = None):
        self.root = root
        self.channel = (
            socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET, fileno=fd)
            if fd is not None
            else None
        )
        self.uid = self.request({"op": "identity"}) if self.channel else os.geteuid()

    def request(self, request: dict):
        self.channel.sendall(json.dumps(request).encode())
        reply = json.loads(self.channel.recv(4096))
        if "error" in reply:
            raise ValueError(reply["error"])
        return reply["result"]

    def apply(self, resource: str, expected: str | None = None, mode: str | None = None) -> str:
        if self.channel:
            return self.request(
                {"op": "fixture", "resource": resource, "expected": expected, "mode": mode}
            )
        directory = os.open(self.root, os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            return fixture_action(directory, os.getuid(), resource, expected, mode)
        finally:
            os.close(directory)


def broker(channel: socket.socket, state: int, owner: int) -> None:
    directory = None
    try:
        while packet := channel.recv(4096):
            try:
                request = json.loads(packet)
                op = request.pop("op")
                if op == "identity":
                    result = os.geteuid()
                elif op == "fixture":
                    if directory is None:
                        directory = os.open(
                            "fixtures", os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=state
                        )
                        if os.fstat(directory).st_uid != owner:
                            os.close(directory)
                            directory = None
                            raise ValueError("Fixture directory owner mismatch")
                    result = fixture_action(directory, owner, **request)
                else:
                    raise ValueError("Unknown fixture operation")
                reply = {"result": result}
            except (OSError, ValueError, TypeError, KeyError) as exc:
                reply = {"error": str(exc)[:200]}
            channel.sendall(json.dumps(reply).encode())
    finally:
        if directory is not None:
            os.close(directory)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--owner", required=True)
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--user-path", required=True)
    args = parser.parse_args()
    account = pwd.getpwnam(args.owner)
    if os.getuid() != 0 or account.pw_uid == 0 or not sys.flags.isolated or not sys.flags.no_site:
        raise SystemExit("Use sudo with python -I -S and a non-root owner")
    state = os.open(args.state, os.O_DIRECTORY | os.O_NOFOLLOW)
    info = os.fstat(state)
    if info.st_uid != account.pw_uid or info.st_mode & 0o077:
        raise SystemExit("Prepare a private state directory as the owner first")
    parent, child = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
    pid = os.fork()
    if pid == 0:
        parent.close()
        os.close(state)
        try:
            os.initgroups(account.pw_name, account.pw_gid)
            os.setresgid(account.pw_gid, account.pw_gid, account.pw_gid)
            os.setresuid(account.pw_uid, account.pw_uid, account.pw_uid)
            child.set_inheritable(True)
            os.chdir(Path(__file__).resolve().parent.parent)
            env = {k: v for k, v in os.environ.items() if k.startswith("SWARM_")}
            env.update(
                HOME=account.pw_dir,
                USER=account.pw_name,
                PATH=args.user_path,
                SWARM_STATE=str(args.state.resolve()),
                SWARM_FIXTURE_FD=str(child.fileno()),
            )
            os.execve(sys.executable, [sys.executable, "-m", "swarm", "worker"], env)
        finally:
            os._exit(1)
    child.close()

    def terminate(_signum, _frame):
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass

    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, terminate)
    try:
        broker(parent, state, account.pw_uid)
    finally:
        parent.close()
        os.close(state)
        terminate(0, None)
        _, status = os.waitpid(pid, 0)
    sys.exit(os.waitstatus_to_exitcode(status))


if __name__ == "__main__":
    main()
