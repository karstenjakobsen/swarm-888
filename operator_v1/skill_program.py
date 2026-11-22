from typing import Annotated, Literal

from jsonschema import Draft202012Validator, SchemaError
from pydantic import Field, JsonValue, StringConstraints, field_validator

from .tool_types import ToolArguments

SkillId = Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9-]{0,47}$")]
Revision = Annotated[str, StringConstraints(pattern=r"^([a-f0-9]{40}|[a-f0-9]{64})$")]
Row = dict[str, JsonValue]
FileMode = Annotated[str, StringConstraints(pattern=r"^[0-7]{3}$")]


class SkillError(RuntimeError):
    """A skill could not be built or used."""


class ExecutableProgram(ToolArguments):
    source: Literal["executable"]
    entrypoint: Literal["run.lua"]
    dependencies: list[SkillId] = Field(default_factory=list, max_length=8)
    input_schema: dict[str, JsonValue]

    @field_validator("input_schema")
    @classmethod
    def valid_schema(cls, schema: dict[str, JsonValue]) -> dict[str, JsonValue]:
        def check(node: JsonValue) -> None:
            if isinstance(node, dict):
                if node.keys() & {"$ref", "$dynamicRef", "$id", "$schema"}:
                    raise ValueError("Input schemas must be self-contained")
                for value in node.values():
                    check(value)
            elif isinstance(node, list):
                for value in node:
                    check(value)

        check(schema)
        if schema.get("type") != "object":
            raise ValueError("Input schema must describe an object")
        try:
            Draft202012Validator.check_schema(schema)
        except SchemaError:
            raise ValueError("Invalid input schema") from None
        return schema


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


class MockCommand(ToolArguments):
    dependency: SkillId
    argv: list[str] = Field(max_length=140)
    stdout: str = Field(max_length=65_536)


class ExecutableTest(ToolArguments):
    name: str = Field(min_length=1, max_length=120)
    arguments: dict[str, JsonValue]
    commands: list[MockCommand] = Field(default_factory=list, max_length=16)
    expected: JsonValue


class SkillDefinition(ToolArguments):
    name: str = Field(min_length=1, max_length=100)
    purpose: str = Field(min_length=1, max_length=500)
    procedure: list[str] = Field(min_length=1, max_length=20)
    program: Annotated[ExecutableProgram | FileModeProgram, Field(discriminator="source")]
    tests: list[ExecutableTest | SelfTest] = Field(min_length=1, max_length=40)
