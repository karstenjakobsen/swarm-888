import asyncio
from datetime import timedelta
from typing import Annotated, Literal

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
from pydantic import Field, JsonValue, StringConstraints

from .catalog import Catalog, display_remote
from .credentials import CredentialError, Credentials, Destination, fingerprint
from .skill_program import SkillId
from .state import State
from .tool_types import ToolArguments

ToolName = Annotated[str, StringConstraints(pattern=r"^[a-zA-Z0-9_.-]{1,80}$")]


class ConnectorDefinition(Destination):
    name: str = Field(min_length=1, max_length=100)
    auth: Literal["bearer"]
    tool: ToolName
    timeout: float = Field(default=3, ge=0.1, le=20)


class ConnectorRead(ToolArguments):
    connector: SkillId
    arguments: dict[str, JsonValue] = Field(default_factory=dict)


def redact(value: JsonValue, secret: str) -> JsonValue:
    if isinstance(value, str):
        return value.replace(secret, "[redacted]")
    if isinstance(value, list):
        return [redact(item, secret) for item in value]
    if isinstance(value, dict):
        return {
            name.replace(secret, "[redacted]"): redact(item, secret) for name, item in value.items()
        }
    return value


class ConnectorService:
    def __init__(self, catalog: Catalog, state: State, task: str | None):
        self.catalog = catalog
        self.state = state
        self.task = task
        self.credentials = Credentials(catalog.settings, state)

    def read(self, args: ConnectorRead) -> dict:
        if not self.task:
            raise CredentialError("Connector calls require a task")
        path = f"connectors/{args.connector}.json"
        config = ConnectorDefinition.model_validate_json(self.catalog.git("show", f"HEAD:{path}"))
        normal = Destination(endpoint=config.endpoint, secret_ref=config.secret_ref)
        secret = self.credentials.require(self.task, args.connector, normal)
        if not secret:
            raise CredentialError("Waiting for the owner to supply a credential")
        parameters = {"Authorization": f"Bearer {secret}"}
        try:
            tools, payload = asyncio.run(self.call(config, parameters, args.arguments))
        except TimeoutError:
            with self.state.transaction(write=True) as db:
                self.state.append(
                    db,
                    self.task,
                    "failed",
                    f"Connector {config.name} timed out.",
                    {"action": "connector_timeout", "connector": args.connector},
                )
            raise CredentialError("Connector read timed out") from None
        except (ExceptionGroup, httpx.HTTPError):
            raise CredentialError("The connector request failed") from None
        payload = redact(payload, secret)
        fields: dict[str, JsonValue] = {
            "action": "connector_configured",
            "connector": args.connector,
            "name": config.name,
            "tools": redact(tools, secret),
            "fingerprint": fingerprint(secret),
            "catalog": {
                "repo": display_remote(self.catalog.config.remote),
                "branch": self.catalog.config.branch,
                "path": path,
            },
        }
        with self.state.transaction(write=True) as db:
            self.state.append(
                db, self.task, "evidence", f"Discovered tools for {config.name}.", fields
            )
            self.state.append(
                db,
                self.task,
                "evidence",
                f"Read {config.name} using {config.tool}.",
                {
                    "action": "connector_used",
                    "connector": args.connector,
                    "tool": config.tool,
                    "result": payload,
                },
            )
        return {"tool": config.tool, "result": payload}

    async def call(
        self,
        config: ConnectorDefinition,
        headers: dict[str, str],
        arguments: dict[str, JsonValue],
    ) -> tuple[list[JsonValue], JsonValue]:
        async with asyncio.timeout(config.timeout):
            async with (
                httpx.AsyncClient(headers=headers, trust_env=False, follow_redirects=False) as http,
                streamable_http_client(
                    config.endpoint, http_client=http, terminate_on_close=False
                ) as (read, write, _),
                ClientSession(
                    read, write, read_timeout_seconds=timedelta(seconds=config.timeout + 1)
                ) as session,
            ):
                await session.initialize()
                listed = (await session.list_tools()).tools
                tool = next((item for item in listed if item.name == config.tool), None)
                if not tool or not tool.annotations or tool.annotations.readOnlyHint is not True:
                    raise CredentialError(
                        "The configured MCP tool did not advertise read-only access"
                    )
                result = await session.call_tool(tool.name, arguments)
                if result.isError:
                    raise CredentialError("The connector reported a failed read")
                tools: list[JsonValue] = [
                    {"name": item.name, "description": item.description or "", "access": "read"}
                    for item in listed
                    if item.annotations and item.annotations.readOnlyHint
                ]
                content: JsonValue = result.structuredContent
                if content is None:
                    content = [item.model_dump(mode="json") for item in result.content]
                return tools, content
