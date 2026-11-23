import asyncio
import json

from .model import ModelError, codex_session
from .state import State

CONTEXT_FIELDS = frozenset(
    {"action", "connector", "skill", "tool", "zone", "scope", "destination", "count", "revision"}
)


class MemoryReview:
    def __init__(self, state: State):
        self.state = state

    def pending(self) -> str | None:
        with self.state.transaction() as db:
            row = db.execute(
                """SELECT verified.task
                   FROM dns_requests AS request JOIN events AS verified ON verified.task=request.task
                   WHERE verified.kind='verified'
                     AND NOT EXISTS (
                        SELECT 1 FROM events AS review WHERE review.task=verified.task
                        AND review.kind='system' AND json_extract(review.data,'$.action')='memory_reviewed')
                   ORDER BY verified.seq LIMIT 1"""
            ).fetchone()
            return row["task"] if row else None

    def evidence(self, task: str) -> str:
        with self.state.transaction() as db:
            rows = db.execute(
                """SELECT at,kind,text,data FROM events WHERE task=?
                   AND kind IN ('evidence','waiting','verified')
                   AND COALESCE(json_extract(data,'$.action'),'') NOT LIKE 'memory_%'
                   ORDER BY seq DESC LIMIT 30""",
                (task,),
            ).fetchall()
        events = []
        for row in reversed(rows):
            data = json.loads(row["data"])
            metadata = {
                key: value
                for key, value in data.items()
                if key in CONTEXT_FIELDS and isinstance(value, (str, int))
            }
            events.append(
                {"at": row["at"], "kind": row["kind"], "text": row["text"], "metadata": metadata}
            )
        return json.dumps(events, ensure_ascii=False)

    async def run(self, task: str) -> None:
        _, cursor = self.state.stream_head()
        evidence = self.evidence(task)
        async with (
            asyncio.timeout(60),
            codex_session(
                self.state.settings, task, self.state.profile(), memory_review=True
            ) as session,
        ):
            turn = await session.start(
                "Review this completed task for future reference.\n" + evidence
            )
            await session.result(turn)
        with self.state.transaction(write=True) as db:
            searched = db.execute(
                """SELECT 1 FROM events WHERE task=? AND seq>? AND kind='system'
                   AND json_extract(data,'$.action')='memory_review_search'""",
                (task, cursor),
            ).fetchone()
            if not searched:
                raise ModelError("Memory review did not reach the memory tools")
            self.state.append(
                db,
                task,
                "system",
                "The operator reviewed the verified work for reusable memory.",
                {"action": "memory_reviewed"},
            )
