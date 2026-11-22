from __future__ import annotations

import contextlib
import fcntl
import hashlib
import json
import os
import re
import secrets
import sqlite3
import time
import uuid
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import httpx

from .notifications import Destination

ROOT = Path(__file__).resolve().parent.parent
NAME = r"[a-z][a-z0-9-]{0,47}"


def name(value: str) -> str:
    if not re.fullmatch(NAME, value):
        raise ValueError("Use a short lowercase identifier")
    return value


def encode(value: Any) -> str:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False
    )


def digest(value: Any) -> str:
    return hashlib.sha256(encode(value).encode()).hexdigest()


def identity() -> str:
    return uuid.uuid4().hex


def state_path() -> Path:
    return Path(os.environ.get("SWARM_STATE", "~/.local/state/swarm-888")).expanduser().resolve()


@contextlib.contextmanager
def exclusive(path: Path) -> Iterator[None]:
    with path.open("a") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise ValueError("Worker or maintenance command already running") from exc
        yield


SCHEMA = """
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks(
 id TEXT PRIMARY KEY, goal TEXT, status TEXT, thread TEXT, turn TEXT, checkpoint TEXT,
 created REAL, run TEXT, input TEXT, kind TEXT, wake REAL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS events(
 id INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT, run TEXT, kind TEXT, data TEXT, at REAL
);
CREATE INDEX IF NOT EXISTS event_task ON events(task,id);
CREATE TABLE IF NOT EXISTS memories(
 id TEXT PRIMARY KEY, scope TEXT, body TEXT, source TEXT, updated REAL
);
CREATE TABLE IF NOT EXISTS revisions(
 rev TEXT PRIMARY KEY, name TEXT, origin TEXT, author TEXT, spec TEXT, tests TEXT,
 passed INTEGER, created REAL
);
CREATE TABLE IF NOT EXISTS active(name TEXT PRIMARY KEY, rev TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS activations(id INTEGER PRIMARY KEY, name TEXT, rev TEXT, task TEXT);
CREATE TABLE IF NOT EXISTS calls(id TEXT PRIMARY KEY, task TEXT, rev TEXT, input_hash TEXT,
 result TEXT, checked TEXT, verified_reuse INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS call_inputs(call TEXT PRIMARY KEY, arguments TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS operations(
 id TEXT PRIMARY KEY, task TEXT, authority TEXT, target TEXT, intent TEXT, rev TEXT,
 status TEXT, evidence TEXT, attempts INTEGER DEFAULT 0, deadline REAL
);
CREATE TABLE IF NOT EXISTS goals(
 id TEXT PRIMARY KEY, authority TEXT, resource TEXT, mode TEXT, skill TEXT, rev TEXT,
 interval INTEGER, status TEXT, due REAL
);
CREATE TABLE IF NOT EXISTS incidents(
 id TEXT PRIMARY KEY, goal TEXT, status TEXT, attempts INTEGER, deadline REAL, evidence TEXT,
 next REAL, rev TEXT
);
CREATE TABLE IF NOT EXISTS alerts(id TEXT PRIMARY KEY, summary TEXT, at REAL);
CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY, delivered INTEGER, retry REAL);
"""


