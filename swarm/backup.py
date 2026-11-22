from __future__ import annotations

import json
import os
import shutil
import stat
import tempfile
import zipfile
from pathlib import Path

from .state import exclusive


def export_state(state: Path, archive: Path) -> None:
    state, archive = state.resolve(), archive.resolve()
    if archive == state or state in archive.parents or archive.exists():
        raise ValueError("Choose a new archive path outside the state directory")
    catalog = Path(os.environ.get("SWARM_CATALOG", state / "catalog")).resolve()
    with exclusive(state / "worker.lock"):
        if not (state / "state.sqlite").is_file():
            raise ValueError("No installation to export")
        with tempfile.NamedTemporaryFile(dir=archive.parent, delete=False) as tmp:
            staging = Path(tmp.name)
        try:
            with zipfile.ZipFile(staging, "w", compression=zipfile.ZIP_DEFLATED) as z:
                z.writestr("manifest.json", json.dumps({"format": 1}))
                z.write(state / "state.sqlite", "state.sqlite")
                for key in (
                    "objects",
                    "workspaces",
                    "fixtures",
                    "sessions",
                    "catalog",
                    "notifications",
                ):
                    root = catalog if key == "catalog" else state / key
                    if not root.exists():
                        continue
                    for path in root.rglob("*"):
                        if path.is_symlink() or not path.is_file():
                            continue
                        if key == "sessions" and path.name in {"auth.json", "config.toml"}:
                            continue
                        z.write(path, (Path(key) / path.relative_to(root)).as_posix())
            os.link(staging, archive)
        finally:
            staging.unlink(missing_ok=True)


def restore_state(archive: Path, state: Path) -> None:
    if state.exists():
        raise ValueError("Restore into a new state directory")
    state.parent.mkdir(parents=True, exist_ok=True)
    dest = Path(tempfile.mkdtemp(dir=state.parent))
    try:
        with zipfile.ZipFile(archive) as z:
            if (
                json.loads(z.read("manifest.json")) != {"format": 1}
                or "state.sqlite" not in z.namelist()
            ):
                raise ValueError("Unrecognized state archive")
            for info in z.infolist():
                if info.filename == "manifest.json":
                    continue
                path = dest / info.filename
                if dest not in path.resolve().parents or stat.S_ISLNK(info.external_attr >> 16):
                    raise ValueError("Invalid archive member")
                if info.is_dir():
                    path.mkdir(parents=True, exist_ok=True)
                    continue
                path.parent.mkdir(parents=True, exist_ok=True)
                with z.open(info) as src, path.open("xb") as dst:
                    shutil.copyfileobj(src, dst)
                path.chmod((info.external_attr >> 16) & 0o777)
        dest.rename(state)
    finally:
        if dest.exists():
            shutil.rmtree(dest)
