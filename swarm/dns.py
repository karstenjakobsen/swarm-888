from __future__ import annotations

import ipaddress
import json
import re
from collections.abc import Callable
from dataclasses import asdict, dataclass
from functools import cached_property
from typing import Literal, Protocol, cast

from .connectors import CredentialNeeded, RemoteMCP
from .state import State, digest, encode

DO_ENDPOINT = "https://networking.mcp.digitalocean.com/mcp"


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


class DNSProvider:
    def __init__(self, remote: RemoteMCP | Callable[[], RemoteMCP]):
        self._remote = remote

    @cached_property
    def remote(self) -> RemoteMCP:
        if callable(self._remote):
            return cast(Callable[[], RemoteMCP], self._remote)()
        return self._remote

    async def observe(self, intent: Intent) -> Observation:
        matches = []
        wildcard = False
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
                    record_name = record["name"].rstrip(".").lower()
                    if record_name in (intent.label, intent.hostname):
                        matches.append((record["type"], record["data"]))
                    fqdn = (
                        record_name
                        if record_name.endswith("." + intent.zone)
                        else record_name + "." + intent.zone
                    )
                    if fqdn.startswith("*.") and intent.hostname.endswith(fqdn[1:]):
                        wildcard = True
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
        if wildcard:
            return Observation(
                "conflict",
                "A wildcard may already serve this name. Review it before creating an exact record.",
            )
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

    def prepare_provider(self, task: str) -> bool:
        if not isinstance(self.provider, DNSProvider):
            return True
        try:
            destination = asdict(self.provider.remote.destination())
        except (OSError, ValueError) as exc:
            self.state.event(
                task,
                "question",
                {"text": str(exc) + ". Restore the connector binding and send recheck."},
            )
            return False
        with self.state.tx() as conn:
            checkpoint = json.loads(
                conn.execute("SELECT checkpoint FROM tasks WHERE id=?", (task,)).fetchone()[0]
            )
            previous = checkpoint.get("dns_destination")
            legacy = (
                previous is None
                and conn.execute(
                    "SELECT 1 FROM operations WHERE task=? AND target NOT LIKE 'https://%' LIMIT 1",
                    (task,),
                ).fetchone()
            )
            if (previous is not None and previous != destination) or (
                legacy and destination["endpoint"] != DO_ENDPOINT
            ):
                self.state.event(
                    task,
                    "question",
                    {
                        "text": "The DNS provider changed. Restore the original binding for this pending task."
                    },
                    conn,
                )
                return False
            if previous is None:
                checkpoint["dns_destination"] = destination
                conn.execute("UPDATE tasks SET checkpoint=? WHERE id=?", (encode(checkpoint), task))
        self.provider.remote.settings()
        return True

    async def observe_recovery(self, task: str) -> dict:
        with self.state.tx() as conn:
            entry = conn.execute(
                "SELECT run,checkpoint,status,kind FROM tasks WHERE id=?", (task,)
            ).fetchone()
            checkpoint = json.loads(entry["checkpoint"])
            recovery = checkpoint.get("dns_recovery", {})
            if (
                entry["kind"] != "dns"
                or entry["status"] != "running"
                or recovery.get("run") != entry["run"]
            ):
                raise ValueError("No pending DNS recovery for this run")
            row = conn.execute(
                "SELECT * FROM operations WHERE id=? AND task=? AND authority=? AND status='dispatched'",
                (recovery["operation"], task, task),
            ).fetchone()
            if not row or recovery["operation"] not in checkpoint.get("outstanding", []):
                raise ValueError("No outstanding dispatched DNS change")
            if conn.execute(
                "SELECT 1 FROM events WHERE task=? AND run=? AND kind='dns.recovery.request'",
                (task, entry["run"]),
            ).fetchone():
                raise ValueError("This recovery conversation already requested an observation")
            self.state.event(task, "dns.recovery.request", {"operation": row["id"]}, conn)
        outcome = await self.step(task, Intent(**json.loads(row["intent"])), observe_only=True)
        saved = self.state.one("SELECT evidence FROM operations WHERE id=?", row["id"])["evidence"]
        result = {
            "operation": row["id"],
            "outcome": outcome,
            "observation": json.loads(saved) if saved else None,
        }
        self.state.event(task, "dns.recovery.result", result)
        return result

    async def step(
        self, task: str, intent: Intent, revision: str | None = None, *, observe_only: bool = False
    ) -> str:
        op = digest([task, "dns", asdict(intent)])
        now = self.state.clock()
        with self.state.tx() as conn:
            conn.execute(
                "INSERT OR IGNORE INTO operations(id,task,authority,target,intent,rev,status,evidence,deadline) VALUES (?,?,?,?,?,?,'prepared','',?)",
                (
                    op,
                    task,
                    task,
                    intent.hostname,
                    encode(asdict(intent)),
                    revision,
                    now + self.seconds,
                ),
            )
            entry = conn.execute("SELECT kind,checkpoint FROM tasks WHERE id=?", (task,)).fetchone()
            checkpoint = json.loads(entry["checkpoint"])
            if op not in checkpoint["operations"]:
                checkpoint["operations"].append(op)
                checkpoint.setdefault("outstanding", []).append(op)
                if entry["kind"] == "dns":
                    checkpoint["criteria"] = (
                        f"one A record at {intent.hostname} equals {intent.address}"
                    )
                checkpoint["next"] = "Read complete provider zone before any write"
                conn.execute("UPDATE tasks SET checkpoint=? WHERE id=?", (encode(checkpoint), task))
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
                checkpoint["outstanding"] = [
                    k for k in checkpoint.get("outstanding", []) if k != op
                ]
                checkpoint["next"] = (
                    "Inspect the remaining authorized operations"
                    if checkpoint["outstanding"]
                    else "Complete the task with the observed provider record"
                )
            conn.execute("UPDATE tasks SET checkpoint=? WHERE id=?", (encode(checkpoint), task))

        self.state.event(task, "dns.observation", {"operation": op, **asdict(observed)})
        if observed.status in ("healthy", "conflict"):
            status = "verified" if observed.status == "healthy" else "conflict"
            self.state.change("UPDATE operations SET status=? WHERE id=?", status, op)
            return status
        if (
            not observe_only
            and observed.status == "absent"
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
