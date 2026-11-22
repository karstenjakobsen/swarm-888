"""Record comparisons from the separate, operator-owned Docker acceptance runner."""

import argparse
import json
import sys
from typing import Annotated

from pydantic import BaseModel, Field

from .config import Settings
from .skill_program import Row, Selector
from .state import State


class Observation(BaseModel):
    selector: Selector
    rows: list[Row]


class Grade(BaseModel):
    observations: Annotated[list[Observation], Field(min_length=1)]


def record(state: State, task: str, grade: Grade) -> dict[str, str]:
    with state.transaction(write=True) as db:
        final = db.execute(
            "SELECT kind FROM events WHERE task=? ORDER BY seq DESC LIMIT 1", (task,)
        ).fetchone()
        if not final or final["kind"] != "completed":
            raise ValueError("Grade a completed, previously ungraded task")
        calls = db.execute(
            "SELECT skill,revision,arguments,result FROM skill_calls WHERE task=?", (task,)
        ).fetchall()
        identities = set()
        for observation in grade.observations:
            matched = [
                call
                for call in calls
                if json.loads(call["arguments"]).get("selector") == observation.selector
            ]
            expected = sorted(observation.rows, key=lambda row: str(row.get("name")))
            for call in matched:
                actual = sorted(json.loads(call["result"]), key=lambda row: str(row.get("name")))
                if actual != expected:
                    raise ValueError(f"Skill result differs from Docker for {observation.selector}")
                identities.add((call["skill"], call["revision"]))
            if not matched:
                raise ValueError(f"No recorded invocation for {observation.selector}")
        if len(identities) != 1:
            raise ValueError("Observations must agree on the executed skill revision")
        skill, revision = identities.pop()
        primary = grade.observations[0].selector
        previous = db.execute(
            """SELECT grade.task FROM docker_grades AS grade
               JOIN skill_revisions AS rev USING(skill,revision)
               WHERE grade.skill=? AND grade.revision=? AND grade.task=rev.author_task
               AND grade.selector<>?""",
            (skill, revision, primary),
        ).fetchone()
        db.execute("INSERT INTO docker_grades VALUES (?,?,?,?)", (task, skill, revision, primary))
        evidence = {
            "command": "Independent Docker engine observations by exact label",
            "output": grade.model_dump_json(indent=2),
        }
        state.append(
            db,
            task,
            "verified",
            "The recorded skill result matched the independent Docker observations.",
            {"action": "docker_grade", **evidence},
        )
        if previous:
            state.append(
                db,
                task,
                "verified",
                "The same revision matched Docker on a later task and new input.",
                {"action": "skill_verified", "skill": skill, "revision": revision, **evidence},
            )
        return {"task": task, "skill": skill, "revision": revision}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("task")
    args = parser.parse_args()
    print(
        json.dumps(
            record(State(Settings.load()), args.task, Grade.model_validate_json(sys.stdin.read()))
        )
    )


if __name__ == "__main__":
    main()
