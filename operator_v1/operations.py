import json
import time
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Literal, Protocol
from uuid import UUID

from .contracts import Kind
from .skill_program import SkillError, docker
from .state import RequestConflict, State

FIXTURE_LABEL = "swarm.operator.acceptance"
Observation = Literal["running", "stopped", "unsupported", "unreadable"]


class OperationUnavailable(ValueError):
    """The requested operation has no active inspection revision."""


class FixtureEngine(Protocol):
    def observe(self, target: str) -> Observation: ...
    def start(self, target: str) -> None: ...


class DockerFixtureEngine:
    def observe(self, target: str) -> Observation:
        try:
            output = docker(
                "container",
                "inspect",
                "--format",
                "{{json .Id}} {{json .Config.Labels}} {{json .State.Status}}",
                target,
            )
            decoder = json.JSONDecoder()
            identity, end = decoder.raw_decode(output)
            output = output[end:].lstrip()
            labels, end = decoder.raw_decode(output)
            status = json.loads(output[end:])
        except (SkillError, ValueError):
            return "unreadable"
        if identity != target or not (labels or {}).get(FIXTURE_LABEL):
            return "unsupported"
        if status == "running":
            return "running"
        return "stopped" if status in ("created", "exited") else "unsupported"

    def start(self, target: str) -> None:
        docker("container", "start", target)


class Operations:
    """Journal authorized local fixture writes before dispatch or observation."""

    max_observations = 4

    def __init__(self, state: State):
        self.state = state

    def authorize(self, request_id: UUID, target: str, skill: str) -> str:
        operation = str(request_id)
        with self.state.transaction(write=True) as db:
            existing = db.execute("SELECT * FROM operations WHERE id=?", (operation,)).fetchone()
            if existing:
                if existing["skill"] != skill or existing["target"] != target:
                    raise RequestConflict("Request ID already used for a different operation")
                return existing["task"]
            if db.execute("SELECT 1 FROM tasks WHERE request_id=?", (operation,)).fetchone():
                raise RequestConflict("Request ID already used for an owner message")
            active = db.execute(
                """SELECT revision FROM active_skills JOIN skill_revisions USING(skill,revision)
                   WHERE skill=? AND source='docker.inspect_labeled'""",
                (skill,),
            ).fetchone()
            if not active:
                raise OperationUnavailable("Select an active executable inspection skill")
            task = self.state.enqueue(db, request_id, f"Start Docker fixture {target}")
            db.execute(
                """INSERT INTO operations(id,task,intent,target,skill,revision,authorized_at,checkpoint)
                   VALUES (?,?,?,?,?,?,?,'pending')""",
                (
                    operation,
                    task,
                    "docker.start_fixture",
                    target,
                    skill,
                    active["revision"],
                    datetime.now(UTC).isoformat(),
                ),
            )
            self.state.append(
                db,
                task,
                "evidence",
                "The owner authorized one start of this Docker fixture.",
                {
                    "action": "operation_authorized",
                    "operation": operation,
                    "target": target,
                    "skill": skill,
                    "revision": active["revision"],
                },
            )
            return task

    def finish(self, task: str, kind: Kind, summary: str, observed: Observation) -> None:
        with self.state.transaction(write=True) as db:
            db.execute("UPDATE operations SET checkpoint=? WHERE task=?", (kind, task))
            db.execute("UPDATE tasks SET checkpoint='completed' WHERE id=?", (task,))
            self.state.append(
                db, task, kind, summary, {"action": "operation_result", "observation": observed}
            )

    def run(
        self,
        task: str,
        engine: FixtureEngine,
        *,
        pause: Callable[[float], None] = time.sleep,
    ) -> bool:
        with self.state.transaction() as db:
            row = db.execute("SELECT * FROM operations WHERE task=?", (task,)).fetchone()
        if not row:
            return False
        dispatching = row["checkpoint"] == "dispatching"
        target = row["target"]
        observed: Observation = "unreadable"
        for _ in range(row["observations"], self.max_observations):
            with self.state.transaction(write=True) as db:
                db.execute(
                    "UPDATE operations SET observations=observations+1 WHERE task=?", (task,)
                )
            observed = engine.observe(target)
            if observed == "running":
                self.finish(
                    task,
                    "verified",
                    "Docker's independent inspection confirms the fixture is running.",
                    observed,
                )
                return True
            if observed == "unsupported":
                self.finish(
                    task,
                    "failed",
                    "The target is outside the supported stopped Docker fixtures.",
                    observed,
                )
                return True
            if observed == "stopped" and not dispatching:
                with self.state.transaction(write=True) as db:
                    db.execute(
                        "UPDATE operations SET checkpoint='dispatching',dispatches=1 WHERE task=?",
                        (task,),
                    )
                    self.state.append(
                        db,
                        task,
                        "evidence",
                        "Dispatching the authorized start once.",
                        {"action": "operation_dispatched", "operation": row["id"]},
                    )
                dispatching = True
                try:
                    engine.start(target)
                except SkillError:
                    pass  # The engine may have accepted the write before losing its reply.
            pause(0.2)
        self.finish(
            task,
            "unknown",
            "Docker did not confirm a running fixture within the observation budget.",
            observed,
        )
        return True
