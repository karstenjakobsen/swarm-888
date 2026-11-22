from __future__ import annotations

import inspect
import json
from typing import Any, Literal, get_type_hints

from pydantic import create_model

from .catalog import Catalog, Contract, Package
from .goals import Maintenance
from .state import ROOT, State, identity


class TaskTools:
    """The same typed methods back MCP, the worker RPC boundary and runtime tests."""

    def __init__(self, state: State, catalog: Catalog, task: str, maintenance: Maintenance):
        self.maintenance = maintenance
        self.s, self.catalog, self.task = state, catalog, task

    def skill_search(self, query: str = "") -> dict:
        """Search the active skill index by name or description."""
        return {"skills": self.catalog.search(query)}

    def skill_read(self, name: str) -> dict:
        """Read the instructions and implementation of an active skill."""
        return self.catalog.read(name)

    def skill_template(
        self, kind: Literal["transform", "permissions", "procedure"] = "transform"
    ) -> dict:
        """Get a working skill package example for the isolated SQL interpreter."""
        return json.loads((ROOT / f"foundation/skill-author/templates/{kind}.json").read_text())

    def skill_stage(self, package: Package) -> dict:
        """Commit a candidate package and return the immutable revision to test."""
        return self.catalog.stage(self.task, package)

    def skill_test(self, revision: str) -> dict:
        """Run every candidate case in a separate process and record actual outputs."""
        return self.catalog.test(self.task, revision)

    def skill_activate(self, revision: str) -> dict:
        """Atomically select a tested implementation for subsequent calls."""
        return self.catalog.activate(self.task, revision)

    def skill_import(self, name: str, commit: str) -> dict:
        """Stage a skill from a full Git commit already present in the checkout."""
        return self.catalog.import_revision(self.task, name, commit)

    def skill_run(self, name: str, arguments: dict) -> dict:
        """Invoke a currently active skill on a JSON input object."""
        return self.catalog.run(self.task, name, arguments)

    def skill_rollback(self, name: str, revision: str) -> dict:
        """Restore a previously activated revision for future calls."""
        return self.catalog.rollback(self.task, name, revision)

    def catalog_sync(self) -> dict:
        """Fast-forward and push the configured external Git catalog."""
        return self.catalog.sync()

    def catalog_define(
        self, kind: Literal["projects", "connectors"], name: str, definition: dict
    ) -> dict:
        """Commit a project reference or connector description to the external catalog."""
        return self.catalog.define(kind, name, definition)

    def memory_search(self, query: str = "", scope: str = "") -> dict:
        """Find memories by text and optional project scope."""
        return {
            "entries": self.s.rows(
                "SELECT * FROM memories WHERE instr(lower(body),lower(?)) AND (?='' OR scope=?) ORDER BY updated DESC LIMIT 30",
                query,
                scope,
                scope,
            )
        }

    def memory_read(self, id: str) -> dict:
        """Read a memory including its task provenance."""
        return self.s.one("SELECT * FROM memories WHERE id=?", id)

    def memory_write(self, scope: str, body: str) -> dict:
        """Save a project-scoped memory with its originating task."""
        key = identity()
        self.s.change(
            "INSERT INTO memories VALUES (?,?,?,?,?)", key, scope, body, self.task, self.s.clock()
        )
        return self.memory_read(key)

    def memory_revise(self, id: str, body: str) -> dict:
        """Revise an existing memory and record the editing task."""
        self.memory_read(id)
        self.s.change(
            "UPDATE memories SET body=?,source=?,updated=? WHERE id=?",
            body,
            self.task,
            self.s.clock(),
            id,
        )
        return self.memory_read(id)

    def memory_remove(self, id: str) -> dict:
        """Remove an existing memory."""
        self.memory_read(id)
        self.s.change("DELETE FROM memories WHERE id=?", id)
        return {"removed": id}

    def ask_owner(self, question: str) -> dict:
        """Persist a missing decision and wait for a follow-up on this task."""
        self.s.change("UPDATE tasks SET status='waiting' WHERE id=?", self.task)
        self.s.event(self.task, "question", {"text": question})
        return {"status": "waiting"}

    def methods(self) -> dict:
        prefixes = ("skill_", "catalog_", "memory_")
        return {
            key: getattr(self, key)
            for key in dir(type(self))
            if key.startswith(prefixes) or key == "ask_owner"
        }

    @staticmethod
    def contract(method: Any) -> type[Contract]:
        hints = get_type_hints(method)
        fields = {
            p.name: (hints[p.name], ... if p.default == p.empty else p.default)
            for p in inspect.signature(method).parameters.values()
        }
        return create_model(method.__name__ + "Input", __base__=Contract, **fields)

    def definitions(self) -> list[dict]:
        definitions = [
            {
                "name": key,
                "description": method.__doc__,
                "inputSchema": self.contract(method).model_json_schema(),
            }
            for key, method in self.methods().items()
        ]
        for row in self.s.rows(
            "SELECT r.name,r.spec FROM active a JOIN revisions r ON a.rev=r.rev"
        ):
            spec = json.loads(row["spec"])
            if spec["named"]:
                definitions.append(
                    {
                        "name": "local_" + row["name"].replace("-", "_"),
                        "description": spec["instructions"][:256],
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "arguments": spec.get("input_schema", {"type": "object"})
                            },
                            "required": ["arguments"],
                            "additionalProperties": False,
                        },
                    }
                )
        return definitions

    def call(self, key: str, arguments: dict) -> dict:
        task = self.s.one("SELECT status,kind,input FROM tasks WHERE id=?", self.task)
        if task["status"] != "running":
            raise ValueError("Task is not running")
        arguments = self.s.redact(arguments)
        self.s.event(self.task, "tool.started", {"tool": key, "arguments": arguments})
        try:
            if task["kind"] in ("diagnose", "improve"):
                inc = json.loads(task["input"])["incident"]
                if not self.maintenance.consume(inc, "tool"):
                    raise ValueError("Incident budget exhausted")
                allowed = {
                    "skill_read",
                    "skill_search",
                    "skill_template",
                    "skill_run",
                    "memory_read",
                    "memory_search",
                }
                if task["kind"] == "improve":
                    allowed.update({"skill_stage", "skill_test", "skill_activate"})
                if key not in allowed:
                    raise ValueError("Tool outside incident follow-up scope")
                bound = self.s.one(
                    "SELECT g.skill FROM goals g JOIN incidents i ON i.goal=g.id WHERE i.id=?", inc
                )["skill"]
                if key == "skill_stage" and arguments["package"]["name"] != bound:
                    raise ValueError("Revise the incident's bound skill")
                if (
                    key in ("skill_activate", "skill_test")
                    and self.catalog.revision(arguments["revision"])["name"] != bound
                ):
                    raise ValueError("Revision is outside the incident")
            if key.startswith("local_"):
                skill = key[6:].replace("_", "-")
                if not self.catalog.read(skill)["spec"]["named"]:
                    raise ValueError("Named tool is inactive")
                result = self.skill_run(skill, **arguments)
            else:
                method = self.methods().get(key)
                if not method:
                    raise ValueError("Unknown tool")
                validated = self.contract(method).model_validate(arguments)
                result = method(
                    **{field: getattr(validated, field) for field in type(validated).model_fields}
                )
        except Exception as exc:
            self.s.event(self.task, "tool.failed", {"tool": key, "error": str(exc)[:1200]})
            raise
        if task["kind"] == "improve" and key == "skill_activate":
            self.maintenance.followup(json.loads(task["input"])["incident"], result["revision"])
        with self.s.tx() as conn:
            self.s.event(self.task, "tool.completed", {"tool": key, "result": result}, conn)
            checkpoint = json.loads(
                conn.execute("SELECT checkpoint FROM tasks WHERE id=?", (self.task,)).fetchone()[0]
            )
            rev = result.get("revision")
            if rev and rev not in checkpoint["revisions"]:
                checkpoint["revisions"].append(rev)
            if result.get("call"):
                checkpoint["last_verified"] = {
                    "call": result["call"],
                    "revision": rev,
                    "result": result["result"],
                }
                checkpoint["next"] = (
                    "Compare the recorded result with the owner's completion criteria"
                )
            conn.execute(
                "UPDATE tasks SET checkpoint=? WHERE id=?", (json.dumps(checkpoint), self.task)
            )
        return result
