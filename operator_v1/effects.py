import hashlib
import json
import sqlite3

from .skill_program import SkillError
from .state import State


class Dispatch:
    """Deduplicate a concrete live write within its owner task, including across restart."""

    def __init__(self, state: State, task: str, intent: list):
        self.state, self.task = state, task
        self.key = hashlib.sha256(json.dumps(intent, sort_keys=True).encode()).hexdigest()

    def saved(self):
        with self.state.transaction() as db:
            row = db.execute(
                "SELECT result,receipt FROM connector_dispatches WHERE task=? AND intent=?",
                (self.task, self.key),
            ).fetchone()
        if row is None:
            return None
        if row["result"] is not None:
            return {"result": json.loads(row["result"])}
        if row["receipt"] is not None:
            return {"receipt": json.loads(row["receipt"])}
        raise SkillError(
            "The write was dispatched and its outcome is unknown. Inspect the target before another write."
        )

    def reserve(self):
        with self.state.transaction(write=True) as db:
            try:
                db.execute(
                    "INSERT INTO connector_dispatches(task,intent) VALUES (?,?)",
                    (self.task, self.key),
                )
            except sqlite3.IntegrityError:
                raise SkillError("The same write has already been dispatched") from None

    def rejected(self):
        with self.state.transaction(write=True) as db:
            db.execute(
                "DELETE FROM connector_dispatches WHERE task=? AND intent=? AND receipt IS NULL AND result IS NULL",
                (self.task, self.key),
            )

    def receipt(self, value):
        with self.state.transaction(write=True) as db:
            db.execute(
                "UPDATE connector_dispatches SET receipt=? WHERE task=? AND intent=?",
                (json.dumps(value), self.task, self.key),
            )

    def finish(self, db, value):
        db.execute(
            "UPDATE connector_dispatches SET result=? WHERE task=? AND intent=?",
            (json.dumps(value), self.task, self.key),
        )
