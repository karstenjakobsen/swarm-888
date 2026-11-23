import asyncio
from datetime import timedelta

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
from pydantic import Field, JsonValue

from .catalog import Catalog, CatalogError, display_remote
from .catalog_definitions import ConnectorDefinition
from .credentials import (
    DIGITALOCEAN_ORIGIN,
    CredentialError,
    CredentialRequired,
    Credentials,
    Destination,
    fingerprint,
)
from .digitalocean import TokenRejected, list_dns_records
from .skill_program import SkillReference
from .state import State
from .tool_types import ToolArguments
from .typed_catalogs import TypedCatalogs


class ConnectorRead(ToolArguments):
    connector: SkillReference
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
    def __init__(self, catalog: Catalog | None, state: State, task: str | None):
        self.catalog = catalog
        self.state = state
        self.task = task
        self.credentials = Credentials(state.settings, state)

    def read(self, args: ConnectorRead, *, expected_destination: Destination | None = None) -> dict:
        if not self.task:
            raise CredentialError("Connector calls require a task")
        catalogs = TypedCatalogs(self.state)
        binding = catalogs.for_kind("connector")
        if binding:
            item = binding.item("connector", catalogs.canonical_id("connector", args.connector))
            config = item.manifest
            source = binding.source(item)
            revision = binding.revision
        else:
            if self.catalog is None:
                raise CatalogError("Connect a connectors catalog first")
            path = f"connectors/{args.connector}.json"
            revision = self.catalog.git("rev-parse", "HEAD").strip()
            config = ConnectorDefinition.model_validate_json(
                self.catalog.git("show", f"{revision}:{path}")
            )
            source = {
                "repo": display_remote(self.catalog.config.remote),
                "branch": self.catalog.config.branch,
                "path": path,
            }
        normal = Destination(endpoint=config.endpoint, secret_ref=config.secret_ref)
        if expected_destination is not None and normal != expected_destination:
            raise CredentialError("The catalog connector no longer matches the approved DNS plan")
        secret = self.credentials.require(self.task, args.connector, normal)
        if not secret:
            raise CredentialRequired("Waiting for the owner to supply a credential")
        parameters = {"Authorization": f"Bearer {secret}"}
        try:
            tools, payload = asyncio.run(self.call(config, parameters, args.arguments))
        except TokenRejected:
            self.credentials.require(self.task, args.connector, normal, replace=True)
            raise CredentialRequired("Waiting for a replacement DigitalOcean token") from None
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
            "catalog": source,
            "revision": revision,
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
            if config.endpoint == DIGITALOCEAN_ORIGIN:
                async with httpx.AsyncClient(
                    headers=headers, trust_env=False, follow_redirects=False
                ) as http:
                    records = await list_dns_records(http, arguments)
                return [
                    {
                        "name": config.tool,
                        "description": "List all DNS records in one DigitalOcean zone.",
                        "access": "read",
                    }
                ], records
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
