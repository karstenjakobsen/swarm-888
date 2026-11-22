from __future__ import annotations

import asyncio
import json
import os
import re
import shlex
from dataclasses import asdict
from typing import Protocol

from .catalog import Catalog
from .connectors import ConnectorObservations, RemoteMCP
from .dns import (
    DO_ENDPOINT,
    CredentialNeeded,
    DNSProvider,
    DNSReconciler,
    Intent,
    Provider,
)
from .goals import Maintenance
from .learning import Learning
from .publishing import Publisher, Site
from .state import State, encode, identity, name
from .tools import TaskTools


class Runtime(Protocol):
    async def run(self, app: Application, task: dict) -> str: ...
    async def interrupt(self) -> None: ...
    async def steer(self, text: str) -> None: ...


class Application:
    def __init__(
        self, state: State, catalog: Catalog, runtime: Runtime, provider: Provider | None = None
    ):
        self.state, self.catalog, self.runtime = state, catalog, runtime
        self.observations = ConnectorObservations(state, catalog)
        self.dns = DNSReconciler(
            state, provider or DNSProvider(lambda: self.observations.dns_remote(DO_ENDPOINT))
        )
        self.maintenance = Maintenance(state, catalog)
        self.learning = Learning(state, catalog)
        self.publisher = Publisher(state, catalog, self.dns)
        self.model_task: str | None = None
        self.lock = asyncio.Lock()
        self.current: str | None = None

    @property
    def remote(self) -> RemoteMCP:
        if isinstance(self.dns.provider, DNSProvider):
            return self.dns.provider.remote
        return self.observations.dns_remote(DO_ENDPOINT)

    def recover(self) -> None:
        with self.state.tx() as conn:
            for row in conn.execute(
                "SELECT * FROM tasks WHERE status IN ('running','stopping')"
            ).fetchall():
                status = "interrupted" if row["status"] == "stopping" else "queued"
                run = identity()
                checkpoint = json.loads(row["checkpoint"])
                if row["kind"] == "dns" and status == "queued":
                    dispatched = conn.execute(
                        "SELECT id FROM operations WHERE task=? AND authority=? AND status='dispatched'",
                        (row["id"], row["id"]),
                    ).fetchone()
                    if dispatched and dispatched["id"] in checkpoint.get("outstanding", []):
                        checkpoint["dns_recovery"] = {"operation": dispatched["id"], "run": run}
                        checkpoint["next"] = (
                            "Call connector_observe_recovery once to query the provider for this dispatched operation."
                        )
                conn.execute(
                    "UPDATE tasks SET status=?,thread=NULL,turn=NULL,run=?,checkpoint=? WHERE id=?",
                    (status, run, encode(checkpoint), row["id"]),
                )
                self.state.event(
                    row["id"],
                    "recovery",
                    {"previous_run": row["run"], "checkpoint": checkpoint},
                    conn,
                )

    def submit(self, text: str) -> str:
        text = self.state.redact(text.strip())
        if not text or len(text) > 24000:
            raise ValueError("Supply a task of 1–24000 characters")
        kind = "chat"
        request = {"text": text}
        publish = re.fullmatch(
            r"publish (?:the )?([a-z][a-z0-9-]*) (?:service )?at ([a-z0-9.-]+) with TLS[.!]?",
            text,
            re.I,
        )
        project = re.match(
            r"(?:build|create|update|develop|edit) (?:a |an |the )?project (?:named |called )?([a-z][a-z0-9-]{0,47})\b",
            text,
            re.I,
        )
        if project:
            kind = "project"
            request = {"project": name(project[1].lower()), "text": text}
        elif publish:
            kind = "publish"
            request = {
                "service": name(publish[1].lower()),
                "hostname": publish[2].lower(),
                "skill": "publish-service",
            }
        elif text.startswith("/"):
            # These commands end in the owner's free-form request, including apostrophes.
            command = text.split(None, 1)[0]
            prose_after = {"/observe": 3, "/project": 2}.get(command)
            parts = text.split(None, prose_after) if prose_after else shlex.split(text)
            kind = parts[0][1:]
            match [kind, *parts[1:]]:
                case ["observe", connector, query, *request_words]:
                    request = {
                        "connector": name(connector),
                        "query": name(query),
                        "request": " ".join(request_words),
                    }
                case ["learn", call]:
                    request = self.learning.request(call)
                case ["project", project_name, *instructions] if instructions:
                    request = {"project": name(project_name), "text": " ".join(instructions)}
                case ["publish", service] | ["publish", service, _]:
                    request = {
                        "service": name(service),
                        "hostname": parts[2] if len(parts) == 3 else None,
                        "skill": "publish-service",
                    }
                case ["dns", zone, label, address]:
                    Intent(zone, label, address)
                    request = {"zone": zone, "label": label, "address": address}
                case ["maintain", resource, mode, skill, interval]:
                    request = {
                        "resource": name(resource),
                        "mode": mode,
                        "skill": name(skill),
                        "interval": int(interval),
                    }
                case [("pause" | "resume" | "retire"), goal]:
                    request = {"goal": goal}
                case [("diagnose" | "improve"), incident] | ["rebind", incident, _]:
                    request = {
                        "incident": incident,
                        "revision": parts[2] if kind == "rebind" else None,
                    }
                case _:
                    raise ValueError("Unknown operator command or missing arguments")
        task = identity()
        checkpoint = {
            "goal": text,
            "kind": kind,
            "criteria": "Check the requested outcome against observed results",
            "last_verified": None,
            "operations": [],
            "revisions": [],
            "next": "Inspect active skills and prior evidence",
        }
        if kind == "learn":
            checkpoint.update(
                source_call=request["source_call"],
                skill=request["skill"],
                revisions=[request["previous"]],
                criteria="A newly tested revision passes the previously failed independent comparison",
                next="Read skill-author and skill_evidence for the source call. Reproduce the failure, add a minimal regression test, revise, test and activate the skill.",
            )
        with self.state.tx() as conn:
            conn.execute(
                "INSERT INTO tasks(id,goal,status,checkpoint,created,run,input,kind) VALUES (?,?,'queued',?,?,?,?,?)",
                (
                    task,
                    text,
                    encode(checkpoint),
                    self.state.clock(),
                    identity(),
                    encode(request),
                    kind,
                ),
            )
            self.state.event(task, "owner.message", {"text": text}, conn)
        return task

    def tools(self, task: str) -> TaskTools:
        return TaskTools(self.state, self.catalog, task, self.maintenance, self.dns)

    def context(self, task: dict) -> str:
        earlier = self.state.rows(
            "SELECT kind,data FROM events WHERE task=? AND kind IN ('owner.followup','skill.active','tool.completed','question') ORDER BY id DESC LIMIT 8",
            task["id"],
        )
        return encode(
            {
                "purpose": os.getenv(
                    "SWARM_PURPOSE",
                    "Maintain this owner's local projects and reusable operational skills.",
                ),
                "owner_instructions": os.getenv("SWARM_INSTRUCTIONS", ""),
                "checkpoint": json.loads(task["checkpoint"]),
                "index": self.catalog.search(),
                "recent_evidence": list(reversed(earlier)),
            }
        )[:32000]

    async def follow(self, task: str, text: str) -> None:
        row = self.state.one("SELECT * FROM tasks WHERE id=?", task)
        if (
            row["kind"] == "observe"
            and row["status"] in ("waiting", "unknown")
            and text.strip().lower() == "recheck"
        ):
            with self.state.tx() as conn:
                conn.execute(
                    "UPDATE connector_observations SET attempts=0,deadline=NULL WHERE task=? AND result IS NULL",
                    (task,),
                )
                conn.execute(
                    "UPDATE tasks SET status='queued',wake=0,run=? WHERE id=?", (identity(), task)
                )
                self.state.event(task, "owner.followup", {"text": "recheck"}, conn)
            return
        if (
            row["kind"] in ("dns", "publish")
            and row["status"] in ("waiting", "unknown")
            and text.strip().lower() == "recheck"
        ):
            with self.state.tx() as conn:
                previous = conn.execute(
                    "SELECT 1 FROM events WHERE task=? AND kind='dns.dispatch'", (task,)
                ).fetchone()
                conn.execute(
                    "UPDATE operations SET status=?,attempts=0,deadline=? WHERE task=? AND target NOT LIKE 'https://%' AND status IN ('unknown','conflict')",
                    (
                        "dispatched" if previous else "prepared",
                        self.state.clock() + self.dns.seconds,
                        task,
                    ),
                )
                conn.execute(
                    "UPDATE tasks SET status='queued',wake=0,run=? WHERE id=?", (identity(), task)
                )
                if row["kind"] == "publish":
                    conn.execute(
                        "UPDATE operations SET attempts=0,deadline=? WHERE task=? AND target LIKE 'https://%'",
                        (self.state.clock() + 600, task),
                    )
                self.state.event(task, "owner.followup", {"text": "recheck"}, conn)
            return
        if row["status"] == "credential":
            raise ValueError("Supply the pending credential to resume this task")
        if row["kind"] not in (
            "chat",
            "project",
            "maintain",
            "diagnose",
            "improve",
            "publish",
            "observe",
        ):
            raise ValueError("Use an explicit owner command to change this operation")
        text = self.state.redact(text.strip())
        if not 1 <= len(text) <= 24000:
            raise ValueError("Invalid follow-up")
        self.state.event(task, "owner.followup", {"text": text})
        if self.model_task == task and row["status"] == "running":
            await self.runtime.steer(text)
            return
        if self.current == task and row["status"] != "waiting":
            raise ValueError("Turn is finishing. Retry the follow-up shortly")
        self.state.change(
            "UPDATE tasks SET status='queued',wake=0,run=? WHERE id=?", identity(), task
        )

    async def stop(self, task: str) -> None:
        row = self.state.one("SELECT * FROM tasks WHERE id=?", task)
        if row["status"] not in ("queued", "running", "waiting", "credential", "observing"):
            raise ValueError("This task has already stopped")
        if self.model_task == task:
            self.state.change("UPDATE tasks SET status='stopping' WHERE id=?", task)
            await self.runtime.interrupt()
        else:
            self.state.change("UPDATE tasks SET status='interrupted' WHERE id=?", task)
        self.state.event(
            task,
            "owner.interrupt",
            {"observed": self.state.one("SELECT status FROM tasks WHERE id=?", task)["status"]},
        )

    def credential(self, task: str, token: str) -> None:
        row = self.state.one("SELECT kind,status,input,checkpoint FROM tasks WHERE id=?", task)
        if row["kind"] not in ("dns", "publish", "observe") or row["status"] != "credential":
            raise ValueError("This task has no outstanding credential request")
        if row["kind"] == "observe":
            remote, _ = self.observations.binding(task, json.loads(row["input"]))
        else:
            remote = self.remote
        dest = remote.destination()
        with self.state.tx() as conn:
            current = conn.execute(
                "SELECT status,checkpoint FROM tasks WHERE id=?", (task,)
            ).fetchone()
            checkpoint = json.loads(current["checkpoint"])
            challenge = checkpoint.pop("credential_request", None)
            legacy = (
                row["kind"] in ("dns", "publish")
                and dest.endpoint == DO_ENDPOINT
                and dest.secret == "digitalocean"
            )
            if current["status"] != "credential" or (
                challenge != asdict(dest) and not (challenge is None and legacy)
            ):
                raise ValueError("The pending credential destination has changed")
            self.state.secret(dest.slot, token)
            conn.execute(
                "UPDATE tasks SET status='queued',wake=0,checkpoint=? WHERE id=?",
                (encode(checkpoint), task),
            )
            self.state.event(
                task,
                "credential.supplied",
                {"destination": dest.endpoint, "secret": dest.secret},
                conn,
            )

    async def step(self) -> bool:
        async with self.lock:
            rows = self.state.rows(
                "SELECT * FROM tasks WHERE status IN ('queued','observing') AND wake<=? ORDER BY created LIMIT 1",
                self.state.clock(),
            )
            if not rows:
                return self.maintenance.tick()
            row = rows[0]
            key = row["id"]
            self.current = key
            try:
                self.state.change("UPDATE tasks SET status='running' WHERE id=?", key)
                self.state.event(key, "run.started", {"run": row["run"], "worker_uid": os.getuid()})
                status = await self.execute(row)
                self.state.change(
                    "UPDATE tasks SET status=? WHERE id=? AND status IN ('running','stopping')",
                    status,
                    key,
                )
            except CredentialNeeded as exc:
                with self.state.tx() as conn:
                    current = conn.execute(
                        "SELECT status,checkpoint FROM tasks WHERE id=?", (key,)
                    ).fetchone()
                    if current["status"] == "running":
                        checkpoint = json.loads(current["checkpoint"])
                        checkpoint["credential_request"] = asdict(exc.destination)
                        conn.execute(
                            "UPDATE tasks SET status='credential',checkpoint=? WHERE id=?",
                            (encode(checkpoint), key),
                        )
                        self.state.event(
                            key,
                            "credential.required",
                            {
                                "secret": exc.destination.secret,
                                "destination": exc.destination.endpoint,
                            },
                            conn,
                        )
            except Exception as exc:
                self.state.change("UPDATE tasks SET status='failed' WHERE id=?", key)
                self.state.event(
                    key, "run.failed", {"error": str(exc)[:2000] or type(exc).__name__}
                )
            finally:
                self.current = None
            self.state.event(
                key, "run.status", self.state.one("SELECT status FROM tasks WHERE id=?", key)
            )
            return True

    async def run_model(self, row: dict) -> str:
        self.model_task = row["id"]
        try:
            return await self.runtime.run(self, row)
        finally:
            self.model_task = None

    async def recover_dns(self, row: dict, intent: Intent, operation: dict) -> str:
        key = row["id"]
        started = self.state.rows(
            "SELECT 1 FROM events WHERE task=? AND run=? AND kind='dns.recovery.thread'",
            key,
            row["run"],
        )
        remaining = operation["deadline"] - self.state.clock()
        if not started and operation["attempts"] < self.dns.limit and remaining > 0:
            self.state.event(key, "dns.recovery.thread", {"operation": operation["id"]})
            try:
                async with asyncio.timeout(min(remaining, 90)):
                    await self.run_model(row)
            except Exception as exc:
                self.state.event(
                    key, "dns.recovery.runtime", {"error": str(exc)[:500] or type(exc).__name__}
                )
            if self.state.one("SELECT status FROM tasks WHERE id=?", key)["status"] != "running":
                return "interrupted"
            results = self.state.rows(
                "SELECT data FROM events WHERE task=? AND run=? AND kind='dns.recovery.result'",
                key,
                row["run"],
            )
            if results:
                return json.loads(results[0]["data"])["outcome"]
        return await self.dns.step(key, intent, observe_only=True)

    async def execute(self, row: dict) -> str:
        key, kind = row["id"], row["kind"]
        req = json.loads(row["input"])
        if kind == "observe":
            status = await self.observations.step(key, req)
            if status != "verified":
                return status
            current = self.state.one("SELECT status,checkpoint FROM tasks WHERE id=?", key)
            if current["status"] != "running":
                return current["status"]
            if not req["request"] and not self.state.rows(
                "SELECT 1 FROM events WHERE task=? AND kind='owner.followup' AND json_extract(data,'$.text')<>'recheck' LIMIT 1",
                key,
            ):
                return "verified"
            row = {**row, "checkpoint": current["checkpoint"]}
            outcome = await self.run_model(row)
            return "answered" if outcome == "completed" else outcome
        if kind == "learn":
            if self.learning.finish(key, req):
                return "verified"
            self.learning.consume(key, req, "start conversation")
            self.learning.reproduce(key, req)
            async with asyncio.timeout(max(0, req["deadline"] - self.state.clock())):
                outcome = await self.run_model(row)
            if outcome != "completed":
                return outcome
            if not self.learning.finish(key, req):
                raise ValueError(
                    "The original failure still needs a tested and activated correction"
                )
            return "verified"
        if kind == "dns":
            checkpoint = json.loads(row["checkpoint"])
            operations = checkpoint["operations"]
            if operations:
                journal = self.state.one(
                    "SELECT * FROM operations WHERE id=? AND task=? AND authority=?",
                    operations[0],
                    key,
                    key,
                )
                req = json.loads(journal["intent"])
            if not self.dns.prepare_provider(key):
                return "waiting"
            if operations and checkpoint.get("dns_recovery", {}).get("run") == row["run"]:
                outcome = await self.recover_dns(row, Intent(**req), journal)
            else:
                outcome = await self.dns.step(key, Intent(**req))
            if outcome == "observe":
                self.state.change("UPDATE tasks SET wake=? WHERE id=?", self.state.clock() + 2, key)
                return "observing"
            return "waiting" if outcome == "conflict" else outcome
        if kind in ("pause", "resume", "retire"):
            self.maintenance.control(req["goal"], kind)
            return "verified"
        if kind in ("diagnose", "improve", "rebind"):
            result = self.maintenance.followup(req["incident"], req["revision"])
            self.state.event(key, "incident.followup", result)
            if kind == "rebind":
                return "verified"
            checkpoint = json.loads(row["checkpoint"])
            checkpoint["incident"] = result
            checkpoint["next"] = (
                "Diagnose the recorded observation. For an improvement, stage and test the smallest regression before activation."
            )
            row = {**row, "checkpoint": encode(checkpoint)}
            self.state.change("UPDATE tasks SET checkpoint=? WHERE id=?", row["checkpoint"], key)
            async with asyncio.timeout(max(0, result["deadline"] - self.state.clock())):
                outcome = await self.run_model(row)
            return "answered" if outcome == "completed" else outcome
        if kind == "publish":
            try:
                site = Site.configured(req["service"], req["hostname"])
            except (OSError, ValueError, KeyError, TypeError) as exc:
                self.state.event(
                    key,
                    "question",
                    {
                        "text": f"Ingress binding unavailable: {exc}. Supply the binding and send recheck."
                    },
                )
                return "waiting"
        if kind == "project":
            self.tools(key).projects.recover(key)
            row["checkpoint"] = self.state.one("SELECT checkpoint FROM tasks WHERE id=?", key)[
                "checkpoint"
            ]
        if kind in ("chat", "project") or not self.state.rows(
            "SELECT * FROM active WHERE name=?", req["skill"]
        ):
            outcome = await self.run_model(row)
            if outcome != "completed":
                return outcome
            current = self.state.one("SELECT status FROM tasks WHERE id=?", key)["status"]
            if current != "running":
                return current
        if kind == "publish":
            if not self.dns.prepare_provider(key):
                return "waiting"
            rev = json.loads(row["checkpoint"]).get("publish_revision") or self.catalog.active(
                req["skill"]
            )
            status = await self.publisher.step(key, site, rev)
            if status == "observing":
                self.state.change("UPDATE tasks SET wake=? WHERE id=?", self.state.clock() + 5, key)
            return status
        if kind == "maintain":
            existing = self.state.rows("SELECT id FROM goals WHERE authority=?", key)
            if not existing:
                self.maintenance.add(key, **req)
            return "verified"
        return "answered"

    async def loop(self) -> None:
        while True:
            self.state.deliver_alerts()
            if not await self.step():
                await asyncio.sleep(0.3)

    def summary(self) -> dict:
        return {
            "installation": self.state.one("SELECT value FROM meta WHERE key='installation'")[
                "value"
            ],
            "uid": os.getuid(),
            "fixture_uid": self.maintenance.host.uid,
            "tasks": self.state.rows(
                "SELECT id,goal,status,created FROM tasks ORDER BY created DESC LIMIT 40"
            ),
            "skills": self.catalog.search(),
            "memories": self.state.rows("SELECT * FROM memories ORDER BY updated DESC LIMIT 100"),
            "goals": self.state.rows("SELECT * FROM goals"),
            "incidents": self.maintenance.summaries(),
        }

    def artifact(self, key: str) -> dict:
        return self.catalog.revision(key)

    def task_summary(self, task: str) -> dict:
        return self.state.one(
            """SELECT id,goal,status,created,
            json_extract(checkpoint,'$.credential_request.endpoint') AS credential_destination
            FROM tasks WHERE id=?""",
            task,
        )

    def skill_view(self, key: str) -> dict:
        return {
            "active": self.catalog.read(key),
            "revisions": self.state.rows(
                "SELECT rev,origin,tests,passed FROM revisions WHERE name=?", key
            ),
            "calls": self.state.rows(
                "SELECT c.* FROM calls c JOIN revisions r ON c.rev=r.rev WHERE r.name=? ORDER BY c.rowid DESC LIMIT 100",
                key,
            ),
            "operations": self.state.rows(
                """SELECT o.id,o.authority,o.target,o.rev,o.status,o.evidence FROM operations o
                JOIN revisions r ON r.rev=o.rev WHERE r.name=? ORDER BY o.rowid DESC LIMIT 100""",
                key,
            ),
            "failures": self.state.rows(
                """SELECT e.task,e.data,e.at FROM events e JOIN revisions r
                ON r.rev=json_extract(e.data,'$.revision') WHERE r.name=? AND e.kind='skill.failed'
                ORDER BY e.id DESC LIMIT 100""",
                key,
            ),
        }
