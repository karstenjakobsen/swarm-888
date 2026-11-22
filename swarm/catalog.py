from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import threading
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

import jsonschema
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .state import NAME, ROOT, State, digest, encode, identity, name


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Connector(Contract):
    endpoint: str
    authentication: Literal["bearer"]
    secret: str = Field(pattern=f"^{NAME}$")

    @model_validator(mode="after")
    def check_destination(self):
        url = urlsplit(self.endpoint)
        local = url.hostname in {"127.0.0.1", "localhost", "::1"}
        if (
            not url.hostname
            or url.username
            or url.password
            or url.query
            or url.fragment
            or not (url.scheme == "https" or local and url.scheme == "http")
        ):
            raise ValueError("Use an HTTPS endpoint and a separate secret reference")
        return self


class Case(Contract):
    input: dict
    expected: dict


class Package(Contract):
    name: str = Field(pattern=f"^{NAME}$")
    instructions: str = Field(min_length=1, max_length=12000)
    sql: str | None = Field(default=None, min_length=1, max_length=12000)
    tests: list[Case] = Field(default_factory=list, max_length=40)
    permissions: list[str] = Field(default_factory=list, max_length=12)
    connectors: list[str] = Field(default_factory=list, max_length=12)
    input_schema: dict = Field(default_factory=lambda: {"type": "object"})
    output_schema: dict = Field(default_factory=lambda: {"type": "object"})
    named: bool = False

    @model_validator(mode="after")
    def validate_contract(self):
        if self.sql and not self.tests:
            raise ValueError("Provide executable examples for the SQL program")
        if not self.sql and (self.tests or self.named):
            raise ValueError("Procedural skills are read through skill_read")
        for schema in (self.input_schema, self.output_schema):
            validate_schema(schema)
        return self


def validate_schema(schema: dict) -> None:
    allowed = {
        "type",
        "properties",
        "items",
        "description",
        "required",
        "enum",
        "additionalProperties",
    }
    if set(schema) - allowed or schema.get("type") not in {
        "object",
        "array",
        "string",
        "number",
        "integer",
        "boolean",
        "null",
    }:
        raise ValueError(
            "Use inline JSON types, properties, items, required, enum or additionalProperties"
        )
    if not isinstance(schema.get("additionalProperties", True), bool):
        raise ValueError("additionalProperties must be boolean")
    for child in schema.get("properties", {}).values():
        validate_schema(child)
    if "items" in schema:
        validate_schema(schema["items"])
    jsonschema.Draft7Validator.check_schema(schema)


def validate_value(value: dict, schema: dict) -> None:
    error = next(jsonschema.Draft7Validator(schema).iter_errors(value), None)
    if error:
        raise ValueError(error.message[:300])


