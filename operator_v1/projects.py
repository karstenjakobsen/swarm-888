from pydantic import Field, JsonValue

from .catalog import Catalog, CatalogError, display_remote
from .skill_program import SkillId
from .state import State
from .tool_types import ToolArguments


class ReadProject(ToolArguments):
    project: SkillId


class ProjectDefinition(ToolArguments):
    name: str = Field(min_length=1, max_length=100)
    description: str = Field(min_length=1, max_length=500)
    hostname: str = Field(default="", max_length=255)
    repo: str = Field(min_length=1, max_length=500)
    upstream: str = Field(default="", max_length=255)


def read_project(catalog: Catalog, state: State, task: str | None, project: str) -> dict:
    path = f"projects/{project}.json"
    try:
        revision = catalog.git("rev-parse", "HEAD").strip()
        definition = ProjectDefinition.model_validate_json(
            catalog.git("show", f"{revision}:{path}")
        )
    except CatalogError:
        raise CatalogError("Project definition is missing from the local catalog") from None
    summary = definition.model_dump()
    summary["repo"] = display_remote(definition.repo)
    result: dict[str, JsonValue] = {
        "project": project,
        **summary,
        "catalog": {
            "repo": display_remote(catalog.config.remote),
            "branch": catalog.config.branch,
            "path": path,
        },
        "revision": revision,
    }
    if task:
        with state.transaction(write=True) as db:
            state.append(
                db,
                task,
                "evidence",
                f"Read project: {definition.name}",
                {"action": "project_read", **result},
            )
    return result
