#!/usr/bin/env python3
"""Fetch the official standalone Linux binary and verify GitHub's release asset digest."""

import argparse
import hashlib
import json
import os
import platform
import shutil
import tarfile
import tempfile
from pathlib import Path
from urllib.request import Request, urlopen


def install(tool, destination, version):
    machine = {"x86_64": "x86_64", "aarch64": "aarch64"}.get(platform.machine())
    if not machine:
        raise SystemExit("The bundled tool installer supports Linux x86_64 and aarch64.")
    stem = f"{tool}-{machine}-unknown-linux-musl"
    repo, tag = (
        ("openai/codex", "rust-v" + version) if tool == "codex" else ("astral-sh/uv", version)
    )
    api = f"https://api.github.com/repos/{repo}/releases/tags/{tag}"
    with urlopen(
        Request(
            api,
            headers={"Accept": "application/vnd.github+json", "User-Agent": "swarm-888-installer"},
        ),
        timeout=30,
    ) as f:
        release = json.load(f)
    artifact = stem.replace("codex-", "codex-package-", 1) if tool == "codex" else stem
    asset = next(
        (
            a
            for suffix in (".tar.gz", ".tar.zst")
            for a in release["assets"]
            if a["name"] == artifact + suffix
        ),
        None,
    )
    if not asset or not (asset.get("digest") or "").startswith("sha256:"):
        raise SystemExit(
            "Release lacks a supported binary with a SHA-256 digest. Supply a preinstalled executable."
        )
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=destination.parent) as tmp:
        archive = Path(tmp) / "release.tgz"
        with urlopen(asset["browser_download_url"], timeout=120) as src, archive.open("wb") as out:
            shutil.copyfileobj(src, out)
        with archive.open("rb") as f:
            digest = hashlib.sha256()
            for chunk in iter(lambda: f.read(1024 * 1024), b""):
                digest.update(chunk)
            if digest.hexdigest() != asset["digest"][7:]:
                raise SystemExit("Release checksum mismatch")
        with tarfile.open(archive) as tf:
            if tool == "codex":
                stage = Path(tmp) / "package"
                tf.extractall(stage, filter="data")
                manifests = list(stage.rglob("codex-package.json"))
                if len(manifests) != 1:
                    raise SystemExit("Missing Codex package manifest")
                bundle = manifests[0].parent
                entry = bundle / "bin/codex"
                if not entry.is_file() or not (bundle / "bin/codex-code-mode-host").is_file():
                    raise SystemExit("Incomplete Codex runtime bundle")
                final = destination.parent / ("codex-runtime-" + version)
                if not final.exists():
                    bundle.rename(final)
                link = Path(tmp) / "current"
                link.symlink_to(final.resolve() / "bin/codex")
                os.replace(link, destination)
                return
            binary = next((m for m in tf if m.isfile() and Path(m.name).name in (tool, stem)), None)
            if not binary:
                raise SystemExit("Executable missing from release archive")
            staged = Path(tmp) / "executable"
            src = tf.extractfile(binary)
            if src is None:
                raise SystemExit("Executable has no file data in the release archive")
            with src, staged.open("wb") as out:
                shutil.copyfileobj(src, out)
            staged.chmod(0o755)
            os.replace(staged, destination)


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("tool", choices=("uv", "codex"))
    p.add_argument("destination", type=Path)
    p.add_argument("--version", required=True)
    args = p.parse_args()
    install(args.tool, args.destination, args.version)