class Catalog:
    def __init__(
        self, state: State, checkout: Path | None = None, remote: str = "", branch: str = "main"
    ):
        self.state = state
        self.path = (checkout or state.path / "catalog").resolve()
        if self.path == ROOT or ROOT in self.path.parents or self.path in ROOT.parents:
            raise ValueError("Use a separate catalog checkout")
        self.remote = remote
        self.branch = branch
        self.lock = threading.RLock()
        self.path.mkdir(parents=True, exist_ok=True)
        self.git("check-ref-format", "--branch", branch)
        if not (self.path / ".git").exists():
            if any(self.path.iterdir()):
                raise ValueError("Expected an empty catalog or existing Git checkout")
            self.git("init", "-b", branch)
            if remote:
                self.git("remote", "add", "origin", remote)
                if self.git("ls-remote", "--heads", "origin", f"refs/heads/{branch}").strip():
                    self.sync()
        if remote and "origin" not in self.git("remote").splitlines():
            self.git("remote", "add", "origin", remote)
        if self.git("branch", "--show-current").strip() != branch:
            raise ValueError("Catalog is on another branch")
        self.seed()

    def git(self, *args: str) -> str:
        result = subprocess.run(
            [
                "git",
                "-c",
                "core.hooksPath=/dev/null",
                "-c",
                "user.name=VPS Operator",
                "-c",
                "user.email=operator@localhost",
                "-c",
                "commit.gpgsign=false",
                *args,
            ],
            cwd=self.path,
            capture_output=True,
            text=True,
            timeout=30,
            env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
        )
        if result.returncode:
            raise ValueError(
                self.state.redact(result.stderr.strip()[:1200] or "Git operation failed")
            )
        return result.stdout

    def seed(self) -> None:
        if self.state.rows("SELECT * FROM meta WHERE key='seeded'"):
            return
        for rel, src in [
            ("skills/skill-author", ROOT / "foundation/skill-author"),
            ("connectors/digitalocean.json", ROOT / "foundation/connectors/digitalocean.json"),
        ]:
            target = self.safe(rel)
            if not target.exists():
                target.parent.mkdir(parents=True, exist_ok=True)
                if src.is_dir():
                    shutil.copytree(src, target)
                else:
                    shutil.copyfile(src, target)
                self.commit(rel, "Install " + rel)
        self.state.change("INSERT INTO meta VALUES ('seeded','1')")

    def safe(self, relative: str) -> Path:
        p = self.path / relative
        if p.resolve() != p or self.path not in p.parents:
            raise ValueError("Catalog paths must stay inside the checkout")
        return p

    def commit(self, relative: str, message: str) -> str:
        self.git("add", "--", relative)
        if self.git("diff", "--cached", "--name-only", "--", relative).strip():
            self.git("commit", "--only", "-m", message, "--", relative)
        return self.git("rev-parse", "HEAD").strip()

    def sync(self) -> dict:
        with self.lock:
            if not self.remote or self.git("remote", "get-url", "origin").strip() != self.remote:
                raise ValueError("Configure the expected origin before synchronizing")
            if self.git("status", "--porcelain").strip():
                raise ValueError("Catalog has uncommitted work")
            ref = f"refs/heads/{self.branch}"
            if self.git("ls-remote", "--heads", "origin", ref).strip():
                self.git("fetch", "origin", ref)
                self.git("merge", "--ff-only", "FETCH_HEAD")
            self.git("push", "origin", f"HEAD:{ref}")
            return {"revision": self.git("rev-parse", "HEAD").strip()}

    def define(self, kind: Literal["projects", "connectors"], key: str, definition: dict) -> dict:
        if kind not in ("projects", "connectors"):
            raise ValueError("Unknown catalog kind")
        if kind == "connectors":
            definition = Connector.model_validate(definition).model_dump()
        rel = f"{kind}/{name(key)}.json"
        with self.lock:
            if self.git("status", "--porcelain", "--", rel).strip():
                raise ValueError("Definition has uncommitted edits")
            target = self.safe(rel)
            target.parent.mkdir(exist_ok=True)
            target.write_text(encode(self.state.redact(definition)) + "\n")
            return {"revision": self.commit(rel, "Define " + key)}

    def search(self, query: str = "") -> list[dict]:
        entries = [
            {
                "name": "skill-author",
                "description": "Author and test a local skill",
                "revision": "builtin",
            }
        ]
        entries.extend(
            {
                "name": r["name"],
                "revision": r["rev"],
                "description": json.loads(r["spec"])["instructions"][:200],
            }
            for r in self.state.rows(
                "SELECT r.* FROM active a JOIN revisions r ON a.rev=r.rev ORDER BY a.name"
            )
        )
        return [
            e
            for e in entries
            if all(
                word in (e["name"] + " " + e["description"]).lower()
                for word in query.lower().split()
            )
        ]

    def read(self, key: str) -> dict:
        if key == "skill-author":
            return {"instructions": (ROOT / "foundation/skill-author/SKILL.md").read_text()}
        return self.revision(self.active(key))

    def active(self, key: str) -> str:
        return self.state.one("SELECT rev FROM active WHERE name=?", key)["rev"]

    def revision(self, rev: str) -> dict:
        row = self.state.one("SELECT * FROM revisions WHERE rev=?", rev)
        return {**row, "spec": json.loads(row["spec"]), "tests": json.loads(row["tests"])}

    def stage(self, task: str, spec: Package) -> dict:
        if spec.name == "skill-author":
            raise ValueError("Foundation changes use the owner's framework upgrade procedure")
        spec = Package.model_validate(self.state.redact(spec.model_dump()))
        rel = "skills/" + spec.name
        with self.lock:
            if self.git("status", "--porcelain", "--", rel).strip():
                raise ValueError("Preserve uncommitted candidate edits first")
            base = self.state.rows("SELECT rev FROM active WHERE name=?", spec.name)
            if base:
                old = self.revision(base[0]["rev"])["spec"]["tests"]
                cases = {encode(c): c for c in old + [c.model_dump() for c in spec.tests]}
                spec = Package.model_validate({**spec.model_dump(), "tests": list(cases.values())})
            path = self.safe(rel)
            path.mkdir(exist_ok=True, parents=True)
            self.safe(rel + "/SKILL.md").write_text(spec.instructions + "\n")
            self.safe(rel + "/package.json").write_text(encode(spec.model_dump()) + "\n")
            rev = self.commit(rel, "Stage " + spec.name)
            return self.import_revision(task, spec.name, rev)

    def import_revision(self, task: str, key: str, commit: str) -> dict:
        import re

        if not re.fullmatch("[a-f0-9]{40}", commit):
            raise ValueError("Supply a full Git commit")
        package = Package.model_validate_json(
            self.git("show", f"{commit}:skills/{name(key)}/package.json")
        )
        if package.name != key or key == "skill-author":
            raise ValueError("Package name mismatch")
        # Different packages may be imported from the same catalog commit.
        rev = digest([commit, key])
        spec = encode(package.model_dump())
        if self.state.redact(spec) != spec:
            raise ValueError("Credential found in candidate")
        obj = self.state.path / "objects" / rev
        if not obj.exists():
            tmp = obj.with_suffix("." + identity())
            tmp.write_text(spec)
            tmp.chmod(0o400)
            tmp.replace(obj)
        self.state.change(
            "INSERT OR IGNORE INTO revisions VALUES (?,?,?,?,?,?,?,?)",
            rev,
            key,
            commit,
            task,
            spec,
            "[]",
            0,
            self.state.clock(),
        )
        return {"revision": rev, "git": commit}

    def evaluate(self, rev: str, arguments: dict) -> dict:
        row = self.revision(rev)
        spec_text = (self.state.path / "objects" / rev).read_text()
        if spec_text != encode(row["spec"]):
            raise ValueError("Immutable object failed integrity check")
        if not row["spec"].get("sql"):
            raise ValueError("Read this procedural skill with skill_read")
        validate_value(arguments, row["spec"].get("input_schema", {}))
        payload = encode({"sql": row["spec"]["sql"], "input": arguments})
        if len(payload.encode()) > 96000:
            raise ValueError("Input exceeds 96 KB")
        result = subprocess.run(
            [sys.executable, "-I", "-S", str(ROOT / "swarm/evaluate.py")],
            input=payload,
            capture_output=True,
            text=True,
            timeout=4,
            env={},
            cwd=self.state.path / "workspaces",
        )
        if result.returncode or len(result.stdout.encode()) > 64000:
            raise ValueError(
                f"Helper exit {result.returncode}: " + self.state.redact(result.stderr[:500])
            )
        value = self.state.redact(json.loads(result.stdout))
        validate_value(value, row["spec"].get("output_schema", {}))
        return value

    def test(self, task: str, revision: str) -> dict:
        row = self.revision(revision)
        results = []
        for case in row["spec"]["tests"]:
            try:
                observed = self.evaluate(revision, case["input"])
                results.append(
                    {
                        **case,
                        "actual": observed,
                        "passed": encode(observed) == encode(case["expected"]),
                    }
                )
            except (ValueError, subprocess.SubprocessError) as exc:
                results.append({**case, "error": str(exc), "passed": False})
        if not row["spec"].get("sql"):
            results.append(
                {
                    "check": "procedural package integrity",
                    "passed": (self.state.path / "objects" / revision).read_text()
                    == encode(row["spec"]),
                }
            )
        passed = all(r["passed"] for r in results)
        self.state.change(
            "UPDATE revisions SET tests=?,passed=? WHERE rev=?", encode(results), passed, revision
        )
        self.state.event(
            task, "skill.tests", {"revision": revision, "passed": passed, "cases": results}
        )
        return {"revision": revision, "passed": passed, "cases": results}

    def activate(self, task: str, revision: str) -> dict:
        with self.state.tx() as conn:
            row = conn.execute(
                "SELECT name FROM revisions WHERE rev=? AND passed=1", (revision,)
            ).fetchone()
            if not row:
                raise ValueError("Test this revision successfully before activation")
            conn.execute("INSERT OR REPLACE INTO active VALUES (?,?)", (row["name"], revision))
            conn.execute(
                "INSERT INTO activations(name,rev,task) VALUES (?,?,?)",
                (row["name"], revision, task),
            )
            self.state.event(
                task, "skill.active", {"name": row["name"], "revision": revision}, conn
            )
        return {"name": row["name"], "revision": revision}

    def rollback(self, task: str, key: str, revision: str) -> dict:
        self.state.one("SELECT id FROM activations WHERE name=? AND rev=?", key, revision)
        return self.activate(task, revision)

    def run(self, task: str, key: str, arguments: dict) -> dict:
        rev = self.active(key)
        call = identity()
        try:
            result = self.evaluate(rev, arguments)
        except (ValueError, subprocess.SubprocessError) as exc:
            self.state.event(
                task,
                "skill.failed",
                {"revision": rev, "error": str(exc), "input_hash": digest(arguments)},
            )
            raise
        self.state.change(
            "INSERT INTO calls(id,task,rev,input_hash,result) VALUES (?,?,?,?,?)",
            call,
            task,
            rev,
            digest(arguments),
            encode(result),
        )
        return {"call": call, "revision": rev, "exit_status": 0, "result": result}

    def attest(self, call: str, expected: dict, observation: str) -> dict:
        row = self.state.one(
            "SELECT c.rowid as seq,c.*,r.author FROM calls c JOIN revisions r ON c.rev=r.rev WHERE c.id=?",
            call,
        )
        different = self.state.rows(
            "SELECT id FROM calls WHERE rev=? AND task=? AND input_hash<>? AND rowid<? AND NOT EXISTS (SELECT 1 FROM calls c WHERE c.rev=? AND c.task=? AND c.input_hash=?)",
            row["rev"],
            row["author"],
            row["input_hash"],
            row["seq"],
            row["rev"],
            row["author"],
            row["input_hash"],
        )
        passed = row["result"] == encode(expected)
        reuse = bool(different and row["task"] != row["author"] and passed)
        evidence = self.state.redact(
            {"expected": expected, "observation": observation, "passed": passed}
        )
        self.state.change(
            "UPDATE calls SET checked=?,verified_reuse=? WHERE id=?", encode(evidence), reuse, call
        )
        self.state.event(
            row["task"], "independent.check", {"call": call, **evidence, "verified_reuse": reuse}
        )
        if passed:
            self.state.change(
                "UPDATE tasks SET status='verified' WHERE id=? AND status='answered'", row["task"]
            )
        return {"passed": passed, "verified_reuse": reuse}
