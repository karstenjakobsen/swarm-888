import json
import re
import subprocess
import sys
from typing import Annotated, Literal

from pydantic import Field, JsonValue, StringConstraints

from .tool_types import ToolArguments

SkillId = Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9-]{0,47}$")]
Revision = Annotated[str, StringConstraints(pattern=r"^([a-f0-9]{40}|[a-f0-9]{64})$")]
Selector = Annotated[
    str, StringConstraints(pattern=r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,126}=[A-Za-z0-9_.-]{1,128}$")
]
FieldName = Literal["name", "image", "state", "exitCode"]
Row = dict[str, JsonValue]
FileMode = Annotated[str, StringConstraints(pattern=r"^[0-7]{3}$")]


class SkillError(RuntimeError):
    """A skill could not be built or used."""


class DockerSelection(ToolArguments):
    selector: Selector = Field(description="Exact Docker label match in key=value form")


class ExitCode(ToolArguments):
    field: Literal["exitCode"]
    when_state: Literal["exited"]


class Program(ToolArguments):
    source: Literal["docker.inspect_labeled"]
    fields: dict[
        Annotated[str, StringConstraints(pattern=r"^[a-z][a-zA-Z0-9_]{0,30}$")], FieldName
    ] = Field(min_length=1, max_length=12)
    exit_code: ExitCode | None = None

    def evaluate(self, rows: list[Row]) -> list[Row]:
        result = []
        for row in rows:
            output = {target: row[field] for target, field in self.fields.items()}
            if self.exit_code and row["state"] == self.exit_code.when_state:
                output[self.exit_code.field] = row[self.exit_code.field]
            result.append(output)
        return result


class FileModeProgram(ToolArguments):
    source: Literal["file.mode"]
    repair_mask: FileMode = "777"

    def mode(self, expected: str) -> int:
        return int(expected, 8) & int(self.repair_mask, 8)

    def evaluate(self, rows: list[Row]) -> list[Row]:
        return [{"mode": f"{self.mode(str(row['expectedMode'])):03o}"} for row in rows]


class SelfTest(ToolArguments):
    name: str = Field(min_length=1, max_length=120)
    rows: list[Row] = Field(max_length=100)
    expected: list[Row] = Field(max_length=100)


class SkillDefinition(ToolArguments):
    name: str = Field(min_length=1, max_length=100)
    purpose: str = Field(min_length=1, max_length=500)
    procedure: list[str] = Field(min_length=1, max_length=20)
    program: Annotated[Program | FileModeProgram, Field(discriminator="source")]
    tests: list[SelfTest] = Field(min_length=1, max_length=40)


def docker(*args: str) -> str:
    try:
        return subprocess.run(
            ["docker", *args], check=True, capture_output=True, text=True, timeout=12
        ).stdout
    except (OSError, subprocess.SubprocessError):
        raise SkillError("Docker could not read the selected containers") from None


def inspect_labeled(selection: DockerSelection) -> list[Row]:
    ids = docker("ps", "-aq", "--filter", f"label={selection.selector}").splitlines()
    if not ids:
        return []
    if len(ids) > 128 or any(not re.fullmatch(r"[a-f0-9]{12,64}", value) for value in ids):
        raise SkillError("Docker selection exceeds the supported limit")
    snapshots = json.loads(docker("inspect", "--type", "container", *ids))
    key, label_value = selection.selector.split("=", 1)
    return sorted(
        [
            {
                "name": row["Name"].removeprefix("/"),
                "image": row["Config"]["Image"],
                "state": row["State"]["Status"],
                "exitCode": row["State"]["ExitCode"],
            }
            for row in snapshots
            if (row["Config"]["Labels"] or {}).get(key) == label_value
        ],
        key=lambda row: str(row["name"]),
    )


def main() -> None:
    request = json.load(sys.stdin)
    definition = SkillDefinition.model_validate(request["definition"])
    if request["action"] == "test":
        result = []
        for test in definition.tests:
            try:
                actual = definition.program.evaluate(test.rows)
            except (KeyError, TypeError):
                actual = None
            result.append(
                {
                    "name": test.name,
                    "rows": test.rows,
                    "passed": actual == test.expected,
                    "expected": test.expected,
                    "actual": actual,
                }
            )
    else:
        if not isinstance(definition.program, Program):
            raise SkillError("File-mode skills run through an authorized standing goal")
        selection = DockerSelection.model_validate(request["arguments"])
        result = definition.program.evaluate(inspect_labeled(selection))
    json.dump(result, sys.stdout)


if __name__ == "__main__":
    try:
        main()
    except SkillError as error:
        json.dump({"error": str(error)}, sys.stdout)
