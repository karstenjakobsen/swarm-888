import argparse
import json
import os
import sqlite3
import tarfile
import tempfile
from contextlib import closing, nullcontext
from pathlib import Path

from .catalog import Catalog, run_git
from .config import Settings
from .state import State

STATE_FILES = (
    "owner.key",
    "catalog.json",
    "connector-bindings.json",
    "skill-dependencies.json",
    "fixture-engine.json",
)
STATE_DIRECTORIES = ("revisions", "workspaces", "secrets", "defense")
DATABASE = "operator.sqlite3"
BUNDLE = "catalog.bundle"


def safe_entry(entry: tarfile.TarInfo) -> tarfile.TarInfo:
    if not entry.isdir() and not entry.isfile():
        raise ValueError(f"Backup entry must be a regular file or directory: {entry.name}")
    return entry.replace(uid=0, gid=0, uname="", gname="", mode=entry.mode & 0o700, deep=False)


def export(settings: Settings, destination: Path) -> None:
    destination = destination.resolve()
    if destination.exists() or destination.is_relative_to(settings.directory):
        raise ValueError("Choose a new archive outside the source state directory")
    if not (settings.directory / DATABASE).is_file():
        raise ValueError("The source state has no initialized database")
    catalog = Catalog.load(settings) if settings.catalog_config.is_file() else None
    with (
        settings.service_lock("worker"),
        settings.service_lock("controller"),
        catalog.locked() if catalog else nullcontext(),
        tempfile.TemporaryDirectory(dir=destination.parent) as staging,
    ):
        work = Path(staging)
        with (
            closing(sqlite3.connect(settings.directory / DATABASE)) as source,
            closing(sqlite3.connect(work / DATABASE)) as snapshot,
        ):
            source.backup(snapshot)
        if catalog and catalog.checkout.is_dir():
            if catalog.git("status", "--porcelain"):
                raise ValueError("Commit or stash catalog edits before exporting")
            catalog.git("bundle", "create", str(work / BUNDLE), "--all")
        archive_path = work / "operator.tar.gz"
        with tarfile.open(archive_path, mode="w:gz") as archive:
            for name in (DATABASE, BUNDLE):
                if (work / name).is_file():
                    archive.add(work / name, arcname=name, filter=safe_entry)
            for name in (*STATE_FILES, *STATE_DIRECTORIES):
                if (settings.directory / name).exists():
                    archive.add(settings.directory / name, arcname=name, filter=safe_entry)
        archive_path.chmod(0o600)
        os.link(archive_path, destination)


def extract(archive: tarfile.TarFile, directory: Path) -> None:
    names = {DATABASE, BUNDLE, *STATE_FILES, *STATE_DIRECTORIES}
    seen = set()
    for entry in archive:
        parts = Path(entry.name).parts
        if (
            not parts
            or parts[0] not in names
            or ".." in parts
            or entry.name in seen
            or (parts[0] not in STATE_DIRECTORIES and len(parts) != 1)
        ):
            raise ValueError(f"Unexpected backup entry: {entry.name}")
        seen.add(entry.name)
        archive.extract(safe_entry(entry), directory, filter="data")


def restore(settings: Settings, source: Path, checkout: Path | None = None) -> None:
    target = settings.directory
    if target.exists():
        raise ValueError("Restore into a fresh state directory")
    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=target.parent) as staging:
        work = Path(staging) / "state"
        work.mkdir(mode=0o700)
        with tarfile.open(source, mode="r:gz") as archive:
            extract(archive, work)
        if not (work / DATABASE).is_file():
            raise ValueError("Backup does not contain the operator database")
        staged = Settings(work)
        staged.read_owner_key()
        state = State(staged)
        with state.transaction(write=True) as db:
            if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise ValueError("Backup database failed integrity checking")
            db.execute("DELETE FROM sessions")
        bundle = work / BUNDLE
        if checkout:
            if checkout.exists() or checkout.resolve().is_relative_to(target):
                raise ValueError("Choose a new catalog checkout outside the state directory")
            if not bundle.is_file():
                raise ValueError("Archive has no catalog bundle")
            catalog = Catalog.load(staged)
            run_git(
                "clone", "--branch", catalog.config.branch, str(bundle), str(checkout.resolve())
            )
            run_git("remote", "set-url", "origin", catalog.config.remote, cwd=checkout)
            config = json.loads(staged.catalog_config.read_text())
            config["checkout"] = str(checkout.resolve())
            staged.catalog_config.write_text(json.dumps(config))
        bundle.unlink(missing_ok=True)
        work.rename(target)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("export", "restore"))
    parser.add_argument("archive", type=Path)
    parser.add_argument("--catalog-checkout", type=Path)
    args = parser.parse_args()
    settings = Settings.load()
    try:
        if args.action == "export":
            export(settings, args.archive)
        else:
            restore(settings, args.archive, args.catalog_checkout)
    except BlockingIOError:
        raise SystemExit("Stop the worker and controller before exporting") from None
    except (ValueError, OSError, sqlite3.Error) as error:
        raise SystemExit(str(error)) from None
    print(args.archive if args.action == "export" else settings.directory)


if __name__ == "__main__":
    os.umask(0o077)
    main()
