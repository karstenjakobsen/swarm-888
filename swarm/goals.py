from __future__ import annotations

import json
import os
import subprocess

from .catalog import Catalog
from .root_worker import MODES, FixtureWorker
from .state import State, encode, identity, name


class Maintenance:
    """A serialized scheduler. Skills classify observations and propose a file mode."""

    diagnostic_tools = frozenset(
        {
            "skill_read",
            "skill_search",
            "skill_template",
            "skill_run",
            "memory_read",
            "memory_search",
        }
    )
    improvement_tools = diagnostic_tools | {"skill_stage", "skill_test", "skill_activate"}

    def __init__(
        self, state: State, catalog: Catalog, limit: int = 10, seconds: int = 180, cooldown: int = 5
    ):
        self.s, self.catalog, self.limit, self.seconds, self.cooldown = (
            state,
            catalog,
            limit,
            seconds,
            cooldown,
        )

        fd = os.getenv("SWARM_FIXTURE_FD")
        self.host = FixtureWorker(state.path / "fixtures", int(fd) if fd is not None else None)

    def add(self, task: str, resource: str, mode: str, skill: str, interval: int) -> str:
        name(resource)
        if mode not in MODES or not 1 <= interval <= 86400:
            raise ValueError("Supply a regular-file mode and interval of 1 to 86400 seconds")
        rev = self.catalog.active(skill)
        key = identity()
        self.s.change(
            "INSERT INTO goals VALUES (?,?,?,?,?,?,?,'active',?)",
            key,
            task,
            resource,
            mode,
            skill,
            rev,
            interval,
            self.s.clock(),
        )
        self.s.event(
            task,
            "goal.created",
            {
                "goal": key,
                "authorized": "observe and restore mode",
                "resource": resource,
                "revision": rev,
            },
        )
        return key

    def control(self, goal: str, action: str) -> None:
        g = self.s.one("SELECT * FROM goals WHERE id=?", goal)
        status = {"pause": "paused", "resume": "active", "retire": "retired"}[action]
        if g["status"] == "retired":
            raise ValueError("Goal is retired")
        self.s.change("UPDATE goals SET status=? WHERE id=?", status, goal)
        self.s.event(g["authority"], "goal." + status, {"goal": goal})

    def consume(self, inc: str, action: str) -> bool:
        with self.s.tx() as conn:
            row = conn.execute(
                "SELECT i.*,g.authority,g.resource FROM incidents i JOIN goals g ON i.goal=g.id WHERE i.id=?",
                (inc,),
            ).fetchone()
            if not row or row["status"] != "open":
                return False
            if row["attempts"] < self.limit and self.s.clock() < row["deadline"]:
                conn.execute("UPDATE incidents SET attempts=attempts+1 WHERE id=?", (inc,))
                self.s.event(
                    row["authority"],
                    "incident." + action,
                    {"incident": inc, "attempt": row["attempts"] + 1},
                    conn,
                )
                return True
            conn.execute("UPDATE incidents SET status='unresolved' WHERE id=?", (inc,))
        self.s.alert(
            inc,
            "Owner action needed for " + row["resource"] + ". Last observation: " + row["evidence"],
        )
        return False

    def authorize_tool(self, inc: str, kind: str, tool: str, arguments: dict) -> None:
        if not self.consume(inc, "tool"):
            raise ValueError("Incident budget exhausted")
        allowed = self.improvement_tools if kind == "improve" else self.diagnostic_tools
        if tool not in allowed:
            raise ValueError("Tool outside incident follow-up scope")
        if tool not in {"skill_stage", "skill_activate", "skill_test"}:
            return
        bound = self.s.one(
            "SELECT g.skill FROM goals g JOIN incidents i ON i.goal=g.id WHERE i.id=?", inc
        )["skill"]
        if tool == "skill_stage":
            if arguments["package"]["name"] != bound:
                raise ValueError("Revise the incident's bound skill")
        elif self.catalog.revision(arguments["revision"])["name"] != bound:
            raise ValueError("Revision is outside the incident")

    def followup(self, inc: str, revision: str | None = None) -> dict:
        row = self.s.one(
            "SELECT i.*,g.skill,g.status AS goal_status FROM incidents i JOIN goals g ON g.id=i.goal WHERE i.id=?",
            inc,
        )
        if row["goal_status"] != "active" or not self.consume(
            inc, "revision" if revision else "diagnosis"
        ):
            raise ValueError("Incident budget closed or goal paused")
        if revision:
            candidate = self.catalog.revision(revision)
            if candidate["name"] != row["skill"] or self.catalog.active(row["skill"]) != revision:
                raise ValueError("Select an activated revision of the bound skill")
            self.s.change("UPDATE incidents SET rev=? WHERE id=?", revision, inc)
        return self.s.one("SELECT * FROM incidents WHERE id=?", inc)

    def observe(self, g: dict, rev: str) -> dict:
        try:
            mode = self.host.apply(g["resource"])
            result = self.catalog.evaluate(rev, {"observed": mode, "expected": g["mode"]})
            status = result.get("status")
            if (
                status == "healthy"
                and mode != g["mode"]
                or status == "drifted"
                and mode == g["mode"]
            ):
                status = "unknown"
            if status not in ("healthy", "drifted", "unknown"):
                status = "unknown"
            return {
                "status": status,
                "observed": mode,
                "proposal": result.get("mode"),
                "at": self.s.clock(),
            }
        except (OSError, ValueError, subprocess.SubprocessError):
            return {
                "status": "unknown",
                "reason": "Fixture or skill observation unavailable",
                "at": self.s.clock(),
            }

    def tick(self) -> bool:
        due = self.s.rows(
            "SELECT * FROM goals WHERE status='active' AND due<=? ORDER BY due,id LIMIT 1",
            self.s.clock(),
        )
        if not due:
            return False
        g = due[0]
        rows = self.s.rows(
            "SELECT * FROM incidents WHERE goal=? AND status IN ('open','unresolved')", g["id"]
        )
        self.s.change("UPDATE goals SET due=? WHERE id=?", self.s.clock() + g["interval"], g["id"])
        if rows and (rows[0]["status"] == "unresolved" or rows[0]["next"] > self.s.clock()):
            if rows[0]["status"] == "unresolved":
                self.s.alert(rows[0]["id"], "Owner action needed for " + g["resource"])
            return False
        rev = rows[0]["rev"] if rows else g["rev"]
        if rows and not self.consume(rows[0]["id"], "observe"):
            return False
        obs = self.observe(g, rev)
        self.s.event(
            g["authority"], "goal.check", {"goal": g["id"], "resource": g["resource"], **obs}
        )
        if not rows and obs["status"] == "healthy":
            return True
        inc = rows[0]["id"] if rows else identity()
        if not rows:
            self.s.change(
                "INSERT INTO incidents VALUES (?,?,'open',1,?,?,?,?)",
                inc,
                g["id"],
                self.s.clock() + self.seconds,
                encode(obs),
                self.s.clock(),
                rev,
            )
        self.record(g, inc, obs)
        if obs["status"] != "drifted" or not self.consume(inc, "recheck"):
            return True
        obs = self.observe(g, rev)
        self.record(g, inc, obs)
        if (
            obs["status"] != "drifted"
            or obs.get("proposal") != g["mode"]
            or not self.consume(inc, "repair")
        ):
            return True
        # An interrupted dispatch is reconciled against the file before reuse.
        previous = self.s.rows(
            "SELECT * FROM operations WHERE task=? AND status='dispatched' ORDER BY rowid DESC LIMIT 1",
            inc,
        )
        op = previous[0]["id"] if previous else identity()
        self.s.change(
            "INSERT OR IGNORE INTO operations(id,task,authority,target,intent,rev,status,evidence) VALUES (?,?,?,?,?,?,'dispatched',?)",
            op,
            inc,
            g["authority"],
            g["resource"],
            encode({"mode": g["mode"]}),
            rev,
            encode(obs),
        )
        try:
            self.host.apply(g["resource"], obs["observed"], g["mode"])
        except (ValueError, OSError):
            self.s.event(g["authority"], "repair.unknown", {"incident": inc, "operation": op})
        if self.consume(inc, "verify"):
            self.record(g, inc, self.observe(g, rev))
        return True

    def record(self, g: dict, inc: str, obs: dict) -> None:
        status = "resolved" if obs["status"] == "healthy" else "open"
        with self.s.tx() as conn:
            conn.execute(
                "UPDATE incidents SET evidence=?,next=?,status=? WHERE id=?",
                (encode(obs), self.s.clock() + self.cooldown, status, inc),
            )
            if status == "resolved":
                conn.execute(
                    "UPDATE operations SET status='verified',evidence=? WHERE task=? AND status='dispatched'",
                    (encode(obs), inc),
                )
            self.s.event(
                g["authority"],
                "incident.observation",
                {"incident": inc, "resource": g["resource"], "status": status, "evidence": obs},
                conn,
            )

    def summaries(self) -> list[dict]:
        result = self.s.rows("""SELECT i.*, g.resource, g.authority, g.mode, g.interval,
        (SELECT count(*) FROM operations o WHERE o.task=i.id) AS repairs
        FROM incidents i JOIN goals g ON i.goal=g.id ORDER BY i.rowid DESC LIMIT 50""")
        for row in result:
            row["evidence"] = json.loads(row["evidence"])
        return result
