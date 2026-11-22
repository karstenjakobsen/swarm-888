import hashlib
import secrets
import sqlite3
import time
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from uuid import uuid4

from .config import Settings
from .contracts import Event, Kind, Outcome, OwnerMessage, Profile, Snapshot, TaskState

SCHEMA = (
    "CREATE TABLE profile(id TEXT PRIMARY KEY, name TEXT, purpose TEXT, instructions TEXT)",
    """CREATE TABLE tasks(id TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, text TEXT NOT NULL,
       checkpoint TEXT NOT NULL CHECK(checkpoint IN ('queued','running','completed')))""",
    """CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL,
       task TEXT NOT NULL REFERENCES tasks(id), kind TEXT NOT NULL, text TEXT NOT NULL)""",
    "CREATE TABLE sessions(digest TEXT PRIMARY KEY, expires REAL NOT NULL)",
)


def event_from_row(row: sqlite3.Row) -> Event:
    kind = row["kind"]
    key, label = {
        "received": ("working", "Queued"),
        "owner_message": ("working", "Queued"),
        "started": ("working", "Working"),
        "answered": ("unverified", "Acknowledged"),
        "completed": ("unverified", "Acknowledged"),
    }[kind]
    return Event(
        **dict(row), outcome=Outcome(key=key, label=label, seq=row["seq"], why=row["text"])
    )


class State:
    def __init__(self, settings: Settings):
        settings.prepare()
        self.path = settings.directory / "operator.sqlite3"
        with self.transaction(write=True) as db:
            version = db.execute("PRAGMA user_version").fetchone()[0]
            if version > 1:
                raise ValueError(f"Unsupported state schema {version}")
            if version == 0:
                for statement in SCHEMA:
                    db.execute(statement)
                db.execute(
                    "INSERT INTO profile VALUES (?,?,?,?)",
                    (uuid4().hex, settings.name, settings.purpose, settings.instructions),
                )
                db.execute("PRAGMA user_version=1")

    @contextmanager
    def transaction(self, *, write=False) -> Iterator[sqlite3.Connection]:
        db = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        db.row_factory = sqlite3.Row
        try:
            db.execute("PRAGMA foreign_keys=ON")
            db.execute("BEGIN IMMEDIATE" if write else "BEGIN")
            yield db
            db.commit()
        finally:
            db.close()  # Rolls back any unfinished transaction.

    @staticmethod
    def append(db: sqlite3.Connection, task: str, kind: Kind, text: str):
        db.execute(
            "INSERT INTO events(at,task,kind,text) VALUES (?,?,?,?)",
            (datetime.now(UTC).isoformat(), task, kind, text),
        )

    def submit(self, command: OwnerMessage) -> str:
        with self.transaction(write=True) as db:
            request_id = str(command.requestId)
            existing = db.execute(
                "SELECT id,text FROM tasks WHERE request_id=?", (request_id,)
            ).fetchone()
            if existing:
                if existing["text"] != command.text:
                    raise ValueError("Request ID already used with different text")
                return existing["id"]
            task = uuid4().hex
            db.execute(
                "INSERT INTO tasks VALUES (?,?,?,'queued')", (task, request_id, command.text)
            )
            self.append(db, task, "received", command.text)
            self.append(db, task, "owner_message", command.text)
            return task

    def claim(self) -> str | None:
        with self.transaction(write=True) as db:
            row = db.execute(
                "SELECT id,checkpoint FROM tasks WHERE checkpoint!='completed' ORDER BY rowid LIMIT 1"
            ).fetchone()
            if row is None:
                return None
            task = row["id"]
            if row["checkpoint"] == "queued":
                db.execute("UPDATE tasks SET checkpoint='running' WHERE id=?", (task,))
                self.append(db, task, "started", "The worker picked up this message.")
            return task

    def finish(self, task: str, answer: str):
        with self.transaction(write=True) as db:
            changed = db.execute(
                "UPDATE tasks SET checkpoint='completed' WHERE id=? AND checkpoint='running'",
                (task,),
            ).rowcount
            if changed:
                self.append(db, task, "answered", answer)
                self.append(db, task, "completed", "The worker acknowledged the owner’s message.")

    def snapshot(self) -> Snapshot:
        with self.transaction() as db:
            profile = Profile(**dict(db.execute("SELECT * FROM profile").fetchone()))
            events = [
                event_from_row(row) for row in db.execute("SELECT * FROM events ORDER BY seq")
            ]
            latest = {event.task: event.outcome for event in events}
            tasks = [
                TaskState(**dict(row), outcome=latest[row["id"]])
                for row in db.execute("SELECT id,checkpoint FROM tasks ORDER BY rowid")
            ]
            return Snapshot(
                profile=profile, cursor=events[-1].seq if events else 0, tasks=tasks, events=events
            )

    def after(self, cursor: int) -> list[Event]:
        with self.transaction() as db:
            rows = db.execute("SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT 128", (cursor,))
            return [event_from_row(row) for row in rows]

    def new_session(self, lifetime: int) -> str:
        token = secrets.token_urlsafe(32)
        with self.transaction(write=True) as db:
            db.execute("DELETE FROM sessions WHERE expires<=?", (time.time(),))
            db.execute(
                "INSERT INTO sessions VALUES (?,?)", (self.digest(token), time.time() + lifetime)
            )
        return token

    @staticmethod
    def digest(token: str) -> str:
        return hashlib.sha256(token.encode()).hexdigest()

    def authenticated(self, token: str) -> bool:
        with self.transaction() as db:
            return (
                db.execute(
                    "SELECT 1 FROM sessions WHERE digest=? AND expires>?",
                    (self.digest(token), time.time()),
                ).fetchone()
                is not None
            )
