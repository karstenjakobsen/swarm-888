import hashlib
import json
import secrets
import sqlite3
import time
from collections.abc import Generator, Mapping
from contextlib import closing, contextmanager
from datetime import UTC, datetime
from uuid import UUID, uuid4

from pydantic import JsonValue

from .config import Settings
from .contracts import Event, Kind, Profile, Snapshot, TaskState

SCHEMA = (
    "CREATE TABLE profile(id TEXT PRIMARY KEY, name TEXT, purpose TEXT, instructions TEXT)",
    """CREATE TABLE tasks(id TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, text TEXT NOT NULL,
       checkpoint TEXT NOT NULL CHECK(checkpoint IN ('queued','running','completed')))""",
    """CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL,
       task TEXT NOT NULL REFERENCES tasks(id), kind TEXT NOT NULL, text TEXT NOT NULL)""",
    "CREATE TABLE sessions(digest TEXT PRIMARY KEY, expires REAL NOT NULL)",
)

SKILL_SCHEMA = (
    "ALTER TABLE events ADD COLUMN data TEXT NOT NULL DEFAULT '{}'",
    "ALTER TABLE tasks ADD COLUMN thread_id TEXT",
    """CREATE TABLE skill_revisions(skill TEXT NOT NULL, revision TEXT NOT NULL,
       author_task TEXT REFERENCES tasks(id), description TEXT NOT NULL, created TEXT NOT NULL,
       tests TEXT, PRIMARY KEY(skill, revision))""",
    """CREATE TABLE active_skills(skill TEXT PRIMARY KEY, revision TEXT NOT NULL,
       FOREIGN KEY(skill, revision) REFERENCES skill_revisions(skill, revision))""",
    """CREATE TABLE skill_calls(id INTEGER PRIMARY KEY, skill TEXT NOT NULL, revision TEXT NOT NULL,
       task TEXT REFERENCES tasks(id), arguments TEXT NOT NULL, result TEXT NOT NULL,
       FOREIGN KEY(skill, revision) REFERENCES skill_revisions(skill, revision))""",
)


VERIFICATION_SCHEMA = """CREATE TABLE docker_grades(task TEXT PRIMARY KEY REFERENCES tasks(id),
       skill TEXT NOT NULL, revision TEXT NOT NULL, selector TEXT NOT NULL,
       FOREIGN KEY(skill, revision) REFERENCES skill_revisions(skill, revision))"""

ACTIVATION_SCHEMA = (
    """CREATE TABLE skill_activations(id INTEGER PRIMARY KEY, skill TEXT NOT NULL,
       revision TEXT NOT NULL, task TEXT REFERENCES tasks(id), at TEXT NOT NULL, action TEXT NOT NULL,
       FOREIGN KEY(skill, revision) REFERENCES skill_revisions(skill, revision))""",
    """INSERT INTO skill_activations(skill,revision,task,at,action)
       SELECT json_extract(data,'$.skill'), json_extract(data,'$.revision'), task, at, 'activate'
       FROM events WHERE json_extract(data,'$.action')='skill_activated' ORDER BY seq""",
)


OPERATION_SCHEMA = """CREATE TABLE operations(
       id TEXT PRIMARY KEY, task TEXT UNIQUE NOT NULL REFERENCES tasks(id),
       intent TEXT NOT NULL, target TEXT NOT NULL, skill TEXT NOT NULL, revision TEXT NOT NULL,
       authorized_at TEXT NOT NULL, checkpoint TEXT NOT NULL,
       dispatches INTEGER NOT NULL DEFAULT 0, observations INTEGER NOT NULL DEFAULT 0,
       FOREIGN KEY(skill, revision) REFERENCES skill_revisions(skill, revision))"""

