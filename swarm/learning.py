"""Bounded revisions requested by the owner after an independent check fails."""

import json
import subprocess

from .catalog import Catalog
from .state import State, encode


class Learning:
    tools = {
        "skill_read",
        "skill_search",
        "skill_evidence",
        "skill_stage",
        "skill_test",
        "skill_run",
        "skill_activate",
    }

    def __init__(self, state: State, catalog: Catalog):
        self.state, self.catalog = state, catalog

    def request(self, call: str) -> dict:
        source = self.catalog.evidence(call)
        if not source["check"] or source["check"]["passed"]:
            raise ValueError("Choose a skill call with a failed independent check")
        if source["arguments"] is None:
            raise ValueError(
                "The original input is unavailable. Run the skill again and check its result."
            )
        if self.catalog.active(source["skill"]) != source["revision"]:
            raise ValueError(
                "The active revision changed. Check the current revision on this input."
            )
        return {
            "source_call": call,
            "skill": source["skill"],
            "previous": source["revision"],
            "expected": source["check"]["expected"],
            "deadline": self.state.clock() + 300,
        }

    def consume(self, task: str, req: dict, action: str) -> None:
        with self.state.tx() as conn:
            count = conn.execute(
                "SELECT count(*) FROM events WHERE task=? AND kind='learning.attempt'", (task,)
            ).fetchone()[0]
            if count >= 24 or self.state.clock() >= req["deadline"]:
                raise ValueError("Skill improvement budget exhausted")
            self.state.event(
                task, "learning.attempt", {"action": action, "attempt": count + 1}, conn
            )

    def authorize(self, task: str, req: dict, key: str, arguments: dict) -> None:
        self.consume(task, req, key)
        if key not in self.tools:
            raise ValueError("Tool outside this skill revision attempt")
        if key == "skill_evidence" and arguments.get("call") != req["source_call"]:
            raise ValueError("Read the failed call bound to this task")
        if key == "skill_run" and arguments.get("name") != req["skill"]:
            raise ValueError("Run the skill under revision")
        if key == "skill_stage" and arguments.get("package", {}).get("name") != req["skill"]:
            raise ValueError("Revise the skill named in the source call")
        if key in ("skill_test", "skill_activate"):
            rev = self.catalog.revision(arguments["revision"])
            if rev["author"] != task or rev["name"] != req["skill"]:
                raise ValueError("Select a candidate authored by this revision task")

    def reproduce(self, task: str, req: dict) -> None:
        if self.state.rows(
            "SELECT 1 FROM events WHERE task=? AND kind='learning.reproduced'", task
        ):
            return
        source = self.catalog.evidence(req["source_call"])
        actual = self.catalog.evaluate(req["previous"], source["arguments"])
        if encode(actual) == encode(req["expected"]):
            raise ValueError("The independent check now passes on the original revision")
        self.state.event(
            task,
            "learning.reproduced",
            {
                "source_call": req["source_call"],
                "revision": req["previous"],
                "actual": actual,
                "expected": req["expected"],
            },
        )

    def activate(self, task: str, req: dict, revision: str) -> dict:
        candidate = self.catalog.revision(revision)
        if not candidate["passed"]:
            raise ValueError("Test the candidate before activation")
        old_cases = {encode(c) for c in self.catalog.revision(req["previous"])["spec"]["tests"]}
        for case in candidate["spec"]["tests"]:
            if encode(case) in old_cases:
                continue
            self.consume(task, req, "check regression case on original revision")
            try:
                old = self.catalog.evaluate(req["previous"], case["input"])
                failed_before = encode(old) != encode(case["expected"])
            except (ValueError, subprocess.SubprocessError):
                failed_before = True
            if failed_before:
                break
        else:
            raise ValueError("Add a regression case that fails on the original revision")
        original = self.catalog.evidence(req["source_call"])
        actual = self.catalog.evaluate(revision, original["arguments"])
        passed = encode(actual) == encode(req["expected"])
        self.state.event(
            task,
            "learning.candidate",
            {
                "source_call": req["source_call"],
                "revision": revision,
                "actual": actual,
                "passed": passed,
            },
        )
        if not passed:
            raise ValueError("The candidate still fails the original independent check")
        self.consume(task, req, "activate verified correction")
        return self.catalog.activate(task, revision, previous=req["previous"])

    def finish(self, task: str, req: dict) -> bool:
        if self.state.rows(
            "SELECT 1 FROM events WHERE task=? AND kind='learning.result' AND json_extract(data,'$.passed')=1",
            task,
        ):
            return True
        revision = self.catalog.active(req["skill"])
        if not self.state.rows("SELECT 1 FROM activations WHERE task=? AND rev=?", task, revision):
            return False
        arguments = self.catalog.evidence(req["source_call"])["arguments"]
        result = self.catalog.run(task, req["skill"], arguments)
        checked = self.catalog.attest(
            result["call"],
            req["expected"],
            "Compared to the independent expectation recorded for call " + req["source_call"],
        )
        with self.state.tx() as conn:
            checkpoint = json.loads(
                conn.execute("SELECT checkpoint FROM tasks WHERE id=?", (task,)).fetchone()[0]
            )
            checkpoint["last_verified"] = result
            checkpoint["next"] = "Review the independent comparison and revision tests"
            conn.execute("UPDATE tasks SET checkpoint=? WHERE id=?", (encode(checkpoint), task))
            self.state.event(
                task,
                "learning.result",
                {
                    "source_call": req["source_call"],
                    "previous": req["previous"],
                    **result,
                    **checked,
                },
                conn,
            )
        return checked["passed"]
