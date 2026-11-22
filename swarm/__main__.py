"""Entry point for both python -m swarm and the installed zipapp."""

import argparse
import fcntl
import os
import secrets
import shutil
import signal
import sys
from pathlib import Path

from . import shared_catalog
from .engine import Engine
from .http import Dashboard
from .store import Store


def main():
    if sys.argv[1:] == ["host-tools"]:
        from .host_tools import main as serve_host_tools

        return serve_host_tools()
    parser = argparse.ArgumentParser(prog="swarm-operator")
    parser.add_argument("command", nargs="?", choices=("serve", "url", "doctor"), default="serve")
    parser.add_argument("--data", default=os.environ.get("SWARM_DATA", ".swarm"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("SWARM_PORT", "8787")))
    parser.add_argument("--workers", type=int, default=int(os.environ.get("SWARM_WORKERS", "2")))
    parser.add_argument("--name", default=os.environ.get("SWARM_NAME", "Local operator"))
    parser.add_argument("--codex", default=os.environ.get("SWARM_CODEX", "codex"))
    parser.add_argument(
        "--catalog-dir",
        default=os.environ.get("SWARM_CATALOG_DIR"),
        help="Local checkout for the operator-wide catalog",
    )
    parser.add_argument(
        "--catalog-repo",
        default=os.environ.get("SWARM_CATALOG_REPO"),
        help="Shared catalog Git remote",
    )
    args = parser.parse_args()
    if not 1 <= args.workers <= 32 or not 0 <= args.port <= 65535:
        parser.error("use 1–32 workers and a valid port")
    os.umask(0o077)
    root = Path(args.data).expanduser().resolve()
    link = root / "access.url"
    if args.command == "doctor":
        import sqlite3

        print(f"Python {sys.version.split()[0]}\nSQLite {sqlite3.sqlite_version}")
        for tool in (args.codex, "git"):
            print(f"{tool}: {shutil.which(tool) or 'missing'}")
        return int(not all(shutil.which(tool) for tool in (args.codex, "git")))
    if args.command == "url":
        if not link.is_file():
            parser.exit(1, "Start the operator first.\n")
        print(link.read_text().strip())
        return 0
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (root / "instance.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            parser.exit(1, "Another operator is using this data directory.\n")
        store = Store(root)
        engine = Engine(store, args.workers, args.codex)
        key_file = root / "access.key"
        if not key_file.exists():
            key_file.write_text(secrets.token_urlsafe(32))
        secret = key_file.read_text().strip()
        if len(secret) < 32:
            parser.exit(1, "Invalid dashboard key file. Check its contents and permissions.\n")
        with Dashboard(("127.0.0.1", args.port), store, engine, secret, args.name) as server:
            shared_catalog.configure(store, args.catalog_dir, args.catalog_repo)
            url = f"http://127.0.0.1:{server.server_port}/#token={secret}"
            link.write_text(url + "\n")
            print(
                f"Swarm 888 · {args.name} · {args.workers} workers\nhttp://127.0.0.1:{server.server_port}",
                flush=True,
            )
            if sys.stdout.isatty():
                print("Dashboard access:", url, flush=True)
            else:
                print("Private dashboard link in", link, flush=True)
            stop = False

            def shutdown(*_):
                nonlocal stop
                stop = True

            signal.signal(signal.SIGTERM, shutdown)
            signal.signal(signal.SIGINT, shutdown)
            server.timeout = 0.25
            engine.start()
            try:
                while not stop:
                    server.handle_request()
            finally:
                engine.stop()
                link.unlink(missing_ok=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
