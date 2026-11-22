"""SQLite is the source of truth. A project owns one workspace and Codex thread."""

import hashlib
import secrets
import sqlite3
import time
import uuid
from contextlib import contextmanager
from pathlib import Path


def uid():
    return uuid.uuid4().hex


def now():
    return int(time.time() * 1000)


class BlockedTask(RuntimeError):
    """A worker needs an external dependency before it can finish."""


class Conflict(ValueError):
    pass


SCHEMA = """
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS projects (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, repo TEXT NOT NULL DEFAULT '',
 revision TEXT NOT NULL DEFAULT '', thread TEXT NOT NULL DEFAULT '',
 auto_publish INTEGER NOT NULL DEFAULT 0, repo_ref TEXT NOT NULL DEFAULT 'HEAD');
CREATE TABLE IF NOT EXISTS peers (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, token TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS invites (
 digest TEXT PRIMARY KEY, project TEXT NOT NULL REFERENCES projects(id));
CREATE TABLE IF NOT EXISTS jobs (
 id TEXT PRIMARY KEY, project TEXT NOT NULL REFERENCES projects(id), kind TEXT NOT NULL,
 prompt TEXT NOT NULL, target TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT 'queued',
 worker TEXT NOT NULL DEFAULT '', result TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0, request_key TEXT, turn TEXT NOT NULL DEFAULT '',
 UNIQUE(project,request_key));
CREATE INDEX IF NOT EXISTS queue ON jobs(state,created);
CREATE UNIQUE INDEX IF NOT EXISTS one_writer ON jobs(project) WHERE state='running';
CREATE TABLE IF NOT EXISTS events (
 id INTEGER PRIMARY KEY, job TEXT NOT NULL REFERENCES jobs(id), message TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS job_events ON events(job,id);
INSERT OR IGNORE INTO projects(id,name) VALUES('inbox','Operator workspace');
"""


class Store:
    def __init__(self, directory):
        self.root = Path(directory).expanduser().resolve()
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.path = self.root / "operator.sqlite3"
        with self.connection() as db:
            db.executescript(SCHEMA)
            if "repo_ref" not in {row["name"] for row in db.execute("PRAGMA table_info(projects)")}:
                db.execute("ALTER TABLE projects ADD COLUMN repo_ref TEXT NOT NULL DEFAULT 'HEAD'")

    @contextmanager
    def connection(self, write=False):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            db.execute("PRAGMA foreign_keys=ON")
            if write:
                db.execute("BEGIN IMMEDIATE")
            yield db
            db.commit()
        finally:
            db.close()

    def query(self, sql, args=()):
        with self.connection() as db:
            return [dict(row) for row in db.execute(sql, args)]

    def one(self, sql, args=()):
        rows = self.query(sql, args)
        if not rows:
            raise KeyError("Record not found")
        return rows[0]

    def project(self, ident):
        return self.one("SELECT * FROM projects WHERE id=?", (ident,))

    def workspace(self, project):
        # Only database-generated project IDs may become path components.
        self.project(project)
        path = self.root / "workspaces" / project
        path.mkdir(parents=True, exist_ok=True)
        return path

    def create_project(self, name, repo="", auto_publish=False, repo_ref="HEAD"):
        ident = uid()
        with self.connection(True) as db:
            db.execute(
                "INSERT INTO projects(id,name,repo,auto_publish,repo_ref) VALUES(?,?,?,?,?)",
                (ident, name, repo, int(auto_publish), repo_ref),
            )
            if repo:
                self.insert_job(db, ident, "import", "Import repository")
        return self.project(ident)

    @staticmethod
    def insert_job(db, project, kind, prompt, target="", key=None):
        ident = uid()
        db.execute(
            """INSERT INTO jobs(id,project,kind,prompt,target,created,request_key)
                      VALUES(?,?,?,?,?,?,?)""",
            (ident, project, kind, prompt, target, now(), key),
        )
        return ident

    def enqueue(self, project, prompt, kind="task", target="", key=None):
        self.project(project)
        with self.connection(True) as db:
            if key:
                old = db.execute(
                    "SELECT * FROM jobs WHERE project=? AND request_key=?", (project, key)
                ).fetchone()
                if old:
                    if (old["prompt"], old["kind"], old["target"]) != (prompt, kind, target):
                        raise Conflict("Request ID already used for different work")
                    return dict(old)
            if target and not db.execute("SELECT 1 FROM peers WHERE id=?", (target,)).fetchone():
                raise KeyError("Unknown peer")
            ident = self.insert_job(db, project, kind, prompt, target, key)
        return self.job(ident)

    def job(self, ident):
        return self.one("SELECT * FROM jobs WHERE id=?", (ident,))

    def claim(self, worker):
        with self.connection(True) as db:
            row = db.execute("""SELECT id FROM jobs q WHERE state='queued' AND NOT EXISTS (
                SELECT 1 FROM jobs r WHERE r.project=q.project AND r.state='running')
                ORDER BY created,rowid LIMIT 1""").fetchone()
            if row:
                db.execute(
                    "UPDATE jobs SET state='running',worker=?,attempts=attempts+1 WHERE id=?",
                    (worker, row["id"]),
                )
                return dict(db.execute("SELECT * FROM jobs WHERE id=?", (row["id"],)).fetchone())

    def finish(self, job, state, result):
        with self.connection(True) as db:
            changed = db.execute(
                "UPDATE jobs SET state=?,result=? WHERE id=? AND state='running'",
                (state, result, job["id"]),
            ).rowcount
            if not changed:
                return
            db.execute(
                "INSERT INTO events(job,message,at) VALUES(?,?,?)",
                (job["id"], "Run " + state, now()),
            )
            if state == "completed" and job["kind"] == "task" and not job["target"]:
                p = db.execute("SELECT * FROM projects WHERE id=?", (job["project"],)).fetchone()
                if p["repo"] and p["auto_publish"]:
                    self.insert_job(
                        db,
                        p["id"],
                        "publish",
                        "Publish catalog changes",
                        key="publish:" + job["id"],
                    )

    def event(self, job, message):
        with self.connection(True) as db:
            db.execute(
                "INSERT INTO events(job,message,at) VALUES(?,?,?)", (job, message[:500], now())
            )

    def update(self, sql, args):
        with self.connection(True) as db:
            db.execute(sql, args)

    def recover(self):
        # The server holds an exclusive OS lock throughout its lifetime.
        with self.connection(True) as db:
            db.execute(
                """INSERT INTO events(job,message,at)
                SELECT id,'Operator restarted during this run',? FROM jobs WHERE state='running'""",
                (now(),),
            )
            db.execute("""UPDATE jobs SET worker='', state=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,
                result=CASE WHEN attempts>=3 THEN 'Interrupted three times. Inspect the run before retrying.' ELSE '' END
                WHERE state='running'""")

    def invite(self, name):
        token = secrets.token_urlsafe(32)
        project = self.create_project(name)
        self.update(
            "INSERT INTO invites(digest,project) VALUES(?,?)", (digest(token), project["id"])
        )
        return token

    def peer_project(self, token):
        return self.one("SELECT project FROM invites WHERE digest=?", (digest(token),))["project"]


def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()
