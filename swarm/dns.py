from __future__ import annotations

import asyncio
import ipaddress
import json
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Literal, Protocol

import httpx
import jsonschema
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

from .state import State, digest, encode

DO_ENDPOINT = "https://networking.mcp.digitalocean.com/mcp"


class CredentialNeeded(ValueError):
    pass


@dataclass(frozen=True)
class Intent:
    zone: str
    label: str
    address: str

    def __post_init__(self) -> None:
        labels = self.zone.split(".") + self.label.split(".")
        if len(self.zone.split(".")) < 2 or any(
            not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", part) for part in labels
        ):
            raise ValueError("Supply a zone and relative record name")
        ipaddress.IPv4Address(self.address)

    @property
    def hostname(self) -> str:
        return f"{self.label}.{self.zone}"


@dataclass(frozen=True)
class Observation:
    status: Literal["healthy", "absent", "conflict", "unknown"]
    evidence: str


class Provider(Protocol):
    async def observe(self, intent: Intent) -> Observation: ...
    async def create(self, intent: Intent, operation: str) -> None: ...


class RemoteMCP:
    def __init__(self, state: State, definition: Path, bindings: dict[str, str]):
        self.state = state
        self.definition = definition
        self.bindings = bindings

    def settings(self) -> tuple[str, str]:
        doc = json.loads(self.definition.read_text())
        key = doc["secret"]
        if (
            key not in self.bindings
            or doc["endpoint"] != self.bindings[key]
            or doc["authentication"] != "bearer"
        ):
            raise ValueError("Connector destination has no matching owner grant")
        path = self.state.path / "secrets" / (key + ".key")
        if not path.is_file():
            raise CredentialNeeded(key)
        return doc["endpoint"], path.read_text()

    async def call(self, name: str | None = None, arguments: dict | None = None) -> Any:
        endpoint, secret = self.settings()
        async with (
            asyncio.timeout(25),
            httpx.AsyncClient(
                headers={"Authorization": "Bearer " + secret},
                follow_redirects=False,
                trust_env=False,
                timeout=10,
            ) as http,
        ):
            async with streamable_http_client(endpoint, http_client=http) as (reader, writer, _):
                async with ClientSession(reader, writer) as client:
                    await client.initialize()
                    cursor = None
                    tools = {}
                    for _ in range(32):
                        page = await client.list_tools(cursor=cursor)
                        tools.update({t.name: t for t in page.tools})
                        cursor = page.nextCursor
                        if not cursor:
                            break
                    if name is None:
                        return sorted(tools)
                    schema = tools[name].inputSchema
                    jsonschema.validate(arguments, schema)
                    response = await client.call_tool(name, arguments)
                    if response.isError:
                        raise ValueError("Provider reported a tool error")
                    if response.structuredContent is not None:
                        return self.state.redact(response.structuredContent)
                    return self.state.redact(json.loads(response.content[0].text))


class DNSProvider:
    def __init__(self, remote: RemoteMCP):
        self.remote = remote

    async def observe(self, intent: Intent) -> Observation:
        matches = []
        try:
            for page in range(1, 33):
                raw = await self.remote.call(
                    "domain-record-list", {"Domain": intent.zone, "Page": page, "PerPage": 100}
                )
                records = raw["domain_records"] if isinstance(raw, dict) else raw
                if not isinstance(records, list):
                    raise ValueError("Invalid record list")
                for record in records:
                    if not isinstance(record["name"], str) or not isinstance(record["type"], str):
                        raise ValueError("Invalid record")
                    if record["name"].rstrip(".").lower() in (intent.label, intent.hostname):
                        matches.append((record["type"], record["data"]))
                if len(records) < 100:
                    break
            else:
                return Observation("unknown", "Zone exceeds pagination budget")
        except CredentialNeeded:
            raise
        except Exception:
            return Observation("unknown", "Provider record list unavailable or inconclusive")
        if matches == [("A", intent.address)]:
            return Observation(
                "healthy", f"{intent.hostname} resolves in provider state to {intent.address}"
            )
        if matches:
            return Observation("conflict", "Existing records require owner direction")
        return Observation("absent", "Complete zone listing contains no matching name")

    async def create(self, intent: Intent, operation: str) -> None:
        # This provider tool exposes no idempotency-key parameter.
        await self.remote.call(
            "domain-record-create",
            {"Domain": intent.zone, "Name": intent.label, "Type": "A", "Data": intent.address},
        )


