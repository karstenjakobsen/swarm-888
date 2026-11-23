import argparse
import asyncio
import json
import os
from typing import Any

from mcp import types
from mcp.server import NotificationOptions, Server
from mcp.server.stdio import stdio_server
from pydantic import Field, JsonValue, ValidationError

from .builtin_skills import CONNECT_CATALOG, builtin_guide
from .catalog import Catalog, CatalogError
from .config import Settings
from .connectors import ConnectorRead, ConnectorService
from .credentials import CredentialError
from .goals import ChangeGoal, CreateGoal, GoalError, StandingGoals
from .memory import (
    MemoryError,
    MemoryStore,
    ReadMemory,
    RemoveMemory,
    ReviseMemory,
    SearchMemory,
    WriteMemory,
)
from .projects import ReadProject, read_project
from .skill_program import (
    SkillDefinition,
    SkillError,
    SkillReference,
    SkillRevision,
)
from .skills import Skills
from .state import State
from .tool_types import ToolArguments

NAMED_PREFIX = "run_"


class Discover(ToolArguments):
    query: str = Field(default="", max_length=200)


class Scaffold(ToolArguments):
    skill: SkillReference
    definition: SkillDefinition
    entrypoint: str | None = Field(default=None, max_length=32_768)


class Invoke(ToolArguments):
    skill: SkillReference
    arguments: dict[str, JsonValue]


TOOLS = {
    "skill_discover": (
        Discover,
        "Find active skills by name or purpose. An empty query lists them.",
    ),
    "skill_authoring_guide": (
        ToolArguments,
        "Read the foundational skill and the definition template.",
    ),
    "catalog_connection_guide": (ToolArguments, "Read the bundled owner catalog setup guide."),
    "skill_dependencies": (
        ToolArguments,
        "List owner-approved external commands and argument rules.",
    ),
    "skill_scaffold": (
        Scaffold,
        "Commit a declarative skill definition and return its full revision.",
    ),
    "skill_test": (SkillRevision, "Run candidate self-tests against the immutable revision."),
    "skill_activate": (SkillRevision, "Activate the revision after its exact self-tests pass."),
    "skill_rollback": (SkillRevision, "Restore a previously active, tested skill revision."),
    "skill_invoke": (Invoke, "Invoke the current active revision of a skill by its ID."),
    "memory_search": (SearchMemory, "Find current memory entries by text and optional scope."),
    "memory_read": (ReadMemory, "Read a memory entry and record why this task used it."),
    "memory_write": (WriteMemory, "Save an owner-authorized fact, preference, or procedure."),
    "memory_revise": (ReviseMemory, "Update the specified memory revision and preserve history."),
    "memory_remove": (RemoveMemory, "Remove a memory from active use while preserving provenance."),
    "connector_read": (ConnectorRead, "Use the configured read-only MCP tool for a connector."),
    "goal_list": (ToolArguments, "List standing fixture-file goals and their status."),
    "goal_create": (
        CreateGoal,
        "Maintain a test-owned file mode with an active tested file-mode skill.",
    ),
    "goal_change": (ChangeGoal, "Pause, resume (active), or retire a standing goal."),
    "project_read": (
        ReadProject,
        "Read a project definition and associate it with the current task.",
    ),
}
LOCAL_WRITE_TOOLS = frozenset(
    {
        "skill_scaffold",
        "skill_test",
        "skill_activate",
        "skill_rollback",
        "memory_write",
        "memory_revise",
        "memory_remove",
        "goal_create",
        "goal_change",
    }
)


