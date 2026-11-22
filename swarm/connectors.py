"""Remote MCP transport and owner-authorized observations from the Git catalog."""

from __future__ import annotations

import asyncio
import json
import os
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import httpx
import jsonschema
from mcp import ClientSession, types
from mcp.client.streamable_http import streamable_http_client
from pydantic import Field, ValidationError
from referencing import Registry

from .catalog import Catalog, Connector, Contract
from .state import State, digest, encode, name


@dataclass(frozen=True)
class Destination:
    secret: str
    endpoint: str
    slot: str


class CredentialNeeded(ValueError):
    def __init__(self, destination: Destination):
        self.destination = destination
        super().__init__(destination.secret)


def validate_provider_value(value: Any, schema: dict) -> None:
    validator = jsonschema.validators.validator_for(schema)
    validator.check_schema(schema)
    # A provider's schema may use local definitions. Schema lookup stays offline.
    validator(schema, registry=Registry()).validate(value)


class RemoteMCP:
    def __init__(
        self, state: State, definition: Path, bindings: dict[str, str], *, slot: str | None = None
    ):
        self.state, self.definition, self.bindings, self.slot = state, definition, bindings, slot

    def destination(self) -> Destination:
        try:
            doc = Connector.model_validate_json(self.definition.read_text())
        except ValidationError:
            raise ValueError("Invalid connector definition in the catalog") from None
        if self.bindings.get(doc.secret) != doc.endpoint:
            raise ValueError("Connector destination has no matching owner grant")
        return Destination(doc.secret, doc.endpoint, self.slot or doc.secret)

    def settings(self) -> tuple[str, str]:
        dest = self.destination()
        path = self.state.path / "secrets" / (name(dest.slot) + ".key")
        if not path.is_file():
            raise CredentialNeeded(dest)
        return dest.endpoint, path.read_text()

    async def call(
        self, name: str | None = None, arguments: dict | None = None, *, observation: bool = False
    ) -> Any:
        endpoint, secret = self.settings()
        async with (
            asyncio.timeout(25),
            httpx.AsyncClient(
                headers={"Authorization": "Bearer " + secret},
                follow_redirects=False,
                trust_env=False,
                timeout=10,
            ) as http,
            streamable_http_client(endpoint, http_client=http) as (reader, writer, _),
            ClientSession(reader, writer) as client,
        ):
            await client.initialize()
            cursor = None
            tools = {}
            for _ in range(32):
                page = await client.list_tools(cursor=cursor)
                for tool in page.tools:
                    if tool.name in tools:
                        raise ValueError("Provider returned duplicate tool names")
                    tools[tool.name] = tool
                cursor = page.nextCursor
                if not cursor:
                    break
            else:
                raise ValueError("Provider tool discovery exceeded the page limit")
            if name is None:
                return sorted(tools)
            tool = tools.get(name)
            if tool is None:
                raise ValueError("The configured tool is absent from provider discovery")
            if (
                observation
                and tool.annotations
                and (
                    tool.annotations.readOnlyHint is False
                    or tool.annotations.destructiveHint is True
                )
            ):
                raise ValueError("The discovered tool conflicts with its read-only grant")
            validate_provider_value(arguments, tool.inputSchema)
            result = await client.send_request(
                types.ClientRequest(
                    types.CallToolRequest(
                        params=types.CallToolRequestParams(name=name, arguments=arguments)
                    )
                ),
                types.CallToolResult,
            )
            if result.isError:
                raise ValueError("Provider reported a tool error")
            if tool.outputSchema is not None:
                validate_provider_value(result.structuredContent, tool.outputSchema)
            if result.structuredContent is not None:
                value = result.structuredContent
            else:
                if any(item.type != "text" for item in result.content):
                    raise ValueError("This observation requires JSON or text output")
                text = "\n".join(item.text for item in result.content)
                try:
                    value = json.loads(text)
                except ValueError:
                    value = {"text": text}
            return self.state.redact(value)


class Query(Contract):
    tool: str = Field(min_length=1, max_length=128)
    arguments: dict = Field(default_factory=dict)


class Grant(Connector):
    observations: dict[str, Query] = Field(default_factory=dict)