class DNSReconciler:
    def __init__(self, state: State, provider: Provider, limit: int = 4, seconds: int = 180):
        self.state, self.provider, self.limit, self.seconds = state, provider, limit, seconds

    async def step(self, task: str, intent: Intent) -> str:
        op = digest([task, "dns", asdict(intent)])
        now = self.state.clock()
        with self.state.tx() as conn:
            conn.execute(
                "INSERT OR IGNORE INTO operations(id,task,authority,target,intent,status,evidence,deadline) VALUES (?,?,?,?,?,'prepared','',?)",
                (op, task, task, intent.hostname, encode(asdict(intent)), now + self.seconds),
            )
            conn.execute(
                "UPDATE tasks SET checkpoint=? WHERE id=?",
                (
                    encode(
                        {
                            "goal": conn.execute(
                                "SELECT goal FROM tasks WHERE id=?", (task,)
                            ).fetchone()[0],
                            "criteria": f"one A record at {intent.hostname} equals {intent.address}",
                            "operations": [op],
                            "outstanding": [op],
                            "revisions": [],
                            "last_verified": "see operation evidence",
                            "next": "Read complete provider zone before any write",
                        }
                    ),
                    task,
                ),
            )
        row = self.state.one("SELECT * FROM operations WHERE id=?", op)
        if row["status"] in ("verified", "conflict", "unknown"):
            if row["status"] == "unknown":
                self.state.alert(op, "DNS outcome unknown for " + intent.hostname)
            return row["status"]
        if row["attempts"] >= self.limit or now >= row["deadline"]:
            self.state.change("UPDATE operations SET status='unknown' WHERE id=?", op)
            self.state.alert(op, "DNS outcome unknown for " + intent.hostname)
            return "unknown"
        self.state.change("UPDATE operations SET attempts=attempts+1 WHERE id=?", op)
        observed = await self.provider.observe(intent)
        evidence = {**asdict(observed), "at": self.state.clock()}
        with self.state.tx() as conn:
            conn.execute("UPDATE operations SET evidence=? WHERE id=?", (encode(evidence), op))
            checkpoint = json.loads(
                conn.execute("SELECT checkpoint FROM tasks WHERE id=?", (task,)).fetchone()[0]
            )
            checkpoint["last_verified"] = evidence
            if observed.status == "healthy":
                checkpoint["outstanding"] = []
                checkpoint["next"] = "Complete the task with the observed provider record"
            conn.execute("UPDATE tasks SET checkpoint=? WHERE id=?", (encode(checkpoint), task))

        self.state.event(task, "dns.observation", {"operation": op, **asdict(observed)})
        if observed.status in ("healthy", "conflict"):
            status = "verified" if observed.status == "healthy" else "conflict"
            self.state.change("UPDATE operations SET status=? WHERE id=?", status, op)
            return status
        if (
            observed.status == "absent"
            and row["status"] == "prepared"
            and self.state.clock() < row["deadline"]
        ):
            with self.state.tx() as conn:
                pending = conn.execute(
                    """SELECT o.id FROM operations o WHERE o.id<>? AND o.target=?
                    AND o.status IN ('dispatched','unknown','conflict')
                    AND EXISTS(SELECT 1 FROM events e WHERE e.task=o.task AND e.kind='dns.dispatch')
                    LIMIT 1""",
                    (op, intent.hostname),
                ).fetchone()
                if pending:
                    reason = {
                        "status": "conflict",
                        "prior_operation": pending["id"],
                        "evidence": "Earlier create has an unresolved outcome",
                    }
                    conn.execute(
                        "UPDATE operations SET status='conflict',evidence=? WHERE id=?",
                        (encode(reason), op),
                    )
                    self.state.event(task, "dns.conflict", reason, conn)
                    return "conflict"
                changed = conn.execute(
                    "UPDATE operations SET status='dispatched' WHERE id=? AND status='prepared' AND EXISTS (SELECT 1 FROM tasks WHERE id=? AND status='running')",
                    (op, task),
                ).rowcount
                if changed:
                    self.state.event(
                        task, "dns.dispatch", {"operation": op, "target": intent.hostname}, conn
                    )
            if changed:
                try:
                    await self.provider.create(intent, op)
                except Exception:
                    self.state.event(task, "dns.unknown", {"operation": op, "next": "observe"})
        return "observe"
