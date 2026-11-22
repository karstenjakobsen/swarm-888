import sqlite3
from datetime import UTC, datetime
from typing import Annotated, Literal
from uuid import uuid4

from pydantic import Field, StringConstraints

from .state import State
from .tool_types import ToolArguments

MemoryId = Annotated[str, StringConstraints(pattern=r"^[a-f0-9]{32}$")]
MemoryText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=8000)]


class MemoryError(ValueError):
    """A memory entry could not be read or changed."""


class SearchMemory(ToolArguments):
    query: str = Field(default="", max_length=200)
    scope: str | None = Field(default=None, max_length=120)


class ReadMemory(ToolArguments):
    memory: MemoryId
    reason: str = Field(min_length=1, max_length=300)


class WriteMemory(ToolArguments):
    title: str = Field(min_length=1, max_length=160)
    scope: str = Field(default="host", min_length=1, max_length=120)
    kind: Literal["fact", "preference", "procedure"]
    text: MemoryText


class RemoveMemory(ToolArguments):
    memory: MemoryId
    expected_revision: int = Field(ge=1)


class ReviseMemory(RemoveMemory):
    text: MemoryText


CURRENT = """SELECT m.*,v.revision,v.text,v.removed,v.writer,v.at FROM memories AS m
    JOIN memory_versions AS v ON m.id=v.memory
    AND v.revision=(SELECT MAX(revision) FROM memory_versions WHERE memory=m.id)"""


class MemoryStore:
    def __init__(self, state: State, task: str | None):
        self.state = state
        self.task = task

    def writer(self) -> str:
        if not self.task:
            raise MemoryError("This action requires a task")
        return self.task

    @staticmethod
    def current(db: sqlite3.Connection, memory: str) -> sqlite3.Row:
        row = db.execute(CURRENT + " WHERE m.id=? AND NOT v.removed", (memory,)).fetchone()
        if not row:
            raise MemoryError("Memory entry is missing or removed")
        return row

    def search(self, args: SearchMemory) -> dict:
        with self.state.transaction() as db:
            return {
                "matches": [
                    {
                        "memory": row["id"],
                        "title": row["title"],
                        "scope": row["scope"],
                        "kind": row["kind"],
                        "revision": row["revision"],
                    }
                    for row in db.execute(
                        CURRENT
                        + """
                    WHERE NOT v.removed AND (? IS NULL OR m.scope=?)
                    AND instr(lower(m.title || ' ' || v.text), lower(?))>0
                    ORDER BY v.at DESC LIMIT 50""",
                        (args.scope, args.scope, args.query),
                    )
                ]
            }

    def read(self, args: ReadMemory) -> dict:
        task = self.writer()
        with self.state.transaction(write=True) as db:
            row = self.current(db, args.memory)
            db.execute(
                "INSERT INTO memory_reads(memory,revision,task,reason) VALUES (?,?,?,?)",
                (args.memory, row["revision"], task, args.reason),
            )
            self.state.append(
                db,
                task,
                "evidence",
                f"Read memory: {row['title']}",
                {
                    "action": "memory_read",
                    "memory": args.memory,
                    "revision": row["revision"],
                    "why": args.reason,
                },
            )
            return dict(row)

    def write(self, args: WriteMemory) -> dict:
        task = self.writer()
        with self.state.transaction(write=True) as db:
            matching = db.execute(
                CURRENT
                + """
                WHERE title=? AND kind=? AND scope=? AND text=? AND writer=? AND NOT removed
                LIMIT 1""",
                (args.title, args.kind, args.scope, args.text, task),
            ).fetchone()
            if matching:
                return {"memory": matching["id"], "revision": matching["revision"]}
            memory = uuid4().hex
            db.execute(
                "INSERT INTO memories VALUES (?,?,?,?)", (memory, args.title, args.kind, args.scope)
            )
            return self.persist(db, task, memory, 1, args.text)

    def revise(self, args: ReviseMemory) -> dict:
        task = self.writer()
        with self.state.transaction(write=True) as db:
            row = self.current(db, args.memory)
            if row["revision"] != args.expected_revision:
                raise MemoryError("Memory changed. Read its current revision before editing.")
            if row["text"] == args.text:
                return {"memory": args.memory, "revision": row["revision"]}
            return self.persist(db, task, args.memory, row["revision"] + 1, args.text)

    def remove(self, args: RemoveMemory) -> dict:
        task = self.writer()
        with self.state.transaction(write=True) as db:
            row = self.current(db, args.memory)
            if row["revision"] != args.expected_revision:
                raise MemoryError("Memory changed. Read its current revision before removing.")
            return self.persist(db, task, args.memory, row["revision"] + 1, "", removed=True)

    def persist(
        self,
        db: sqlite3.Connection,
        task: str,
        memory: str,
        revision: int,
        text: str,
        *,
        removed: bool = False,
    ) -> dict:
        db.execute(
            "INSERT INTO memory_versions VALUES (?,?,?,?,?,?)",
            (memory, revision, text, removed, task, datetime.now(UTC).isoformat()),
        )
        entry = db.execute("SELECT title,kind,scope FROM memories WHERE id=?", (memory,)).fetchone()
        action = "memory_removed" if removed else "memory_written"
        self.state.append(
            db,
            task,
            "evidence",
            f"{'Removed' if removed else 'Saved'} memory: {entry['title']}",
            {"action": action, "memory": memory, "text": text, "revision": revision, **dict(entry)},
        )
        return {"memory": memory, "revision": revision}
