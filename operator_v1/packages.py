from .catalog import CatalogError, display_remote
from .catalog_definitions import ConnectorDefinition, ProjectDefinition
from .http_operations import test_operation
from .skill_program import Revision, SkillReference
from .state import State
from .tool_types import ToolArguments
from .typed_catalogs import TypedCatalogs


class SavePackage(ToolArguments):
    package: SkillReference
    base_revision: Revision | None = None


class SaveConnector(SavePackage):
    definition: ConnectorDefinition


class SaveProject(SavePackage):
    definition: ProjectDefinition


def save_package(state: State, task: str | None, draft: SaveConnector | SaveProject) -> dict:
    if not task:
        raise CatalogError("Author packages from an owner task")
    catalogs = TypedCatalogs(state)
    definition = draft.definition
    tests = []
    if isinstance(definition, ConnectorDefinition):
        kind = "connector"
        if not definition.operations:
            raise CatalogError("Supply HTTP operations and their request/response fixtures")
        for name, operation in definition.operations.items():
            tests.extend(
                f"{name}: {case}" for case in test_operation(operation, definition.endpoint)
            )
    else:
        kind = "project"
        for ref_kind, refs in (("skill", definition.skills), ("connector", definition.connectors)):
            if refs:
                binding = catalogs.for_kind(ref_kind)
                if not binding:
                    raise CatalogError(f"Connect a {ref_kind} catalog to verify project references")
                for ref in refs:
                    binding.item(ref_kind, ref)
        tests.append("Project manifest and catalog references validated")
    branch, item, revision = catalogs.write_item(
        kind,
        draft.package,
        definition.model_dump(exclude_none=True),
        base_revision=draft.base_revision,
        check_base=True,
    )
    result = {
        kind: item.manifest.canonical_id,
        "revision": revision,
        "tests": tests,
        "catalog": branch.source(item),
    }
    if isinstance(definition, ConnectorDefinition):
        result["coverage"] = {
            name: {
                "method": op.method,
                "path": op.path,
                "arguments": [case.arguments for case in op.tests],
            }
            for name, op in definition.operations.items()
        }
    with state.transaction(write=True) as db:
        if kind == "project":
            state.append(
                db,
                task,
                "evidence",
                f"Registered project {definition.name}.",
                {
                    "action": "project_registered",
                    **definition.model_dump(),
                    "repo": display_remote(definition.repo),
                    **result,
                },
            )
        state.append(
            db,
            task,
            "evidence",
            f"Activated {item.manifest.name} at {revision} after {len(tests)} passing checks.",
            {"action": "package_activated", **result},
        )
    return result


def discover_projects(state: State, query: str) -> dict:
    binding = TypedCatalogs(state).for_kind("project")
    return {
        "projects": [
            {
                "project": item.manifest.canonical_id,
                "name": item.manifest.name,
                "revision": binding.revision,
            }
            for item in (binding.snapshot("project").items if binding else [])
            if all(
                word in f"{item.manifest.canonical_id} {item.manifest.name}".casefold()
                for word in query.casefold().split()
            )
        ]
    }