class ConnectorObservations:
    def __init__(self, state: State, catalog: Catalog):
        self.state, self.catalog = state, catalog

    def grant(self, connector: str) -> Grant | None:
        path = os.getenv("SWARM_CONNECTOR_GRANTS")
        if not path:
            return None
        file = Path(path).resolve(strict=True)
        if any(
            file.is_relative_to(root)
            for root in (
                self.catalog.path,
                self.state.path / "workspaces",
                self.state.path / "fixtures",
                self.state.path / "objects",
            )
        ):
            raise ValueError("Keep connector grants outside agent-editable paths")
        doc = json.loads(file.read_text())
        if not isinstance(doc, dict):
            raise ValueError("Expected a JSON object mapping connector names to grants")
        if connector not in doc:
            return None
        try:
            return Grant.model_validate(doc[connector])
        except ValidationError:
            raise ValueError("Invalid owner grant for the selected connector") from None

    def remote(self, connector: str, grant: Grant) -> RemoteMCP:
        slot = "remote-" + digest([grant.secret, grant.endpoint])[:32]
        return RemoteMCP(
            self.state,
            self.catalog.safe("connectors/" + name(connector) + ".json"),
            {grant.secret: grant.endpoint},
            slot=slot,
        )

    def dns_remote(self, default_endpoint: str) -> RemoteMCP:
        grant = self.grant("digitalocean")
        if grant is not None:
            return self.remote("digitalocean", grant)
        return RemoteMCP(
            self.state,
            self.catalog.safe("connectors/digitalocean.json"),
            {"digitalocean": default_endpoint},
        )

    def resolve(self, connector: str, query: str) -> tuple[RemoteMCP, Query]:
        grant = self.grant(connector)
        if grant is None or query not in grant.observations:
            raise ValueError(
                "The requested observation has no matching entry in SWARM_CONNECTOR_GRANTS"
            )
        return self.remote(connector, grant), grant.observations[query]

    def binding(self, task: str, req: dict) -> tuple[RemoteMCP, Query]:
        remote, query = self.resolve(req["connector"], req["query"])
        intent = {
            **asdict(remote.destination()),
            **query.model_dump(),
            "connector": req["connector"],
            "query": req["query"],
        }
        with self.state.tx() as conn:
            conn.execute(
                "INSERT OR IGNORE INTO connector_observations(task,intent) VALUES (?,?)",
                (task, encode(intent)),
            )
            saved = conn.execute(
                "SELECT intent FROM connector_observations WHERE task=?", (task,)
            ).fetchone()[0]
            if saved != encode(intent):
                raise ValueError(
                    "The authorized observation changed. Review the new binding and submit a new task."
                )
        return remote, query

    def result(self, task: str) -> dict:
        row = self.state.one(
            "SELECT intent,result,observed FROM connector_observations WHERE task=?", task
        )
        if row["result"] is None:
            raise ValueError("This task has no completed connector observation")
        intent = json.loads(row["intent"])
        return {
            "source_task": task,
            "connector": intent["connector"],
            "tool": intent["tool"],
            "observed": row["observed"],
            "result": json.loads(row["result"]),
        }

    async def step(self, task: str, req: dict) -> str:
        saved = self.state.rows("SELECT result FROM connector_observations WHERE task=?", task)
        if saved and saved[0]["result"] is not None:
            return "verified"
        try:
            remote, query = self.binding(task, req)
        except (OSError, ValueError, KeyError) as exc:
            self.state.event(
                task,
                "question",
                {"text": str(exc) + ". Send recheck after correcting the binding."},
            )
            return "waiting"
        remote.settings()
        now = self.state.clock()
        with self.state.tx() as conn:
            charged = conn.execute(
                """UPDATE connector_observations SET attempts=attempts+1,deadline=coalesce(deadline,?)
                WHERE task=? AND attempts<4 AND (deadline IS NULL OR deadline>?)""",
                (now + 180, task, now),
            ).rowcount
        if not charged:
            self.state.event(
                task,
                "connector.unknown",
                {
                    "connector": req["connector"],
                    "query": req["query"],
                    "reason": "Observation budget exhausted",
                },
            )
            return "unknown"
        try:
            result = await remote.call(query.tool, query.arguments, observation=True)
            payload = encode(result)
            if len(payload.encode()) > 96000:
                raise ValueError("Provider result exceeds the observation size limit")
        except CredentialNeeded:
            raise
        except Exception:
            self.state.event(
                task,
                "connector.unknown",
                {
                    "connector": req["connector"],
                    "tool": query.tool,
                    "reason": "Provider did not return a verifiable observation",
                },
            )
            self.state.change("UPDATE tasks SET wake=? WHERE id=?", self.state.clock() + 3, task)
            return "observing"
        with self.state.tx() as conn:
            at = self.state.clock()
            conn.execute(
                "UPDATE connector_observations SET result=?,observed=? WHERE task=?",
                (payload, at, task),
            )
            checkpoint = json.loads(
                conn.execute("SELECT checkpoint FROM tasks WHERE id=?", (task,)).fetchone()[0]
            )
            checkpoint["last_verified"] = {
                "source_task": task,
                "connector": req["connector"],
                "tool": query.tool,
                "observed": at,
                "result_hash": digest(result),
            }
            checkpoint["next"] = (
                "Use connector_result with the source task ID to retrieve the saved observation"
            )
            conn.execute("UPDATE tasks SET checkpoint=? WHERE id=?", (encode(checkpoint), task))
            self.state.event(
                task, "connector.observed", {**checkpoint["last_verified"], "result": result}, conn
            )
        return "verified"
