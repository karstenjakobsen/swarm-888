from typing import Annotated, Literal

from pydantic import Field, StringConstraints, model_validator

from .credentials import Destination
from .http_operations import HttpOperation
from .skill_program import SkillReference
from .tool_types import ToolArguments

ToolName = Annotated[str, StringConstraints(pattern=r"^[a-zA-Z0-9_.-]{1,80}$")]


class ConnectorDefinition(Destination):
    name: str = Field(min_length=1, max_length=100)
    auth: Literal["bearer"]
    tool: ToolName
    operations: dict[ToolName, HttpOperation] = Field(default_factory=dict, max_length=40)
    timeout: float = Field(default=3, ge=0.1, le=20)
    instructions: (
        Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=8000)]
        | None
    ) = None

    def tools(self):
        return [
            {
                "name": name,
                "description": op.description,
                "access": "read" if op.method == "GET" else "write",
            }
            for name, op in self.operations.items()
        ]

    @model_validator(mode="after")
    def default_operation(self):
        if self.operations and self.tool not in self.operations:
            raise ValueError("The default tool must name a declared operation")
        return self


class ProjectDefinition(ToolArguments):
    name: str = Field(min_length=1, max_length=100)
    description: str = Field(min_length=1, max_length=500)
    hostname: str = Field(default="", max_length=255)
    repo: str = Field(min_length=1, max_length=500)
    skills: list[SkillReference] = Field(default_factory=list, max_length=64)
    connectors: list[SkillReference] = Field(default_factory=list, max_length=64)
    upstream: str = Field(default="", max_length=255)