MEMORY_SCHEMA = (
    """CREATE TABLE memories(id TEXT PRIMARY KEY, title TEXT NOT NULL, kind TEXT NOT NULL,
       scope TEXT NOT NULL)""",
    """CREATE TABLE memory_versions(memory TEXT NOT NULL REFERENCES memories(id),
       revision INTEGER NOT NULL, text TEXT NOT NULL, removed INTEGER NOT NULL,
       writer TEXT NOT NULL REFERENCES tasks(id), at TEXT NOT NULL, PRIMARY KEY(memory,revision))""",
    """CREATE TABLE memory_reads(id INTEGER PRIMARY KEY, memory TEXT NOT NULL, revision INTEGER NOT NULL,
       task TEXT NOT NULL REFERENCES tasks(id), reason TEXT NOT NULL,
       FOREIGN KEY(memory,revision) REFERENCES memory_versions(memory,revision))""",
)


CREDENTIAL_SCHEMA = """CREATE TABLE credential_requests(
    id TEXT PRIMARY KEY, task TEXT NOT NULL REFERENCES tasks(id), connector TEXT NOT NULL,
    endpoint TEXT NOT NULL, secret_ref TEXT NOT NULL, supplied INTEGER NOT NULL DEFAULT 0,
    resume_needed INTEGER NOT NULL DEFAULT 1,
    UNIQUE(task,connector))"""

GOAL_SCHEMA = (
    "ALTER TABLE skill_revisions ADD COLUMN source TEXT NOT NULL DEFAULT 'docker.inspect_labeled'",
    "UPDATE skill_revisions SET source='authoring' WHERE skill='create-skill'",
    """CREATE TABLE standing_goals(
        id TEXT PRIMARY KEY, task TEXT NOT NULL REFERENCES tasks(id), filename TEXT NOT NULL,
        expected TEXT NOT NULL, skill TEXT NOT NULL, status TEXT NOT NULL,
        next_due REAL NOT NULL, interval INTEGER NOT NULL, UNIQUE(filename))""",
    """CREATE TABLE incidents(
        id TEXT PRIMARY KEY, goal TEXT NOT NULL REFERENCES standing_goals(id),
        opened REAL NOT NULL, deadline REAL NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        observations INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL,
        notified INTEGER NOT NULL DEFAULT 0, revision TEXT)""",
)
CONTROL_SCHEMA = """CREATE TABLE task_controls(
    id TEXT PRIMARY KEY,task TEXT NOT NULL REFERENCES tasks(id),kind TEXT NOT NULL,
    text TEXT NOT NULL,applied INTEGER NOT NULL DEFAULT 0)"""
INCIDENT_LIMIT_SCHEMA = (
    "ALTER TABLE incidents ADD COLUMN attempt_limit INTEGER NOT NULL DEFAULT 3",
    "ALTER TABLE incidents ADD COLUMN observation_limit INTEGER NOT NULL DEFAULT 8",
)


class RequestConflict(ValueError):
    """The client reused an accepted request ID with different content."""


