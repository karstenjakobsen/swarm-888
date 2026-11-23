from pydantic import JsonValue

from .catalog import Catalog, CatalogError, display_remote
from .catalog_definitions import ProjectDefinition
from .skill_program import SkillReference
from .state import State
from .tool_types import ToolArguments
from .typed_catalogs import TypedCatalogs


class ReadProject(ToolArguments):
    project: SkillReference


def read_project(catalog: Catalog | None, state: State, task: str | None, project: str) -> dict:
    catalogs = TypedCatalogs(state)
    binding = catalogs.for_kind("project")
    if binding:
        item = binding.item("project", catalogs.canonical_id("project", project))
        revision, definition, source = (
            binding.item_revision(item),
            item.manifest,
            binding.source(item),
        )
    else:
        if catalog is None:
            raise CatalogError("Connect a projects catalog first")
        path = f"projects/{project}.json"
        try:
            revision = catalog.git("rev-parse", "HEAD").strip()
            definition = ProjectDefinition.model_validate_json(
                catalog.git("show", f"{revision}:{path}")
            )
        except CatalogError:
            raise CatalogError("Project definition is missing from the local catalog") from None
        source = {
            "repo": display_remote(catalog.config.remote),
            "branch": catalog.config.branch,
            "path": path,
        }
    summary = definition.model_dump()
    summary["repo"] = display_remote(definition.repo)
    result: dict[str, JsonValue] = {
        "project": project,
        **summary,
        "catalog": source,
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
