import argparse
import json
import os
import re
import sqlite3
import tarfile
import tempfile
from contextlib import ExitStack, closing, nullcontext
from pathlib import Path

from .catalog import Catalog, run_git
from .config import Settings
from .state import State
from .typed_catalogs import TypedCatalogs, branch_checkout, catalog_branch_id

STATE_FILES = (
    "owner.key",
    "catalog.json",
    "connector-bindings.json",
    "skill-dependencies.json",
    "fixture-engine.json",
)
STATE_DIRECTORIES = ("revisions", "workspaces", "secrets", "defense", "catalog-history")
DATABASE = "operator.sqlite3"
BUNDLE = "catalog.bundle"
TYPED_BUNDLES = "typed-catalog-bundles"


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
        ExitStack() as locks,
        tempfile.TemporaryDirectory(dir=destination.parent) as staging,
    ):
        work = Path(staging)
        with closing(
            sqlite3.connect((settings.directory / DATABASE).as_uri() + "?mode=ro", uri=True)
        ) as source:
            source.row_factory = sqlite3.Row
            has_branches = source.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='catalog_branches'"
            ).fetchone()
            branches = (
                [
                    branch_checkout(settings, row)
                    for row in source.execute("SELECT * FROM catalog_branches ORDER BY id")
                ]
                if has_branches
                else []
            )
        bundle_dir = work / TYPED_BUNDLES
        if branches:
            bundle_dir.mkdir()
        for checkout in branches:
            locks.enter_context(checkout.locked())
            if checkout.git("status", "--porcelain"):
                raise ValueError("Commit or stash catalog edits before exporting")
            checkout.git(
                "bundle", "create", str(bundle_dir / f"{checkout.branch_id}.bundle"), "--all"
            )
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
            for name in (DATABASE, BUNDLE, TYPED_BUNDLES):
                if (work / name).exists():
                    archive.add(work / name, arcname=name, filter=safe_entry)
            for name in (*STATE_FILES, *STATE_DIRECTORIES):
                if (settings.directory / name).exists():
                    archive.add(settings.directory / name, arcname=name, filter=safe_entry)
        archive_path.chmod(0o600)
        os.link(archive_path, destination)


def extract(archive: tarfile.TarFile, directory: Path) -> None:
    names = {DATABASE, BUNDLE, TYPED_BUNDLES, *STATE_FILES, *STATE_DIRECTORIES}
    seen = set()
    for entry in archive:
        parts = Path(entry.name).parts
        if (
            not parts
            or parts[0] not in names
            or ".." in parts
            or entry.name in seen
            or (parts[0] not in (*STATE_DIRECTORIES, TYPED_BUNDLES) and len(parts) != 1)
            or (
                parts[0] == TYPED_BUNDLES
                and (
                    len(parts) > 2
                    or (len(parts) == 2 and not re.fullmatch(r"[0-9a-f]{24}\.bundle", parts[1]))
                )
            )
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
        branches = TypedCatalogs(state).branches()
        for binding in branches:
            config = binding.catalog.config
            identity = binding.catalog.branch_id
            typed_checkout = work / "typed-catalogs" / identity
            typed_checkout.parent.mkdir(mode=0o700, exist_ok=True)
            run_git(
                "clone",
                "--branch",
                config.branch,
                str(work / TYPED_BUNDLES / f"{identity}.bundle"),
                str(typed_checkout),
            )
            run_git("remote", "set-url", "origin", config.remote, cwd=typed_checkout)
            with state.transaction(write=True) as db:
                db.execute(
                    "UPDATE catalog_branches SET checkout=? WHERE id=?",
                    (
                        str(target / "typed-catalogs" / identity),
                        identity,
                    ),
                )
        with state.transaction(write=True) as db:
            migration = db.execute(
                "SELECT config,completed FROM catalog_migration WHERE id=1"
            ).fetchone()
            if migration:
                original = json.loads(migration["config"])
                if migration["completed"]:
                    identity = catalog_branch_id(original["remote"], original["branch"])
                    original["checkout"] = str(target / "typed-catalogs" / identity)
                elif checkout:
                    original["checkout"] = str(checkout.resolve())
                db.execute(
                    "UPDATE catalog_migration SET config=? WHERE id=1", (json.dumps(original),)
                )
        if (work / TYPED_BUNDLES).is_dir():
            for typed_bundle in (work / TYPED_BUNDLES).iterdir():
                typed_bundle.unlink()
            (work / TYPED_BUNDLES).rmdir()
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