class State:
    def __init__(self, path: Path, clock: Callable[[], float] = time.time):
        self.path = path.resolve()
        if self.path == ROOT or ROOT in self.path.parents:
            raise ValueError("Choose a private state directory outside the checkout")
        self.path.mkdir(mode=0o700, parents=True, exist_ok=True)
        if self.path.stat().st_uid != os.getuid() or self.path.stat().st_mode & 0o077:
            raise ValueError("State directory must be private and owned by the worker")
        self.clock = clock
        self.notifications = Destination(
            Path(os.getenv("SWARM_NOTIFY_DIR", self.path / "notifications")),
            os.getenv("SWARM_NOTIFY_URL", ""),
        )
        self.db = self.path / "state.sqlite"
        with self.tx() as conn:
            conn.executescript(SCHEMA)
            conn.execute("INSERT OR IGNORE INTO meta VALUES ('installation',?)", (identity(),))
        for directory in ("workspaces", "fixtures", "secrets", "sessions", "objects"):
            (self.path / directory).mkdir(mode=0o700, exist_ok=True)

    @contextlib.contextmanager
    def tx(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.db, timeout=10)
        conn.row_factory = sqlite3.Row
        try:
            conn.execute("BEGIN IMMEDIATE")
            yield conn
            conn.commit()
        finally:
            conn.close()

    def rows(self, sql: str, *args: Any) -> list[dict]:
        with contextlib.closing(sqlite3.connect(self.db, timeout=10)) as conn:
            conn.row_factory = sqlite3.Row
            return [dict(r) for r in conn.execute(sql, args)]

    def one(self, sql: str, *args: Any) -> dict:
        rows = self.rows(sql, *args)
        if not rows:
            raise ValueError("Record does not exist")
        return rows[0]

    def change(self, sql: str, *args: Any) -> None:
        with self.tx() as conn:
            conn.execute(sql, args)

    def redact(self, value: Any) -> Any:
        def clean(text: str) -> str:
            for secret in known:
                text = text.replace(secret, "[redacted]")
            return re.sub(r"(?i)\b(bearer\s+|dop_v1_|sk-(?:proj-)?)[\w.=-]{4,}", "[redacted]", text)

        def walk(obj: Any) -> Any:
            if isinstance(obj, str):
                return clean(obj)
            if isinstance(obj, dict):
                return {clean(k): walk(v) for k, v in obj.items()}
            if isinstance(obj, list):
                return [walk(v) for v in obj]
            return obj

        known = [p.read_text() for p in (self.path / "secrets").glob("*.key")]
        known = [s for s in known if s]
        return walk(value)

    def secret(self, key: str, value: str) -> None:
        if not 4 <= len(value) <= 4096 or any(c.isspace() for c in value):
            raise ValueError("Invalid credential")
        path = self.path / "secrets" / (name(key) + ".key")
        tmp = path.with_suffix("." + secrets.token_hex(6))
        with tmp.open("x") as f:
            os.chmod(tmp, 0o600)
            f.write(value)
        tmp.replace(path)

    def event(
        self, task: str, kind: str, data: Any, conn: sqlite3.Connection | None = None
    ) -> None:
        if conn is None:
            with self.tx() as transaction:
                self.event(task, kind, data, transaction)
            return
        payload = encode(self.redact(data))
        if len(payload) > 24000:
            payload = encode({"excerpt": payload[:23000], "truncated": True})
        conn.execute(
            "INSERT INTO events(task,run,kind,data,at) VALUES (?,(SELECT run FROM tasks WHERE id=?),?,?,?)",
            (task, task, kind, payload, self.clock()),
        )

    def events(self, after: int = 0) -> list[dict]:
        rows = self.rows("SELECT * FROM events WHERE id>? ORDER BY id LIMIT 100", after)
        for row in rows:
            row["data"] = json.loads(row["data"])
        return rows

    def alert(self, key: str, summary: str) -> None:
        with self.tx() as conn:
            conn.execute(
                "INSERT OR IGNORE INTO alerts VALUES (?,?,?)",
                (key, self.redact(summary), self.clock()),
            )
            conn.execute("INSERT OR IGNORE INTO deliveries VALUES (?,0,0)", (key,))
        self.deliver_alerts()

    def deliver_alerts(self) -> None:
        pending = self.rows(
            "SELECT a.* FROM alerts a JOIN deliveries d ON d.id=a.id WHERE d.delivered=0 AND d.retry<=? LIMIT 10",
            self.clock(),
        )
        for row in pending:
            try:
                self.notifications.deliver(row["id"], encode(row))
            except (OSError, httpx.HTTPError):
                self.change(
                    "UPDATE deliveries SET retry=? WHERE id=?", self.clock() + 30, row["id"]
                )
            else:
                self.change("UPDATE deliveries SET delivered=1 WHERE id=?", row["id"])
