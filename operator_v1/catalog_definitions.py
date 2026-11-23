from typing import Annotated, Literal

from pydantic import Field, StringConstraints, model_validator

from .credentials import DIGITALOCEAN_ORIGIN, Destination
from .tool_types import ToolArguments

ToolName = Annotated[str, StringConstraints(pattern=r"^[a-zA-Z0-9_.-]{1,80}$")]


class ConnectorDefinition(Destination):
    name: str = Field(min_length=1, max_length=100)
    auth: Literal["bearer"]
    tool: ToolName
    timeout: float = Field(default=3, ge=0.1, le=20)

    @model_validator(mode="after")
    def digitalocean_tool(self):
        if self.endpoint == DIGITALOCEAN_ORIGIN and self.tool != "list_dns_records":
            raise ValueError("The DigitalOcean adapter only supports list_dns_records")
        return self


class ProjectDefinition(ToolArguments):
    name: str = Field(min_length=1, max_length=100)
    description: str = Field(min_length=1, max_length=500)
    hostname: str = Field(default="", max_length=255)
    repo: str = Field(min_length=1, max_length=500)
    upstream: str = Field(default="", max_length=255)
