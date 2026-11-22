"""Ordinary application sources in separate, local Git repositories."""

from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
from pathlib import Path

from .catalog import Catalog
from .state import State, digest, encode, name


def source_path(value: str) -> str:
    parts = value.split("/")
    if not 1 <= len(value) <= 240 or any(
        not re.fullmatch(r"[a-zA-Z0-9_.-]{1,100}", part) or part.lower() in (".", "..", ".git")
        for part in parts
    ):
        raise ValueError("Supply a relative project source path")
    return value


def git(repo: Path, *args: str, data: str | None = None, index: Path | None = None) -> str:
    env = {"PATH": os.environ["PATH"], "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull}
    if index:
        env["GIT_INDEX_FILE"] = str(index)
    proc = subprocess.run(
        [
            "git",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "user.name=VPS Operator",
            "-c",
            "user.email=operator@localhost",
            *args,
        ],
        cwd=repo,
        env=env,
        input=data.encode() if data is not None else None,
        capture_output=True,
        timeout=20,
    )
    if proc.returncode:
        raise ValueError(
            proc.stderr.decode(errors="replace")[:700] or "Project Git operation failed"
        )
    return proc.stdout.decode()


class Projects:
    def __init__(self, state: State, catalog: Catalog):
        self.state, self.catalog = state, catalog

    def location(self, task: str) -> tuple[str, Path]:
        row = self.state.one("SELECT kind,input FROM tasks WHERE id=?", task)
        if row["kind"] != "project":
            raise ValueError("An owner project task is required")
        key = name(json.loads(row["input"])["project"])
        repo = self.state.path / "workspaces" / "projects" / (key + ".git")
        if repo.resolve() != repo:
            raise ValueError("Project repository has been redirected")
        return key, repo

    def status(self, task: str) -> dict:
        key, repo = self.location(task)
        head = ""
        if (repo / "HEAD").is_file():
            head = git(repo, "for-each-ref", "--format=%(objectname)", "refs/heads/main").strip()
        return {
            "project": key,
            "commit": head,
            "files": git(repo, "ls-tree", "-r", "--name-only", head).splitlines() if head else [],
        }

    def read(self, task: str, path: str) -> dict:
        _, repo = self.location(task)
        current = self.status(task)
        path = source_path(path)
        if path not in current["files"]:
            raise ValueError("Project file does not exist")
        return {
            "commit": current["commit"],
            "path": path,
            "text": git(repo, "show", f"{current['commit']}:{path}"),
        }

    def save(self, task: str, base: str, files: dict[str, str], message: str) -> dict:
        key, repo = self.location(task)
        files = self.state.redact(files)
        message = self.state.redact(message)
        if base and not re.fullmatch("[a-f0-9]{40}", base):
            raise ValueError("Use the exact commit returned by project_status")
        if not 1 <= len(files) <= 50 or not 1 <= len(message.strip()) <= 240:
            raise ValueError("Supply 1–50 text files and a short commit message")
        if (
            any("\x00" in value or len(value.encode()) > 48000 for value in files.values())
            or len(encode(files).encode()) > 180000
        ):
            raise ValueError("Project source exceeds the text size limit")
        hashed = {source_path(path): digest(value) for path, value in files.items()}
        op = digest([task, key, base, hashed, message])
        definition = {
            "repository": f"workspaces/projects/{key}.git",
            "relative_to": "operator_state",
        }
        with self.catalog.lock:
            if self.state.one("SELECT status FROM tasks WHERE id=?", task)["status"] != "running":
                raise ValueError("Project task is no longer running")
            target = self.catalog.safe(f"projects/{key}.json")
            if target.exists() and json.loads(target.read_text()) != definition:
                raise ValueError("The catalog already points this name at another project")
            head = self.status(task)["commit"]
            recorded = self.state.rows("SELECT evidence FROM operations WHERE id=?", op)
            candidate = json.loads(recorded[0]["evidence"]).get("commit") if recorded else None
            if not candidate and head != base:
                raise ValueError("Project changed. Read the current revision before editing")
            with self.state.tx() as conn:
                conn.execute(
                    "INSERT OR IGNORE INTO operations(id,task,authority,target,intent,status,evidence) VALUES (?,?,?,?,?,'prepared','{}')",
                    (
                        op,
                        task,
                        task,
                        "project:" + key,
                        encode({"base": base, "files": files, "message": message}),
                    ),
                )
                checkpoint = json.loads(
                    conn.execute("SELECT checkpoint FROM tasks WHERE id=?", (task,)).fetchone()[0]
                )
                if op not in checkpoint["operations"]:
                    checkpoint["operations"].append(op)
                    checkpoint.setdefault("outstanding", []).append(op)
                    checkpoint["next"] = "Compare the Git branch to the journaled source commit"
                    conn.execute(
                        "UPDATE tasks SET checkpoint=? WHERE id=?", (encode(checkpoint), task)
                    )
            if not candidate:
                repo.mkdir(mode=0o700, parents=True, exist_ok=True)
                if not (repo / "HEAD").exists():
                    git(
                        repo,
                        "init",
                        "--bare",
                        "--object-format=sha1",
                        "--initial-branch=main",
                        "--template=",
                    )
                with tempfile.TemporaryDirectory() as scratch:
                    index = Path(scratch) / "index"
                    if base:
                        git(repo, "read-tree", base, index=index)
                    for path, value in sorted(files.items()):
                        blob = git(repo, "hash-object", "-w", "--stdin", data=value).strip()
                        git(
                            repo,
                            "update-index",
                            "--add",
                            "--cacheinfo",
                            "100644",
                            blob,
                            path,
                            index=index,
                        )
                    tree = git(repo, "write-tree", index=index).strip()
                parent = ["-p", base] if base else []
                candidate = git(repo, "commit-tree", tree, *parent, "-m", message).strip()
                self.state.change(
                    "UPDATE operations SET status='dispatched',evidence=? WHERE id=?",
                    encode({"commit": candidate}),
                    op,
                )
            return self._finish(task, op, key, repo, base, candidate, definition)

    def _finish(
        self, task: str, op: str, key: str, repo: Path, base: str, candidate: str, definition: dict
    ) -> dict:
        with self.catalog.lock:
            head = self.status(task)["commit"]
            if head == base:
                if (
                    self.state.one("SELECT status FROM tasks WHERE id=?", task)["status"]
                    != "running"
                ):
                    raise ValueError("Project task stopped before publishing the commit")
                git(repo, "update-ref", "refs/heads/main", candidate, base or "0" * 40)
            # A later owner edit may already descend from a previously committed operation.
            git(repo, "merge-base", "--is-ancestor", candidate, "refs/heads/main")
            target = self.catalog.safe(f"projects/{key}.json")
            if target.exists() and json.loads(target.read_text()) != definition:
                raise ValueError("The catalog project reference changed")
            if not target.exists():
                self.catalog.define("projects", key, definition)
            elif self.catalog.git("status", "--porcelain", "--", f"projects/{key}.json").strip():
                self.catalog.commit(f"projects/{key}.json", "Define " + key)
            result = {"project": key, "commit": candidate, "operation": op, **definition}
            with self.state.tx() as conn:
                conn.execute(
                    "UPDATE operations SET status='verified',evidence=? WHERE id=?",
                    (encode(result), op),
                )
                checkpoint = json.loads(
                    conn.execute("SELECT checkpoint FROM tasks WHERE id=?", (task,)).fetchone()[0]
                )
                checkpoint["outstanding"] = [k for k in checkpoint["outstanding"] if k != op]
                checkpoint["last_verified"] = result
                checkpoint["next"] = "Read committed source and check the owner's requested outcome"
                conn.execute("UPDATE tasks SET checkpoint=? WHERE id=?", (encode(checkpoint), task))
                self.state.event(task, "project.commit", result, conn)
            return result

    def recover(self, task: str) -> None:
        key, _ = self.location(task)
        for op in self.state.rows(
            "SELECT intent FROM operations WHERE task=? AND target=? AND status IN ('prepared','dispatched') ORDER BY rowid",
            task,
            "project:" + key,
        ):
            self.save(task, **json.loads(op["intent"]))
