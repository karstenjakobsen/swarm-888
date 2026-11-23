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
from .contracts import Event, Kind, Outcome, Profile, Snapshot, TaskState

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
    operation TEXT NOT NULL DEFAULT '', UNIQUE(task,connector,secret_ref))"""

GOAL_SCHEMA = (
    "ALTER TABLE skill_revisions ADD COLUMN source TEXT NOT NULL DEFAULT 'legacy'",
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
CATALOG_SCHEMA = (
    """CREATE TABLE catalog_branches(
        id TEXT PRIMARY KEY, remote TEXT NOT NULL, branch TEXT NOT NULL,
        checkout TEXT NOT NULL UNIQUE, publisher TEXT NOT NULL, deploy_key INTEGER NOT NULL,
        revision TEXT NOT NULL, UNIQUE(remote,branch))""",
    """CREATE TABLE catalog_connections(
        kind TEXT PRIMARY KEY CHECK(kind IN ('skill','connector','project')),
        branch_id TEXT NOT NULL REFERENCES catalog_branches(id))""",
)
CATALOG_SKILL_SCHEMA = """CREATE TABLE catalog_skill_revisions(
    skill TEXT NOT NULL, revision TEXT NOT NULL, branch_id TEXT NOT NULL REFERENCES catalog_branches(id),
    path TEXT NOT NULL, PRIMARY KEY(skill,revision),
    FOREIGN KEY(skill,revision) REFERENCES skill_revisions(skill,revision))"""
CATALOG_PUBLISH_SCHEMA = (
    "ALTER TABLE catalog_branches ADD COLUMN remote_revision TEXT",
    "UPDATE catalog_branches SET remote_revision=revision",
    "ALTER TABLE catalog_branches ADD COLUMN published_revision TEXT",
    "ALTER TABLE catalog_branches ADD COLUMN publish_error TEXT",
)
CATALOG_MIGRATION_SCHEMA = (
    """CREATE TABLE catalog_migration(
       id INTEGER PRIMARY KEY CHECK(id=1), config TEXT NOT NULL, publisher TEXT NOT NULL,
       base_revision TEXT NOT NULL, revision TEXT NOT NULL, aliases TEXT NOT NULL,
       completed INTEGER NOT NULL DEFAULT 0)""",
    """CREATE TABLE catalog_legacy_ids(
       kind TEXT NOT NULL, legacy_id TEXT NOT NULL, canonical_id TEXT NOT NULL,
       PRIMARY KEY(kind,legacy_id))""",
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
            if version > 17:
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
            if version < 11:
                for statement in CATALOG_SCHEMA:
                    db.execute(statement)
            if version < 12:
                db.execute(CATALOG_SKILL_SCHEMA)
            if version < 13:
                for statement in CATALOG_PUBLISH_SCHEMA:
                    db.execute(statement)
            if version < 14:
                for statement in CATALOG_MIGRATION_SCHEMA:
                    db.execute(statement)
            if version < 16:
                self.migrate_model_runs(db)
            if version < 17:
                # Each operation may require a different credential, even in the same task.
                if version >= 7:
                    db.execute("ALTER TABLE credential_requests RENAME TO previous_credentials")
                    db.execute(CREDENTIAL_SCHEMA)
                    columns = "id,task,connector,endpoint,secret_ref,supplied,resume_needed"
                    db.execute(
                        f"INSERT INTO credential_requests({columns}) SELECT {columns} FROM previous_credentials"
                    )
                    db.execute("DROP TABLE previous_credentials")
                db.execute("""CREATE TABLE IF NOT EXISTS connector_dispatches(
                    task TEXT NOT NULL REFERENCES tasks(id), intent TEXT NOT NULL, result TEXT, receipt TEXT,
                    PRIMARY KEY(task,intent))""")
                db.execute("PRAGMA user_version=17")

    def migrate_model_runs(self, db: sqlite3.Connection) -> None:
        db.execute("""CREATE TABLE model_runs(task TEXT PRIMARY KEY REFERENCES tasks(id),
                   phase TEXT NOT NULL CHECK(phase IN ('active','legacy','waiting','reply')),
                   turn_id TEXT, instruction TEXT)""")
        db.execute("""CREATE INDEX IF NOT EXISTS events_task_seq ON events(task,seq)""")
        db.execute("""INSERT INTO model_runs(task,phase)
                   SELECT id,'legacy' FROM tasks WHERE checkpoint='running' AND thread_id IS NOT NULL
                   AND EXISTS (SELECT 1 FROM events WHERE task=tasks.id
                               AND json_extract(data,'$.mode')='codex')""")
        # Only reopen a modeled completion whose actual answer is empty or punctuation.
        rows = db.execute("""SELECT t.id,a.text FROM tasks t JOIN events a ON a.task=t.id
            WHERE t.checkpoint='completed' AND t.thread_id IS NOT NULL AND a.kind='answered'
            AND EXISTS (SELECT 1 FROM events WHERE task=t.id AND json_extract(data,'$.mode')='codex')
            AND json_extract(a.data,'$.modeled')=1 AND EXISTS (
                SELECT 1 FROM events c WHERE c.task=t.id AND c.seq>a.seq AND c.kind='completed')
            AND NOT EXISTS (SELECT 1 FROM events e WHERE e.task=t.id AND e.seq>a.seq
                AND e.kind IN ('verified','stopped','unknown','failed','answered'))""").fetchall()
        for row in rows:
            if not any(char.isalnum() for char in row["text"]):
                db.execute("INSERT INTO model_runs(task,phase) VALUES (?,'legacy')", (row["id"],))
                db.execute("UPDATE tasks SET checkpoint='running' WHERE id=?", (row["id"],))
                self.append(
                    db,
                    row["id"],
                    "started",
                    "Checking the saved turn for the missing answer.",
                    {"action": "answer_review"},
                )

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

    def queued_tasks(self) -> int:
        with self.transaction() as db:
            return db.execute("SELECT count(*) FROM tasks WHERE checkpoint='queued'").fetchone()[0]

    def active_skill_revision(self, skill: str) -> str | None:
        with self.transaction() as db:
            row = db.execute(
                "SELECT revision FROM active_skills WHERE skill=?", (skill,)
            ).fetchone()
            return row[0] if row else None

    def claim(self, *, operations_only: bool = False, allow_model_runs: bool = True) -> str | None:
        with self.transaction(write=True) as db:
            row = db.execute(
                """SELECT id,checkpoint FROM tasks WHERE checkpoint!='completed'
                   AND NOT EXISTS(SELECT 1 FROM credential_requests AS c WHERE c.task=tasks.id
                                  AND NOT c.supplied)
                   AND NOT EXISTS(SELECT 1 FROM model_runs r WHERE r.task=tasks.id AND r.phase='waiting')
                   AND (? OR NOT EXISTS(SELECT 1 FROM model_runs WHERE task=tasks.id))
                   AND (NOT ? OR EXISTS(SELECT 1 FROM operations WHERE task=tasks.id))
                   ORDER BY rowid LIMIT 1""",
                (allow_model_runs, operations_only),
            ).fetchone()
            if row is None:
                return None
            task = row["id"]
            if db.execute(
                "SELECT 1 FROM credential_requests WHERE task=? AND supplied AND resume_needed",
                (task,),
            ).fetchone():
                db.execute(
                    """UPDATE model_runs SET phase='reply',turn_id=NULL,instruction=?
                           WHERE task=?""",
                    (
                        "The requested credential was supplied. Continue the pending operation.",
                        task,
                    ),
                )
            db.execute(
                "UPDATE credential_requests SET resume_needed=0 WHERE task=? AND supplied",
                (task,),
            )
            if row["checkpoint"] == "queued":
                db.execute("UPDATE tasks SET checkpoint='running' WHERE id=?", (task,))
                self.append(db, task, "started", "The worker picked up this message.")
            return task

    def reserve_model_turn(self, task: str) -> tuple[str, str | None, str | None]:
        """Commit dispatch intent before starting a tool-capable turn. Only the worker calls this."""
        with self.transaction(write=True) as db:
            run = db.execute(
                "SELECT phase,turn_id,instruction FROM model_runs WHERE task=?", (task,)
            ).fetchone()
            if run and run["phase"] != "reply":
                if run["phase"] == "active" and self.planning_pending(db, task):
                    # Planning has no tools. Restart it after sign-in or a process interruption.
                    return "start", None, run["instruction"]
                if run["phase"] != "waiting":
                    last = db.execute(
                        "SELECT kind,data FROM events WHERE task=? ORDER BY seq DESC LIMIT 1",
                        (task,),
                    ).fetchone()
                    if (
                        json.loads(last["data"]).get("action") != "answer_review"
                        and last["kind"] != "failed"
                    ):
                        self.append(
                            db,
                            task,
                            "started",
                            "Checking the saved turn for a complete answer.",
                            {"action": "answer_review"},
                        )
                return tuple(run)
            db.execute(
                """INSERT INTO model_runs(task,phase) VALUES (?,'active')
                       ON CONFLICT(task) DO UPDATE SET phase='active',turn_id=NULL""",
                (task,),
            )
            return "start", None, run["instruction"] if run else None

    @staticmethod
    def planning_pending(db, task: str) -> bool:
        row = db.execute(
            """SELECT json_extract(data,'$.action') FROM events WHERE task=?
            AND json_extract(data,'$.action') IN ('objective_planning','task_objectives')
            ORDER BY seq DESC LIMIT 1""",
            (task,),
        ).fetchone()
        return bool(row and row[0] == "objective_planning")

    def continue_unverified(self, task: str, reason: str) -> None:
        with self.transaction(write=True) as db:
            if (
                not db.execute(
                    "SELECT 1 FROM tasks WHERE id=? AND checkpoint='running'", (task,)
                ).fetchone()
                or db.execute(
                    "SELECT 1 FROM credential_requests WHERE task=? AND resume_needed", (task,)
                ).fetchone()
            ):
                return
            if self.continue_steers(db, task):
                return
            latest = db.execute(
                """SELECT json_extract(data,'$.action') FROM events WHERE task=?
                AND (kind='owner_message' OR json_extract(data,'$.action')='objective_retry')
                ORDER BY seq DESC LIMIT 1""",
                (task,),
            ).fetchone()
            if not latest or latest[0] != "objective_retry":
                instruction = (
                    reason
                    + ". Continue this task using the catalog and recorded results. Reconcile any dispatched operation before retrying."
                )
                db.execute(
                    "UPDATE model_runs SET phase='reply',turn_id=NULL,instruction=? WHERE task=?",
                    (instruction, task),
                )
                self.append(db, task, "started", reason, {"action": "objective_retry"})
            else:
                db.execute("UPDATE model_runs SET phase='waiting' WHERE task=?", (task,))
                self.append(db, task, "waiting", reason, {"action": "reply_required"})

    def wait_for_reply(self, task: str, question: str) -> None:
        with self.transaction(write=True) as db:
            if self.continue_steers(db, task):
                return
            changed = db.execute(
                """UPDATE model_runs SET phase='waiting' WHERE task=? AND phase!='waiting'
                AND EXISTS (SELECT 1 FROM tasks WHERE id=? AND checkpoint='running')
                AND NOT EXISTS (SELECT 1 FROM credential_requests WHERE task=? AND resume_needed)""",
                (task, task, task),
            ).rowcount
            if changed:
                self.append(db, task, "waiting", question, {"action": "reply_required"})

    def continue_steers(self, db: sqlite3.Connection, task: str) -> bool:
        pending = db.execute(
            """SELECT c.text FROM task_controls c JOIN model_runs r ON r.task=c.task
                            JOIN tasks t ON t.id=c.task WHERE c.task=? AND c.kind='steer'
                            AND NOT c.applied AND t.checkpoint='running' ORDER BY c.rowid""",
            (task,),
        ).fetchall()
        if not pending:
            return False
        instruction = "\n".join(row["text"] for row in pending)
        db.execute(
            "UPDATE model_runs SET phase='reply',turn_id=NULL,instruction=? WHERE task=?",
            (instruction, task),
        )
        db.execute("UPDATE task_controls SET applied=1 WHERE task=? AND kind='steer'", (task,))
        return True

    def finish(self, task: str, answer: str, summary: str, *, modeled: bool = False):
        with self.transaction(write=True) as db:
            if modeled and self.continue_steers(db, task):
                return
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
                proof = (
                    db.execute(
                        """SELECT data FROM events WHERE task=? AND json_extract(data,'$.action')='objectives_verified'
                    AND json_extract(data,'$.owner_seq')=(SELECT MAX(seq) FROM events WHERE task=? AND kind='owner_message')
                    ORDER BY seq DESC LIMIT 1""",
                        (task, task),
                    ).fetchone()
                    if modeled
                    else None
                )
                if proof:
                    data["proof"] = json.loads(proof[0])["proof"]
                    summary = "Verified the requested deliverables against the task evidence."
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
                if db.execute(
                    """UPDATE model_runs SET phase='reply',instruction=(
                              SELECT 'Your question: ' || text || char(10) || 'Owner reply: ' || ?
                              FROM events WHERE task=? AND kind='waiting' ORDER BY seq DESC LIMIT 1),
                              turn_id=NULL WHERE task=? AND phase='waiting'""",
                    (text, task, task),
                ).rowcount:
                    db.execute("UPDATE task_controls SET applied=1 WHERE id=?", (str(request_id),))
                    self.append(
                        db,
                        task,
                        "started",
                        "Continuing with your reply.",
                        {"action": "owner_replied"},
                    )

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

    def remember_thread(
        self, task: str, thread_id: str, mode: str, turn_id: str | None = None
    ) -> None:
        with self.transaction(write=True) as db:
            if not db.execute(
                "SELECT 1 FROM tasks WHERE id=? AND checkpoint='running'", (task,)
            ).fetchone():
                return
            db.execute("UPDATE tasks SET thread_id=? WHERE id=?", (thread_id, task))
            db.execute("UPDATE model_runs SET turn_id=? WHERE task=?", (turn_id, task))
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
            latest: dict[str, Outcome] = {}
            for event in events:
                if event.kind == "system":
                    continue
                outcome = event.outcome
                previous = latest.get(event.task)
                # Evidence can arrive after the task has ended, including after verification.
                if (
                    outcome.key == "working"
                    and event.data.get("action") != "answer_review"
                    and previous
                    and previous.key not in ("working", "needs-you")
                ):
                    continue
                latest[event.task] = outcome
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
