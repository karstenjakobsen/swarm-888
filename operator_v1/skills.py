import json
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

from pydantic import JsonValue

from .catalog import AUTHORING_SKILL, Catalog, display_remote
from .executor import load_dependencies
from .skill_program import ExecutableProgram, SkillDefinition, SkillError
from .state import State


class Skills:
    """Git defines skill contents. SQLite records which tested contents are in use."""

    def __init__(self, catalog: Catalog, state: State, task: str | None = None):
        self.catalog = catalog
        self.state = state
        self.task = task

    def evidence(self, db, action: str, summary: str, **fields: JsonValue) -> None:
        if self.task:
            self.state.append(db, self.task, "evidence", summary, {"action": action, **fields})

    def install_seed(self) -> None:
        with self.state.transaction(write=True) as db:
            self.register(
                db, AUTHORING_SKILL, self.catalog.config.seed_revision, "Learn a reusable skill"
            )
            db.execute(
                "INSERT OR IGNORE INTO active_skills VALUES (?,?)",
                (AUTHORING_SKILL, self.catalog.config.seed_revision),
            )

    def register(
        self, db, skill: str, revision: str, description: str, source: str = "authoring"
    ) -> None:
        db.execute(
            """INSERT OR IGNORE INTO skill_revisions(skill,revision,author_task,description,created,source)
               VALUES (?,?,?,?,?,?)""",
            (skill, revision, self.task, description, datetime.now(UTC).isoformat(), source),
        )

    def source(self, skill: str) -> dict[str, JsonValue]:
        return {
            "repo": display_remote(self.catalog.config.remote),
            "branch": self.catalog.config.branch,
            "path": f"skills/{skill}/" + ("SKILL.md" if skill == AUTHORING_SKILL else "skill.json"),
        }

    def active(self) -> list[dict[str, str]]:
        with self.state.transaction() as db:
            return [
                dict(row)
                for row in db.execute(
                    """SELECT skill,revision,description,source FROM active_skills
                       JOIN skill_revisions USING(skill,revision)
                       WHERE source IN ('authoring','executable','file.mode') ORDER BY skill"""
                )
            ]

    def discover(self, query: str) -> dict[str, JsonValue]:
        words = query.lower().split()
        matches = [
            item
            for item in self.active()
            if all(word in f"{item['skill']} {item['description']}".lower() for word in words)
        ]
        with self.state.transaction(write=True) as db:
            self.evidence(
                db,
                "skill_discovery",
                f"Skill search {query!r}: {len(matches)} match(es)",
                query=query,
                matches=[match["skill"] for match in matches],
            )
        return {"skills": [dict(item) for item in matches]}

    def authoring_guide(self) -> dict[str, JsonValue]:
        revision = self.catalog.config.seed_revision
        path = self.revision_path(AUTHORING_SKILL, revision)
        with self.state.transaction(write=True) as db:
            self.evidence(
                db,
                "authoring_guide",
                "Read the foundational authoring skill",
                skill=AUTHORING_SKILL,
                revision=revision,
                procedure=[line for line in (path / "SKILL.md").read_text().splitlines()],
                catalog=self.source(AUTHORING_SKILL),
            )
        return {
            "skill": AUTHORING_SKILL,
            "revision": revision,
            "guide": (path / "SKILL.md").read_text(),
            "template": json.loads((path / "template.json").read_text()),
        }

    @property
    def dependency_policy(self) -> Path:
        return self.catalog.settings.directory / "skill-dependencies.json"

    def dependencies(self) -> dict:
        return {
            name: [command.model_dump() for command in dependency.commands]
            for name, dependency in load_dependencies(self.dependency_policy).items()
        }

    def scaffold(
        self, skill: str, definition: SkillDefinition, entrypoint: str | None = None
    ) -> dict[str, JsonValue]:
        if skill == AUTHORING_SKILL:
            raise SkillError("The foundational skill is versioned with the framework")
        executable = isinstance(definition.program, ExecutableProgram)
        if executable != bool(entrypoint):
            raise SkillError("Executable definitions require an entry point")
        files = {
            "skill.json": definition.model_dump_json(
                indent=2, exclude={"tests"} if executable else None
            )
            + "\n"
        }
        if entrypoint:
            files["run.lua"] = entrypoint.rstrip() + "\n"
            files["tests.json"] = (
                json.dumps([test.model_dump() for test in definition.tests], indent=2) + "\n"
            )
        with self.catalog.locked():
            root = self.catalog.checkout / "skills"
            directory = root / skill
            if root.is_symlink() or directory.is_symlink():
                raise SkillError("Skill source path cannot be a symbolic link")
            if self.catalog.git("status", "--porcelain"):
                raise SkillError("Catalog checkout has local changes")
            directory.mkdir(exist_ok=True)
            paths = [directory / name for name in files]
            if any(path.is_symlink() for path in paths):
                raise SkillError("Skill files cannot be symbolic links")
            manifest = directory / "skill.json"
            if manifest.is_file():
                previous = json.loads(manifest.read_text())["program"]["source"]
                if (
                    previous in ("executable", "file.mode")
                    and previous != definition.program.source
                ):
                    raise SkillError("Use a new skill ID when changing its execution type")
            relative = str(directory.relative_to(self.catalog.checkout))
            if any(not path.is_file() or path.read_text() != files[path.name] for path in paths):
                for path in paths:
                    path.write_text(files[path.name])
                self.catalog.git("add", "--", relative)
                self.catalog.git("commit", "-m", f"Define skill {skill}", "--", relative)
            revision = self.catalog.git("log", "-n", "1", "--format=%H", "--", relative).strip()
            self.catalog.retain(skill, revision, *files)
            with self.state.transaction(write=True) as db:
                exists = db.execute(
                    "SELECT 1 FROM skill_revisions WHERE skill=? AND revision=?", (skill, revision)
                ).fetchone()
                older = db.execute(
                    "SELECT 1 FROM skill_revisions WHERE skill=? LIMIT 1", (skill,)
                ).fetchone()
                self.register(db, skill, revision, definition.purpose, definition.program.source)
                if not exists:
                    self.evidence(
                        db,
                        "skill_revised" if older else "skill_built",
                        f"Built {skill} at {revision}",
                        skill=skill,
                        revision=revision,
                        name=definition.name,
                        purpose=definition.purpose,
                        procedure=list(definition.procedure),
                        catalog=self.source(skill),
                        authoring_revision=self.catalog.config.seed_revision,
                    )
        return {"skill": skill, "revision": revision}

    def revision_path(self, skill: str, revision: str) -> Path:
        return self.catalog.settings.directory / "revisions" / revision / skill

    def execute(self, skill: str, revision: str, action: str, arguments=None):
        try:
            execution = subprocess.run(
                [sys.executable, "-m", "operator_v1.executor"],
                input=json.dumps(
                    {
                        "action": action,
                        "path": str(self.revision_path(skill, revision)),
                        "policy": str(self.dependency_policy),
                        "arguments": arguments,
                    }
                ),
                text=True,
                capture_output=True,
                check=True,
                timeout=30,
            )
            result = json.loads(execution.stdout)
        except (OSError, ValueError, subprocess.SubprocessError):
            raise SkillError("The pinned skill helper could not complete") from None
        if "error" in result:
            raise SkillError(result["error"])
        return result["result"]

    def test(self, skill: str, revision: str) -> dict[str, JsonValue]:
        results = self.execute(skill, revision, "test")
        passed = all(result["passed"] for result in results)
        with self.state.transaction(write=True) as db:
            if not db.execute(
                "UPDATE skill_revisions SET tests=? WHERE skill=? AND revision=?",
                (json.dumps(results), skill, revision),
            ).rowcount:
                raise SkillError("Unknown skill revision")
            self.evidence(
                db,
                "skill_tested",
                f"Self-tests {'passed' if passed else 'failed'} for {skill}",
                skill=skill,
                revision=revision,
                tests=results,
            )
        return {"skill": skill, "revision": revision, "passed": passed, "tests": results}

    def activate(
        self, skill: str, revision: str, *, rollback: bool = False
    ) -> dict[str, JsonValue]:
        with self.state.transaction(write=True) as db:
            row = db.execute(
                "SELECT tests FROM skill_revisions WHERE skill=? AND revision=?", (skill, revision)
            ).fetchone()
            if (
                not row
                or not row["tests"]
                or not all(test["passed"] for test in json.loads(row["tests"]))
            ):
                raise SkillError("Run passing self-tests on this revision before activation")
            if (
                rollback
                and not db.execute(
                    "SELECT 1 FROM skill_activations WHERE skill=? AND revision=? LIMIT 1",
                    (skill, revision),
                ).fetchone()
            ):
                raise SkillError("Rollback requires a previously active revision")
            current = db.execute(
                "SELECT revision FROM active_skills WHERE skill=?", (skill,)
            ).fetchone()
            changed = not current or current["revision"] != revision
            if changed:
                db.execute(
                    """INSERT INTO active_skills VALUES (?,?)
                       ON CONFLICT(skill) DO UPDATE SET revision=excluded.revision""",
                    (skill, revision),
                )
                db.execute(
                    "INSERT INTO skill_activations(skill,revision,task,at,action) VALUES (?,?,?,?,?)",
                    (
                        skill,
                        revision,
                        self.task,
                        datetime.now(UTC).isoformat(),
                        "rollback" if rollback else "activate",
                    ),
                )
                self.evidence(
                    db,
                    "skill_activated",
                    f"{'Restored' if rollback else 'Activated'} {skill} at {revision}",
                    skill=skill,
                    revision=revision,
                    reason="Restored an earlier active revision."
                    if rollback
                    else "Passed self-tests on this revision.",
                )
        return {"skill": skill, "revision": revision, "changed": changed}

    def input_schema(self, skill: str, revision: str) -> dict:
        return json.loads((self.revision_path(skill, revision) / "skill.json").read_text())[
            "program"
        ]["input_schema"]

    def invoke(self, skill: str, arguments: dict[str, JsonValue]) -> dict[str, JsonValue]:
        with self.state.transaction() as db:
            row = db.execute(
                "SELECT revision FROM active_skills WHERE skill=?", (skill,)
            ).fetchone()
        if not row or skill == AUTHORING_SKILL:
            raise SkillError("No executable active revision")
        revision = row["revision"]
        args = arguments
        result = self.execute(skill, revision, "invoke", args)
        with self.state.transaction(write=True) as db:
            call = db.execute(
                "INSERT INTO skill_calls(skill,revision,task,arguments,result) VALUES (?,?,?,?,?)",
                (skill, revision, self.task, json.dumps(args), json.dumps(result)),
            ).lastrowid
            self.evidence(
                db,
                "skill_invoked",
                f"Ran {skill} at {revision}",
                skill=skill,
                revision=revision,
                arguments=args,
                result=result,
                call=call,
            )
        return {"skill": skill, "revision": revision, "result": result}