def build_server(skills: Skills) -> Server:
    server = Server("operator-skills")
    memory = MemoryStore(skills.state, skills.task)
    goals = StandingGoals(skills.state.settings, skills.state)

    @server.list_tools()
    async def list_tools() -> list[types.Tool]:
        active = await asyncio.to_thread(skills.active)
        return [
            types.Tool(
                name=name,
                description=description,
                inputSchema=model.model_json_schema(),
                annotations=types.ToolAnnotations(
                    readOnlyHint=name not in LOCAL_WRITE_TOOLS,
                    destructiveHint=False,
                    openWorldHint=False,
                ),
            )
            for name, (model, description) in TOOLS.items()
        ] + [
            types.Tool(
                name=NAMED_PREFIX + item["skill"],
                description=item["description"],
                inputSchema=skills.input_schema(item["skill"], item["revision"]),
                annotations=types.ToolAnnotations(readOnlyHint=True, openWorldHint=False),
            )
            for item in active
            if item["source"] == "executable"
        ]

    def dispatch(name: str, arguments: dict[str, Any]) -> dict:
        if skills.task and skills.state.stopped(skills.task):
            raise SkillError("This task was stopped")
        match name:
            case "skill_discover":
                return skills.discover(Discover.model_validate(arguments).query)
            case "skill_authoring_guide":
                ToolArguments.model_validate(arguments)
                return skills.authoring_guide()
            case "catalog_connection_guide":
                ToolArguments.model_validate(arguments)
                return builtin_guide(CONNECT_CATALOG)
            case "skill_dependencies":
                ToolArguments.model_validate(arguments)
                return skills.dependencies()
            case "skill_scaffold":
                draft = Scaffold.model_validate(arguments)
                return skills.scaffold(draft.skill, draft.definition, draft.entrypoint)
            case "skill_test":
                candidate = SkillRevision.model_validate(arguments)
                return skills.test(candidate.skill, candidate.revision)
            case "skill_activate" | "skill_rollback":
                candidate = SkillRevision.model_validate(arguments)
                return skills.activate(
                    candidate.skill, candidate.revision, rollback=name == "skill_rollback"
                )
            case "skill_invoke":
                invocation = Invoke.model_validate(arguments)
                return skills.invoke(invocation.skill, invocation.arguments)
            case "memory_search":
                return memory.search(SearchMemory.model_validate(arguments))
            case "memory_read":
                return memory.read(ReadMemory.model_validate(arguments))
            case "memory_write":
                return memory.write(WriteMemory.model_validate(arguments))
            case "memory_revise":
                return memory.revise(ReviseMemory.model_validate(arguments))
            case "memory_remove":
                return memory.remove(RemoveMemory.model_validate(arguments))
            case "connector_read":
                return ConnectorService(skills.catalog, skills.state, skills.task).read(
                    ConnectorRead.model_validate(arguments)
                )
            case "goal_list":
                ToolArguments.model_validate(arguments)
                return goals.goals()
            case "goal_create":
                return goals.create(skills.task, CreateGoal.model_validate(arguments))
            case "goal_change":
                change = ChangeGoal.model_validate(arguments)
                return goals.change(skills.task, change.goal, change.status)
            case "project_read":
                project = ReadProject.model_validate(arguments)
                return read_project(skills.catalog, skills.state, skills.task, project.project)
        if name.startswith(NAMED_PREFIX):
            invocation = Invoke.model_validate(
                {"skill": name.removeprefix(NAMED_PREFIX), "arguments": arguments}
            )
            return skills.invoke(invocation.skill, invocation.arguments)
        raise SkillError("Unknown skill tool")

    @server.call_tool(validate_input=False)
    async def call_tool(name: str, arguments: dict[str, Any]) -> types.CallToolResult:
        try:
            result = await asyncio.to_thread(dispatch, name, arguments)
        except ValidationError:
            message = "Arguments do not match the tool schema"
        except (CatalogError, SkillError, MemoryError, CredentialError, GoalError) as error:
            message = str(error)
        else:
            if name in ("skill_activate", "skill_rollback") and result["changed"]:
                await server.request_context.session.send_tool_list_changed()
            return types.CallToolResult(
                content=[types.TextContent(type="text", text=json.dumps(result))],
                structuredContent=result,
            )
        return types.CallToolResult(
            content=[types.TextContent(type="text", text=message)], isError=True
        )

    return server


async def serve(task: str | None) -> None:
    settings = Settings.load()
    catalog = Catalog.load(settings) if settings.catalog_config.is_file() else None
    server = build_server(Skills(catalog, State(settings), task))
    options = server.create_initialization_options(NotificationOptions(tools_changed=True))
    async with stdio_server() as (read, write):
        await server.run(read, write, options)


if __name__ == "__main__":
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument("--task")
    asyncio.run(serve(parser.parse_args().task))
