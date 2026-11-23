import re
from dataclasses import dataclass
from typing import Annotated, Literal, get_args

import yaml
from pydantic import (
    BaseModel,
    Field,
    JsonValue,
    StringConstraints,
    TypeAdapter,
    ValidationError,
    field_serializer,
    field_validator,
)
from yaml.events import AliasEvent
from yaml.nodes import MappingNode

from .catalog import Catalog, CatalogError, display_remote
from .catalog_definitions import ConnectorDefinition, ProjectDefinition
from .contracts import CatalogKind
from .skill_program import ExecutableProgram, ExecutableTest, Revision, SkillId
from .tool_types import ToolArguments

CATALOG_KINDS = get_args(CatalogKind)
ID_PART = r"[a-z0-9]+(?:-[a-z0-9]+)*"
ID_PATTERN = rf"^{ID_PART}-(?:skill|connector|project)-{ID_PART}$"
CanonicalId = Annotated[str, StringConstraints(pattern=ID_PATTERN)]
LuaFile = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9][A-Za-z0-9_.-]*\.lua$")]
TestFile = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9][A-Za-z0-9_.-]*\.json$")]


def assign_canonical_id(publisher: str, kind: CatalogKind, slug: str) -> str:
    if kind not in CATALOG_KINDS or not all(
        re.fullmatch(ID_PART, part) for part in (publisher, slug)
    ):
        raise CatalogError(
            "Use lowercase dash-separated publisher and slug values and a catalog kind"
        )
    return f"{publisher}-{kind}-{slug}"


class ManifestHeader(ToolArguments):
    schema_version: Annotated[int, Field(strict=True, ge=1, le=1)]
    canonical_id: CanonicalId
    name: str = Field(min_length=1, max_length=100)


class SkillManifest(ManifestHeader):
    kind: Literal["skill"]
    purpose: str | None = Field(default=None, min_length=1, max_length=500)
    procedure: list[str] = Field(default_factory=list, max_length=20)
    entrypoint: LuaFile
    tests: TestFile
    dependencies: list[SkillId] = Field(default_factory=list, max_length=8)
    input_schema: dict[str, JsonValue]

    @field_validator("input_schema")
    @classmethod
    def valid_input_schema(cls, schema: dict[str, JsonValue]) -> dict[str, JsonValue]:
        return ExecutableProgram.valid_schema(schema)


class ConnectorManifest(ManifestHeader, ConnectorDefinition):
    kind: Literal["connector"]


class ProjectManifest(ManifestHeader, ProjectDefinition):
    kind: Literal["project"]

    @field_serializer("repo", when_used="json")
    def public_repo(self, repo: str) -> str:
        return display_remote(repo)


Manifest = Annotated[
    SkillManifest | ConnectorManifest | ProjectManifest, Field(discriminator="kind")
]
MANIFEST = TypeAdapter(Manifest)
EXECUTABLE_TESTS = TypeAdapter(Annotated[list[ExecutableTest], Field(min_length=1, max_length=40)])
COMMIT_SHA = TypeAdapter(Revision)


class CatalogItem(BaseModel):
    path: str
    manifest: Manifest


class CatalogSnapshot(BaseModel):
    repo: str
    branch: str
    revision: Revision
    items: tuple[CatalogItem, ...]


class ManifestLoader(yaml.SafeLoader):
    def compose_node(self, parent, index):
        if self.check_event(AliasEvent):
            raise yaml.YAMLError("Catalog manifests do not support YAML aliases")
        return super().compose_node(parent, index)

    def construct_mapping(self, node, deep=False):
        if not isinstance(node, MappingNode):
            return super().construct_mapping(node, deep)
        mapping = {}
        for key_node, value_node in node.value:
            key = self.construct_object(key_node, deep=deep)
            if not isinstance(key, str) or key in mapping:
                raise yaml.YAMLError("Catalog manifest mapping keys must be unique strings")
            mapping[key] = self.construct_object(value_node, deep=deep)
        return mapping


@dataclass(frozen=True)
class TreeEntry:
    mode: str
    object_id: str


def read_tree(catalog: Catalog, revision: str) -> dict[str, TreeEntry]:
    entries = {}
    try:
        tree = catalog.git("ls-tree", "-z", revision)
    except UnicodeError:
        raise CatalogError("Catalog paths must be UTF-8") from None
    for record in tree.split("\0"):
        if record:
            metadata, name = record.split("\t", 1)
            mode, _, object_id = metadata.split()
            entries[name] = TreeEntry(mode, object_id)
    return entries


def regular_file(entries: dict[str, TreeEntry], filename: str, path: str) -> TreeEntry:
    entry = entries.get(filename)
    if not entry or entry.mode not in ("100644", "100755"):
        raise CatalogError(f"{path} must be a regular file in the catalog commit")
    return entry


def read_manifest(catalog: Catalog, entry: TreeEntry, path: str) -> Manifest:
    try:
        data = yaml.load(catalog.git("cat-file", "blob", entry.object_id), Loader=ManifestLoader)
    except (yaml.YAMLError, UnicodeError, RecursionError):
        raise CatalogError(f"Invalid YAML manifest at {path}") from None
    try:
        return MANIFEST.validate_python(data)
    except ValidationError as error:
        fields = sorted(
            {
                ".".join(str(part) for part in detail["loc"]) or "manifest"
                for detail in error.errors(include_input=False)
            }
        )
        raise CatalogError(f"Invalid manifest at {path} ({', '.join(fields)})") from None


def discover_catalog(
    catalog: Catalog, revision: str, kind: CatalogKind | None = None
) -> CatalogSnapshot:
    try:
        COMMIT_SHA.validate_python(revision)
    except ValidationError:
        raise CatalogError("Use a full Git commit SHA for catalog discovery") from None
    if catalog.git("rev-parse", "--verify", f"{revision}^{{commit}}").strip() != revision:
        raise CatalogError("Use a full Git commit SHA for catalog discovery")

    root = read_tree(catalog, revision)
    locations = [("", root)]
    locations.extend(
        (f"{name}/", read_tree(catalog, entry.object_id))
        for name, entry in root.items()
        if entry.mode == "040000"
    )
    items: dict[str, CatalogItem] = {}
    for prefix, entries in locations:
        if "operator.yaml" not in entries:
            continue
        path = prefix + "operator.yaml"
        manifest = read_manifest(catalog, regular_file(entries, "operator.yaml", path), path)
        previous = items.get(manifest.canonical_id)
        if previous:
            raise CatalogError(
                f"Duplicate canonical ID {manifest.canonical_id} in {previous.path} and {path}"
            )
        if isinstance(manifest, SkillManifest):
            regular_file(entries, manifest.entrypoint, prefix + manifest.entrypoint)
            tests_path = prefix + manifest.tests
            tests = regular_file(entries, manifest.tests, tests_path)
            try:
                EXECUTABLE_TESTS.validate_json(catalog.git("cat-file", "blob", tests.object_id))
            except (ValidationError, UnicodeError):
                raise CatalogError(f"Invalid executable self-tests at {tests_path}") from None
        items[manifest.canonical_id] = CatalogItem(path=path, manifest=manifest)

    return CatalogSnapshot(
        repo=display_remote(catalog.config.remote),
        branch=catalog.config.branch,
        revision=revision,
        items=tuple(item for item in items.values() if kind is None or item.manifest.kind == kind),
    )