class State:
    def __init__(self, settings: Settings):
        settings.prepare()
        self.settings = settings
        self.path = settings.directory / "operator.sqlite3"
        with self.transaction(write=True) as db:
            version = db.execute("PRAGMA user_version").fetchone()[0]
            if version > 10:
                raise ValueError(f"Unsupported state schema {version}")
            if version == 0:
                for statement in SCHEMA:
                    db.execute(statement)
                db.execute(
                    "INSERT INTO profile VALUES (?,?,?,?)",
                    (uuid4().hex, settings.name, settings.purpose, settings.instructions),
                )
            if version < 2:
                for statement in SKILL_SCHEMA:
                    db.execute(statement)
            if version < 3:
                db.execute(VERIFICATION_SCHEMA)
            if version < 4:
                for statement in ACTIVATION_SCHEMA:
                    db.execute(statement)
            if version < 5:
                db.execute(OPERATION_SCHEMA)
            if version < 6:
                for statement in MEMORY_SCHEMA:
                    db.execute(statement)
            if version < 7:
                db.execute(CREDENTIAL_SCHEMA)
            if version < 8:
                for statement in GOAL_SCHEMA:
                    db.execute(statement)
            if version < 9:
                db.execute(CONTROL_SCHEMA)
            if version < 10:
                for statement in INCIDENT_LIMIT_SCHEMA:
                    db.execute(statement)
                db.execute("PRAGMA user_version=10")

    @contextmanager
    def transaction(self, *, write: bool = False) -> Generator[sqlite3.Connection, None, None]:
        with (
            self.settings.database_identity(),
            closing(sqlite3.connect(self.path, timeout=10, isolation_level=None)) as db,
        ):
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA foreign_keys=ON")
            db.execute("BEGIN IMMEDIATE" if write else "BEGIN")
            yield db
            db.commit()

    @staticmethod
    def append(
        db: sqlite3.Connection,
        task: str,
        kind: Kind,
        text: str,
        data: Mapping[str, JsonValue] | None = None,
    ) -> None:
        db.execute(
            "INSERT INTO events(at,task,kind,text,data) VALUES (?,?,?,?,?)",
            (datetime.now(UTC).isoformat(), task, kind, text, json.dumps(dict(data or {}))),
        )

    @staticmethod
    def event(row: sqlite3.Row) -> Event:
        payload = dict(row)
        payload["data"] = json.loads(payload["data"])
        return Event.model_validate(payload)

    def submit(self, request_id: UUID, text: str) -> str:
        with self.transaction(write=True) as db:
            return self.enqueue(db, request_id, text)

    def enqueue(self, db: sqlite3.Connection, request_id: UUID, text: str) -> str:
        existing = db.execute(
            "SELECT id,text FROM tasks WHERE request_id=?", (str(request_id),)
        ).fetchone()
        if existing:
            if existing["text"] != text:
                raise RequestConflict("Request ID already used with different text")
            return existing["id"]
        task = uuid4().hex
        db.execute(
            "INSERT INTO tasks(id,request_id,text,checkpoint) VALUES (?,?,?,'queued')",
            (task, str(request_id), text),
        )
        self.append(db, task, "received", text)
        self.append(db, task, "owner_message", text)
        return task

    def claim(self) -> str | None:
        with self.transaction(write=True) as db:
            row = db.execute(
                """SELECT id,checkpoint FROM tasks WHERE checkpoint!='completed'
                   AND NOT EXISTS(SELECT 1 FROM credential_requests AS c WHERE c.task=tasks.id
                                  AND NOT c.supplied) ORDER BY rowid LIMIT 1"""
            ).fetchone()
            if row is None:
                return None
            task = row["id"]
            db.execute(
                "UPDATE credential_requests SET resume_needed=0 WHERE task=? AND supplied",
                (task,),
            )
            if row["checkpoint"] == "queued":
                db.execute("UPDATE tasks SET checkpoint='running' WHERE id=?", (task,))
                self.append(db, task, "started", "The worker picked up this message.")
            return task

    def finish(self, task: str, answer: str, summary: str, *, modeled: bool = False):
        with self.transaction(write=True) as db:
            changed = db.execute(
                """UPDATE tasks SET checkpoint='completed' WHERE id=? AND checkpoint='running'
                   AND NOT EXISTS(SELECT 1 FROM credential_requests WHERE task=tasks.id AND resume_needed)""",
                (task,),
            ).rowcount
            if changed:
                last = db.execute(
                    "SELECT kind FROM events WHERE task=? ORDER BY seq DESC LIMIT 1", (task,)
                ).fetchone()
                if last["kind"] == "failed":
                    return
                data: dict[str, JsonValue] = {"modeled": True} if modeled else {}
                self.append(db, task, "answered", answer, data)
                self.append(db, task, "completed", summary, data)

    def text(self, task: str) -> str:
        with self.transaction() as db:
            return db.execute("SELECT text FROM tasks WHERE id=?", (task,)).fetchone()[0]

    def control(self, task: str, request_id: UUID, kind: str, text: str = "") -> None:
        with self.transaction(write=True) as db:
            prior = db.execute(
                "SELECT task,kind,text FROM task_controls WHERE id=?", (str(request_id),)
            ).fetchone()
            if prior:
                if tuple(prior) != (task, kind, text):
                    raise RequestConflict("Request ID already used for a different instruction")
                return
            active = db.execute(
                """SELECT 1 FROM tasks WHERE id=? AND checkpoint!='completed'
                   AND NOT EXISTS(SELECT 1 FROM operations WHERE task=tasks.id)""",
                (task,),
            ).fetchone()
            if not active:
                raise RequestConflict("This task cannot be steered or stopped")
            if (
                kind == "steer"
                and db.execute(
                    "SELECT 1 FROM credential_requests WHERE task=? AND NOT supplied", (task,)
                ).fetchone()
            ):
                raise RequestConflict("Supply the requested credential before steering this task")
            db.execute(
                "INSERT INTO task_controls(id,task,kind,text) VALUES (?,?,?,?)",
                (str(request_id), task, kind, text),
            )
            if kind == "stop":
                db.execute("UPDATE tasks SET checkpoint='completed' WHERE id=?", (task,))
                self.append(db, task, "stopped", "The owner stopped this task.")
            else:
                self.append(db, task, "owner_message", text, {"intent": "steer"})

    def stopped(self, task: str) -> bool:
        with self.transaction() as db:
            return (
                db.execute(
                    "SELECT 1 FROM task_controls WHERE task=? AND kind='stop'", (task,)
                ).fetchone()
                is not None
            )

    def controls(self, task: str) -> list[sqlite3.Row]:
        with self.transaction() as db:
            return db.execute(
                "SELECT id,kind,text FROM task_controls WHERE task=? AND NOT applied ORDER BY rowid",
                (task,),
            ).fetchall()

    def control_applied(self, identity: str) -> None:
        with self.transaction(write=True) as db:
            db.execute("UPDATE task_controls SET applied=1 WHERE id=?", (identity,))

    def profile(self) -> Profile:
        with self.transaction() as db:
            return Profile.model_validate(dict(db.execute("SELECT * FROM profile").fetchone()))

    def thread(self, task: str) -> str | None:
        with self.transaction() as db:
            return db.execute("SELECT thread_id FROM tasks WHERE id=?", (task,)).fetchone()[0]

    def remember_thread(self, task: str, thread_id: str, mode: str) -> None:
        with self.transaction(write=True) as db:
            if not db.execute(
                "SELECT 1 FROM tasks WHERE id=? AND checkpoint='running'", (task,)
            ).fetchone():
                return
            db.execute("UPDATE tasks SET thread_id=? WHERE id=?", (thread_id, task))
            self.append(
                db, task, "evidence", f"Model mode: {mode}", {"action": "model", "mode": mode}
            )

    def fail(self, task: str, summary: str) -> None:
        with self.transaction(write=True) as db:
            if db.execute(
                """UPDATE tasks SET checkpoint='completed' WHERE id=? AND checkpoint='running'
                   AND NOT EXISTS(SELECT 1 FROM credential_requests WHERE task=tasks.id AND resume_needed)""",
                (task,),
            ).rowcount:
                last = db.execute(
                    "SELECT kind FROM events WHERE task=? ORDER BY seq DESC LIMIT 1", (task,)
                ).fetchone()
                if last["kind"] != "failed":
                    self.append(db, task, "failed", summary)

    def snapshot(self) -> Snapshot:
        with self.transaction() as db:
            profile = Profile(**dict(db.execute("SELECT * FROM profile").fetchone()))
            events = [self.event(row) for row in db.execute("SELECT * FROM events ORDER BY seq")]
            latest = {event.task: event.outcome for event in events if event.kind != "system"}
            tasks = [
                TaskState(**dict(row), outcome=latest[row["id"]])
                for row in db.execute("SELECT id,checkpoint FROM tasks ORDER BY rowid")
            ]
            return Snapshot(
                profile=profile, cursor=events[-1].seq if events else 0, tasks=tasks, events=events
            )

    def stream_head(self) -> tuple[str, int]:
        with self.transaction() as db:
            row = db.execute(
                "SELECT id, (SELECT COALESCE(MAX(seq),0) FROM events) FROM profile"
            ).fetchone()
            return row[0], row[1]

    def after(self, cursor: int) -> list[Event]:
        with self.transaction() as db:
            rows = db.execute("SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT 128", (cursor,))
            return [self.event(row) for row in rows]

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
