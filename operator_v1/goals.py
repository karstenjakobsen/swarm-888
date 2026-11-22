import os
import sqlite3
import stat
import time
from collections.abc import Callable, Generator
from contextlib import contextmanager
from pathlib import Path
from typing import Annotated, Literal, Protocol
from uuid import uuid4

from pydantic import Field, StringConstraints

from .config import Settings
from .skill_program import FileMode, FileModeProgram, SkillDefinition, SkillId
from .state import State
from .tool_types import ToolArguments


class GoalError(ValueError):
    """A standing goal could not be configured."""


FixtureName = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$")]
GoalStatus = Literal["active", "paused", "retired"]


class CreateGoal(ToolArguments):
    filename: FixtureName
    mode: FileMode
    skill: SkillId
    interval: int = Field(default=10, ge=2, le=86400)


class ChangeGoal(ToolArguments):
    goal: Annotated[str, StringConstraints(pattern=r"^[a-f0-9]{32}$")]
    status: GoalStatus


class FileAccess(Protocol):
    def observe(self, filename: str) -> int | None: ...
    def repair(self, filename: str, mode: int) -> None: ...


class FixtureFiles:
    def __init__(self, directory: Path):
        self.directory = directory

    @contextmanager
    def open(self, filename: str) -> Generator[int, None, None]:
        # Pin the directory and file with descriptors. A symlink or hard link
        # cannot turn a fixture repair into a write elsewhere on the host.
        if Path(filename).name != filename or filename in ("", ".", ".."):
            raise OSError("Fixture filename must be a single path segment")
        directory = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
            try:
                info = os.fstat(fd)
                if (
                    not stat.S_ISREG(info.st_mode)
                    or info.st_nlink != 1
                    or info.st_uid != os.fstat(directory).st_uid
                ):
                    raise OSError("The target is outside the owned fixture file scope")
                yield fd
            finally:
                os.close(fd)
        finally:
            os.close(directory)

    def observe(self, filename: str) -> int | None:
        try:
            with self.open(filename) as fd:
                return stat.S_IMODE(os.fstat(fd).st_mode)
        except OSError:
            return None

    def repair(self, filename: str, mode: int) -> None:
        with self.open(filename) as fd:
            os.fchmod(fd, mode)


