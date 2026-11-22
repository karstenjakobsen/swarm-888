"""A normal Git checkout shared by this operator's workspaces."""

import asyncio
import fcntl
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlsplit

from .catalog import assets, commit_assets, git, repository_url
from .store import SHARED_CATALOG_PROJECT as PROJECT

DEFAULT_REMOTE = "git@github.com:karstenjakobsen/packages-888.git"
BRANCH = "main"
ROOTS = {"skills": "Skills", "connectors": "Connectors", "projects": "Projects"}


def configure(store, directory=None, remote=None):
    previous = store.catalog_settings()
    path = (
        Path(directory or (previous["directory"] if previous else store.root / "catalog"))
        .expanduser()
        .resolve()
    )
    url = repository_url(remote or (previous["repo"] if previous else DEFAULT_REMOTE))
    if (
        path == store.root
        or path.is_relative_to(store.root / "workspaces")
        or store.root.is_relative_to(path)
    ):
        raise ValueError("Choose a dedicated directory for the shared catalog")
    changed = bool(
        previous
        and (str(path) != previous["directory"] or identity(previous["repo"]) != identity(url))
    )
    store.configure_catalog(path, url, BRANCH, changed)


def info(store):
    if store.catalog_dir is None:
        return None
    project = store.project(PROJECT)
    return {
        "id": PROJECT,
        "directory": str(store.catalog_dir),
        "repo": project["repo"],
        "branch": BRANCH,
        "revision": project["revision"],
        "assets": assets(store.catalog_dir, ROOTS),
    }


def identity(url):
    """Recognize HTTPS and SSH checkouts of the same hosted repository."""
    url = repository_url(url)
    if url.startswith("git@"):
        host, path = url[4:].split(":", 1)
    else:
        parts = urlsplit(url)
        host, path = parts.netloc, parts.path.lstrip("/")
    return host.lower(), path.removesuffix(".git")


async def checkout(store):
    path = store.catalog_dir
    url = store.project(PROJECT)["repo"]
    if not path.exists() or (path.is_dir() and not any(path.iterdir())):
        path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix=".swarm-catalog-", dir=path.parent) as tmp:
            clone = Path(tmp) / "checkout"
            await git("clone", "--branch", BRANCH, "--", url, clone)
            try:
                clone.rename(path)
            except OSError:
                if not (path / ".git").exists():
                    raise
    if not (path / ".git").exists():
        raise ValueError("Catalog directory contains files but is not a Git checkout")
    top, _ = await git("-C", path, "rev-parse", "--show-toplevel")
    origin, _ = await git("-C", path, "config", "--get", "remote.origin.url")
    if Path(top).resolve() != path or identity(origin) != identity(url):
        raise ValueError("Catalog checkout origin does not match the configured repository")
    return path


@asynccontextmanager
async def locked(store):
    path = await checkout(store)
    git_dir, _ = await git("-C", path, "rev-parse", "--absolute-git-dir")
    with (Path(git_dir) / "swarm-catalog.lock").open("a") as lock:
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                await asyncio.sleep(0.2)
        branch, _ = await git("-C", path, "branch", "--show-current")
        if branch != BRANCH:
            raise ValueError("Shared catalog must be checked out on " + BRANCH)
        yield path


async def operate(store, kind):
    """Caller holds the checkout lock. Never reset the worktree or force-push."""
    path = store.catalog_dir
    url = store.project(PROJECT)["repo"]
    args = ["-C", path]
    tracking = "refs/remotes/origin/" + BRANCH
    await git(*args, "fetch", "--no-tags", url, f"+refs/heads/{BRANCH}:{tracking}")
    upstream, _ = await git(*args, "rev-parse", tracking)
    _, failed = await git(
        *args, "merge", "--ff-only", "--no-autostash", upstream, allow_failure=True
    )
    if failed:
        raise ValueError(
            f"Sync stopped to preserve local edits or divergent commits. Reconcile {path} with {BRANCH} and retry."
        )
    outside = ["--", ".", *(":(exclude)" + root for root in ROOTS)]
    if kind == "publish":
        _, staged = await git(*args, "diff", "--cached", "--quiet", *outside, allow_failure=True)
        if staged:
            raise ValueError("The checkout contains staged changes outside its catalog directories")
        await commit_assets(args, path, ROOTS, "Update shared operator catalog")
    revision, _ = await git(*args, "rev-parse", "HEAD")
    if kind == "publish" and revision != upstream:
        other_commits, _ = await git(
            *args, "rev-list", "--full-history", upstream + ".." + revision, *outside
        )
        if other_commits:
            raise ValueError(
                "The checkout contains committed changes outside its catalog directories"
            )
        _, failed = await git(
            *args, "push", url, revision + ":refs/heads/" + BRANCH, allow_failure=True
        )
        if failed:
            raise ValueError(
                "Publish failed. Local commits are preserved. Check push access and sync the shared branch before retrying."
            )
        # A URL push bypasses Git's named-remote tracking update. Preserve a concurrent fetch.
        await git(*args, "update-ref", tracking, revision, upstream, allow_failure=True)
    store.update("UPDATE projects SET revision=? WHERE id=?", (revision, PROJECT))
    return ("Published" if kind == "publish" else "Synced") + " shared catalog at " + revision[:12]
