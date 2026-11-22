"""The operator owns Git metadata outside the worker's writable checkout."""

import asyncio
import os
import re
from urllib.parse import urlsplit

from .codex import stop_process

ROOTS = {"projects": "Projects", ".agents/skills": "Skills", "connectors": "Connectors"}


def https_url(raw, local=False):
    u = urlsplit(raw)
    if (
        not u.hostname
        or u.username
        or u.password
        or u.query
        or u.fragment
        or not (
            u.scheme == "https"
            or local
            and u.scheme == "http"
            and u.hostname in ("127.0.0.1", "localhost", "::1")
        )
    ):
        raise ValueError("Use an HTTPS URL without embedded credentials")
    _ = u.port
    return raw.rstrip("/")


def git_ref(raw):
    value = raw or "HEAD"
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,199}", value) or ".." in value:
        raise ValueError("Use a branch, tag, or commit SHA")
    return value


def assets(workspace):
    found = []
    for root, kind in ROOTS.items():
        parent = workspace / root
        if not parent.is_dir() or parent.resolve() != parent:
            continue
        for item in sorted(parent.iterdir()):
            if item.is_dir() and not item.is_symlink():
                found.append(
                    {"name": item.name, "kind": kind, "path": str(item.relative_to(workspace))}
                )
    return found


async def git(*args, cwd=None, allow_failure=False):
    env = dict(
        os.environ, GIT_TERMINAL_PROMPT="0", GIT_ALLOW_PROTOCOL="https", GIT_CONFIG_NOSYSTEM="1"
    )
    proc = await asyncio.create_subprocess_exec(
        "git",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "user.name=Swarm Operator",
        "-c",
        "user.email=operator@localhost",
        *map(str, args),
        cwd=cwd,
        env=env,
        start_new_session=True,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        async with asyncio.timeout(120):
            out, err = await proc.communicate()
    finally:
        await stop_process(proc)
    if proc.returncode and not allow_failure:
        # Git errors can include credential helper output; retain only the operation and exit status.
        raise RuntimeError(
            f"Git operation failed (exit {proc.returncode}). Check repository access and Git credentials."
        )
    return out.decode(errors="replace").strip(), proc.returncode


async def operate(store, job):
    project = store.project(job["project"])
    if not project["repo"]:
        raise ValueError("This workspace has no linked repository")
    workspace = store.workspace(project["id"])
    meta = store.root / "repositories" / project["id"]
    meta.parent.mkdir(exist_ok=True)
    args = ["--git-dir", meta, "--work-tree", workspace]
    branch = "swarm/" + project["id"]
    if job["kind"] == "import":
        if project["revision"]:
            return "Catalog is already imported at " + project["revision"][:12]
        await git("init", "--bare", meta)
        ref = git_ref(project["repo_ref"])
        try:
            await git(*args, "fetch", "--depth=1", project["repo"], ref)
            rev = (await git(*args, "rev-parse", "FETCH_HEAD"))[0]
        except RuntimeError:
            # An empty remote has no HEAD to fetch. Start its first catalog branch locally.
            if ref != "HEAD" or (await git("ls-remote", "--refs", project["repo"]))[0]:
                raise
            await git(*args, "symbolic-ref", "HEAD", "refs/heads/" + branch)
            rev, missing = await git(*args, "rev-parse", "--verify", "HEAD", allow_failure=True)
            if missing:
                await git(*args, "read-tree", "--empty")
                await git(*args, "commit", "--allow-empty", "-m", "Initialize operator catalog")
                rev = (await git(*args, "rev-parse", "HEAD"))[0]
        await git(*args, "update-ref", "refs/heads/" + branch, rev)
        await git(*args, "symbolic-ref", "HEAD", "refs/heads/" + branch)
        await git(*args, "read-tree", rev)
        for root in ROOTS:
            match, _ = await git(*args, "ls-tree", "--name-only", rev, "--", root)
            if match:
                if match != root:
                    raise ValueError("Unexpected catalog tree")
                await git(*args, "restore", "--source", rev, "--worktree", "--", root)
        store.update("UPDATE projects SET revision=? WHERE id=?", (rev, project["id"]))
        return "Imported repository at " + rev[:12]
    if not project["revision"]:
        raise ValueError("Import the repository successfully before publishing")
    for root in ROOTS:
        folder = workspace / root
        if folder.is_symlink() or folder.resolve() != folder:
            raise ValueError("Catalog directories must be local directories")
        tracked, _ = await git(*args, "ls-files", "--", root)
        if folder.exists() or tracked:
            await git(*args, "add", "-A", "--", root)
    _, diff = await git(*args, "diff", "--cached", "--quiet", allow_failure=True)
    if diff == 1:
        await git(*args, "commit", "-m", "Update operator catalog")
    elif diff:
        raise RuntimeError("Could not inspect catalog changes")
    rev = (await git(*args, "rev-parse", "HEAD"))[0]
    await git(*args, "push", project["repo"], "HEAD:refs/heads/" + branch)
    store.update("UPDATE projects SET revision=? WHERE id=?", (rev, project["id"]))
    return "Published " + rev[:12] + " to " + branch