class StandingGoals:
    max_attempts = 3
    max_observations = 8
    incident_seconds = 180

    def __init__(
        self,
        settings: Settings,
        state: State,
        *,
        clock: Callable[[], float] = time.time,
        files: FileAccess | None = None,
    ):
        self.settings = settings
        self.state = state
        self.clock = clock
        self.files = files or FixtureFiles(settings.directory / "defense")

    def goals(self) -> dict:
        with self.state.transaction() as db:
            return {
                "goals": [
                    dict(row)
                    for row in db.execute(
                        "SELECT id,filename,expected,skill,status FROM standing_goals ORDER BY rowid"
                    )
                ]
            }

    def create(self, task: str | None, args: CreateGoal) -> dict:
        if not task:
            raise GoalError("Create standing goals from an authenticated owner task")
        if self.files.observe(args.filename) is None:
            raise GoalError("Create a regular, owned file in the private defense directory first")
        with self.state.transaction(write=True) as db:
            revision = self.active_revision(db, args.skill)
            if not revision:
                raise GoalError("Activate a tested file-mode skill before creating the goal")
            prior = db.execute(
                "SELECT * FROM standing_goals WHERE filename=?", (args.filename,)
            ).fetchone()
            if prior:
                if (prior["task"], prior["expected"], prior["skill"], prior["interval"]) == (
                    task,
                    args.mode,
                    args.skill,
                    args.interval,
                ):
                    return {"goal": prior["id"]}
                raise GoalError("This file already has a standing goal")
            identity = uuid4().hex
            db.execute(
                "INSERT INTO standing_goals VALUES (?,?,?,?,?,'active',?,?)",
                (identity, task, args.filename, args.mode, args.skill, self.clock(), args.interval),
            )
            self.state.append(
                db,
                task,
                "evidence",
                "Created the standing goal.",
                {
                    "action": "goal_created",
                    "goal": identity,
                    "filename": args.filename,
                    "expected": args.mode,
                    "skill": args.skill,
                    "revision": revision,
                },
            )
            return {"goal": identity}

    def change(self, task: str | None, goal: str, status: GoalStatus) -> dict:
        if not task:
            raise GoalError("Change standing goals from an authenticated owner task")
        with self.state.transaction(write=True) as db:
            current = db.execute("SELECT status FROM standing_goals WHERE id=?", (goal,)).fetchone()
            if not current or current["status"] == "retired":
                raise GoalError("Standing goal is missing or retired")
            if current["status"] != status:
                db.execute(
                    "UPDATE standing_goals SET status=?,next_due=? WHERE id=?",
                    (status, self.clock(), goal),
                )
                self.state.append(
                    db,
                    task,
                    "evidence",
                    f"Standing goal is now {status}.",
                    {"action": "goal_status", "goal": goal, "status": status},
                )
        return {"goal": goal, "status": status}

    @staticmethod
    def active_revision(db: sqlite3.Connection, skill: str) -> str | None:
        row = db.execute(
            """SELECT revision FROM active_skills JOIN skill_revisions USING(skill,revision)
               WHERE skill=? AND source='file.mode'""",
            (skill,),
        ).fetchone()
        return row["revision"] if row else None

    def run_due(self) -> None:
        with self.state.transaction() as db:
            due = db.execute(
                "SELECT * FROM standing_goals WHERE status='active' AND next_due<=? ORDER BY next_due",
                (self.clock(),),
            ).fetchall()
        for goal in due:
            self.check(goal)

    def event(self, db, goal: sqlite3.Row, action: str, summary: str, **fields) -> None:
        self.state.append(
            db, goal["task"], "system", summary, {"action": action, "goal": goal["id"], **fields}
        )

    def check(self, goal: sqlite3.Row) -> None:
        now = self.clock()
        filename = goal["filename"]
        expected = int(goal["expected"], 8)
        with self.state.transaction(write=True) as db:
            affected = db.execute(
                "UPDATE standing_goals SET next_due=? WHERE id=? AND status='active' AND next_due<=?",
                (now + goal["interval"], goal["id"], now),
            ).rowcount
            if not affected:
                return
            incident = db.execute(
                "SELECT * FROM incidents WHERE goal=? AND status!='resolved' ORDER BY opened DESC LIMIT 1",
                (goal["id"],),
            ).fetchone()
            if incident and incident["notified"]:
                return
            revision = self.active_revision(db, goal["skill"])
            if incident and (
                now >= incident["deadline"]
                or incident["observations"] >= incident["observation_limit"]
            ):
                self.notify(db, goal, incident["id"])
                return
        observed = self.files.observe(filename)
        with self.state.transaction(write=True) as db:
            actual = "unreadable" if observed is None else f"{observed:03o}"
            status = (
                "holding" if observed == expected else "blocked" if observed is None else "drift"
            )
            self.event(
                db,
                goal,
                "goal_checked",
                f"{filename} mode is {actual}.",
                status=status,
                filename=filename,
                actual=actual,
            )
            if not incident and status == "holding":
                return
            if incident:
                identity = incident["id"]
                db.execute(
                    "UPDATE incidents SET observations=observations+1 WHERE id=?", (identity,)
                )
            else:
                identity = uuid4().hex
                db.execute(
                    """INSERT INTO incidents(
                           id,goal,opened,deadline,status,observations,attempt_limit,observation_limit)
                       VALUES (?,?,?,?,'open',1,?,?)""",
                    (
                        identity,
                        goal["id"],
                        now,
                        now + self.incident_seconds,
                        self.max_attempts,
                        self.max_observations,
                    ),
                )
                self.event(
                    db,
                    goal,
                    "incident_opened",
                    f"{filename} needs attention.",
                    incident=identity,
                    filename=filename,
                )
            if observed == expected:
                self.recovered(db, goal, identity, actual)
                return
            if observed is None:
                return
            if not revision or (incident and incident["attempts"] >= incident["attempt_limit"]):
                self.notify(db, goal, identity)
                return
            active = db.execute(
                "SELECT status FROM standing_goals WHERE id=?", (goal["id"],)
            ).fetchone()
            if active["status"] != "active":
                return
            db.execute(
                "UPDATE incidents SET attempts=attempts+1,revision=? WHERE id=?",
                (revision, identity),
            )
            self.event(
                db,
                goal,
                "incident_repair",
                f"Repairing {filename} using the pinned revision.",
                incident=identity,
                skill=goal["skill"],
                revision=revision,
            )
        try:
            path = self.settings.directory / "revisions" / revision / goal["skill"] / "skill.json"
            program = SkillDefinition.model_validate_json(path.read_text()).program
            if isinstance(program, FileModeProgram):
                self.files.repair(filename, program.mode(goal["expected"]))
        except (OSError, ValueError):
            pass
        verified = self.files.observe(filename)
        with self.state.transaction(write=True) as db:
            db.execute("UPDATE incidents SET observations=observations+1 WHERE id=?", (identity,))
            if verified == expected:
                self.recovered(db, goal, identity, f"{verified:03o}")
            else:
                actual = "unreadable" if verified is None else f"{verified:03o}"
                self.event(
                    db,
                    goal,
                    "incident_observation",
                    f"Observed mode after repair: {actual}.",
                    incident=identity,
                )

    def recovered(
        self, db: sqlite3.Connection, goal: sqlite3.Row, identity: str, mode: str
    ) -> None:
        db.execute("UPDATE incidents SET status='resolved' WHERE id=?", (identity,))
        self.event(
            db,
            goal,
            "incident_recovered",
            f"Independent file inspection confirmed mode {mode}.",
            incident=identity,
            actual=mode,
        )

    def notify(self, db: sqlite3.Connection, goal: sqlite3.Row, identity: str) -> None:
        if db.execute(
            "UPDATE incidents SET notified=1,status='unknown' WHERE id=? AND NOT notified",
            (identity,),
        ).rowcount:
            self.event(
                db,
                goal,
                "incident_unknown",
                "Repair outcome unknown. Owner attention is required.",
                incident=identity,
            )
