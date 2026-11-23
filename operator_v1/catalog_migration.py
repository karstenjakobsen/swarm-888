import json
import re
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path

import yaml

from .catalog import Catalog, CatalogConfig, CatalogError
from .catalog_definitions import ConnectorDefinition, ProjectDefinition
from .catalog_manifest import CATALOG_KINDS, MANIFEST, assign_canonical_id, discover_catalog
from .skill_program import FileModeProgram, SkillDefinition
from .state import State
from .typed_catalogs import TypedCatalogs, catalog_branch_id, catalog_remote


@dataclass
class MigrationPlan:
    base_revision: str
    files: dict[str, str]
    removed: list[str]
    aliases: list[tuple[str, str, str]]

    def summary(self) -> dict:
        return {
            "base_revision": self.base_revision,
            "kinds": list(CATALOG_KINDS),
            "items": [
                {
                    "kind": kind,
                    "legacy_id": legacy_id,
                    "canonical_id": canonical_id,
                    "path": f"{canonical_id}/operator.yaml",
                }
                for kind, legacy_id, canonical_id in self.aliases
            ],
            "writes": sorted(self.files),
            "removes": self.removed,
        }


def legacy_skill(read, directory: str) -> tuple[dict, dict[str, str]]:
    old_file = f"{directory}/skill.json"
    payload = json.loads(read(old_file))
    if payload["program"]["source"] == "executable":
        raw_tests = read(f"{directory}/tests.json")
        payload["tests"] = json.loads(raw_tests)
        definition = SkillDefinition.model_validate(payload)
        code = read(f"{directory}/run.lua")
        args = definition.program.input_schema
        dependencies = definition.program.dependencies
    else:
        definition = SkillDefinition.model_validate(payload)
        if not isinstance(definition.program, FileModeProgram):
            raise CatalogError(f"Unsupported legacy program at {old_file}")
        mask = int(definition.program.repair_mask, 8)
        code = (
            "return function(args)\n"
            "  local result = {}\n"
            "  for _, row in ipairs(args.rows) do\n"
            f'    table.insert(result, {{ mode = string.format("%03o", tonumber(row.expectedMode, 8) & {mask}) }})\n'
            "  end\n"
            "  return result\n"
            "end\n"
        )
        args = {
            "type": "object",
            "required": ["rows"],
            "properties": {
                "rows": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "required": ["expectedMode"],
                        "properties": {"expectedMode": {"type": "string", "pattern": "^[0-7]{3}$"}},
                    },
                }
            },
        }
        dependencies = []
        raw_tests = (
            json.dumps(
                [
                    {"name": test.name, "arguments": {"rows": test.rows}, "expected": test.expected}
                    for test in definition.tests
                ],
                indent=2,
            )
            + "\n"
        )
    return {
        "name": definition.name,
        "purpose": definition.purpose,
        "procedure": definition.procedure,
        "entrypoint": "run.lua",
        "tests": "tests.json",
        "input_schema": args,
        "dependencies": dependencies,
    }, {"run.lua": code, "tests.json": raw_tests}


class CatalogMigration:
    def __init__(self, state: State):
        self.state = state
        self.settings = state.settings
        self.catalogs = TypedCatalogs(state)

    def receipt(self) -> dict | None:
        with self.state.transaction() as db:
            row = db.execute("SELECT * FROM catalog_migration WHERE id=1").fetchone()
        return dict(row) if row else None

    @staticmethod
    def plan(catalog: Catalog, base: str, publisher: str) -> MigrationPlan:
        files: dict[str, str] = {}
        aliases = []
        tracked = {}
        for line in catalog.git("ls-tree", "-r", "-z", base).split("\0"):
            if line:
                metadata, path = line.split("\t", 1)
                tracked[path] = metadata.split()[0]
        occupied = {path.split("/", 1)[0] for path in tracked}
        identities = {item.manifest.canonical_id for item in discover_catalog(catalog, base).items}
        removed = {
            path
            for path in (
                "seed.json",
                "skills/create-skill/SKILL.md",
                "skills/create-skill/template.json",
            )
            if path in tracked
        }

        def read(path: str) -> str:
            if tracked.get(path) not in ("100644", "100755"):
                raise CatalogError(f"Expected a tracked regular legacy file at {path}")
            return catalog.git("show", f"{base}:{path}")

        for path in sorted(tracked):
            match = re.fullmatch(
                r"skills/([^/]+)/skill\.json|(connectors|projects)/([^/]+)\.json", path
            )
            if not match:
                continue
            skill, folder, other = match.groups()
            kind = "skill" if skill else folder.removesuffix("s")
            legacy_id = skill or other
            if kind == "skill" and legacy_id == "create-skill":
                removed.add(path)
                continue
            canonical_id = assign_canonical_id(publisher, kind, legacy_id)
            if canonical_id in occupied or canonical_id in identities:
                raise CatalogError(
                    f"Migration collides with {canonical_id} while converting {path}"
                )
            removed.add(path)
            assets = {}
            try:
                if skill:
                    directory = f"skills/{legacy_id}"
                    fields, assets = legacy_skill(read, directory)
                    removed.update(
                        f"{directory}/{name}" for name in assets if f"{directory}/{name}" in tracked
                    )
                else:
                    model = ConnectorDefinition if kind == "connector" else ProjectDefinition
                    fields = model.model_validate_json(read(path)).model_dump()
                manifest = MANIFEST.validate_python(
                    {
                        **fields,
                        "schema_version": 1,
                        "kind": kind,
                        "canonical_id": canonical_id,
                    }
                )
            except (ValueError, KeyError, TypeError):
                raise CatalogError(f"Invalid legacy definition at {path}") from None
            files[f"{canonical_id}/operator.yaml"] = yaml.safe_dump(
                manifest.model_dump(), sort_keys=False
            )
            files.update({f"{canonical_id}/{name}": text for name, text in assets.items()})
            aliases.append((kind, legacy_id, canonical_id))
        return MigrationPlan(base, files, sorted(removed), aliases)

    def prepare(self, catalog: Catalog, plan: MigrationPlan, publisher: str) -> dict:
        if catalog.git("status", "--porcelain"):
            raise CatalogError("Use a clean catalog checkout before migrating")
        revision = plan.base_revision
        if plan.files or plan.removed:
            with tempfile.TemporaryDirectory() as work:
                index = Path(work) / "index"
                catalog.git("read-tree", plan.base_revision, index=index)
                if plan.removed:
                    catalog.git("update-index", "--force-remove", "--", *plan.removed, index=index)
                for path, contents in plan.files.items():
                    blob = catalog.git("hash-object", "-w", "--stdin", input_text=contents).strip()
                    catalog.git(
                        "update-index", "--add", "--cacheinfo", f"100644,{blob},{path}", index=index
                    )
                tree = catalog.git("write-tree", index=index).strip()
            revision = catalog.git(
                "commit-tree",
                tree,
                "-p",
                plan.base_revision,
                "-m",
                "Migrate catalog to typed manifests",
            ).strip()
            discover_catalog(catalog, revision)
        with self.state.transaction(write=True) as db:
            db.execute(
                """INSERT INTO catalog_migration(id,config,publisher,base_revision,revision,aliases)
                   VALUES (1,?,?,?,?,?)""",
                (
                    json.dumps(asdict(catalog.config)),
                    publisher,
                    plan.base_revision,
                    revision,
                    json.dumps(plan.aliases),
                ),
            )
        return self.receipt()

    def finish(self, catalog: Catalog, receipt: dict) -> None:
        config = catalog.config
        branch_id = catalog_branch_id(config.remote, config.branch)
        with self.state.transaction(write=True) as db:
            self.catalogs.check_bindings(db, list(CATALOG_KINDS), branch_id, False)
            db.execute(
                """INSERT INTO catalog_branches(id,remote,branch,checkout,publisher,deploy_key,revision)
                   VALUES (?,?,?,?,?,?,?)""",
                (
                    branch_id,
                    catalog_remote(config.remote),
                    config.branch,
                    str(catalog.checkout),
                    receipt["publisher"],
                    config.deploy_key,
                    receipt["revision"],
                ),
            )
            db.executemany(
                "INSERT INTO catalog_connections VALUES (?,?)",
                [(kind, branch_id) for kind in CATALOG_KINDS],
            )
            db.executemany(
                "INSERT INTO catalog_legacy_ids VALUES (?,?,?)", json.loads(receipt["aliases"])
            )
            db.execute("UPDATE catalog_migration SET completed=1 WHERE id=1")

    def archive_legacy(self) -> None:
        config = self.settings.catalog_config
        if config.exists():
            history = self.settings.directory / "catalog-history"
            history.mkdir(mode=0o700, exist_ok=True)
            target = history / "legacy-before-typed.json"
            if target.exists():
                raise CatalogError("The legacy catalog archive already exists")
            config.rename(target)

    def migrate(self, publisher: str, *, apply: bool) -> dict:
        receipt = self.receipt()
        if receipt:
            if receipt["publisher"] != publisher:
                raise CatalogError("Use the publisher recorded by the migration")
            catalog = Catalog(self.settings, CatalogConfig(**json.loads(receipt["config"])))
        else:
            try:
                catalog = Catalog.load(self.settings)
            except FileNotFoundError:
                raise CatalogError("Configure the legacy catalog before migrating") from None
        with catalog.locked():
            if receipt is None:
                head = catalog.git("rev-parse", "HEAD").strip()
                plan = self.plan(catalog, head, publisher)
                if not apply:
                    return plan.summary()
                with self.state.transaction() as db:
                    if db.execute("SELECT 1 FROM catalog_branches LIMIT 1").fetchone():
                        raise CatalogError("Migrate before connecting typed catalogs")
                receipt = self.prepare(catalog, plan, publisher)
            if apply and not receipt["completed"]:
                head = catalog.git("rev-parse", "HEAD").strip()
                revision = receipt["revision"]
                if head not in (receipt["base_revision"], revision):
                    raise CatalogError(
                        "The branch changed during migration. Preserve it before retrying."
                    )
                if head != revision:
                    catalog.git("merge", "--ff-only", revision)
                self.finish(catalog, receipt)
            if apply:
                self.archive_legacy()
            return {
                "base_revision": receipt["base_revision"],
                "revision": receipt["revision"],
                "kinds": list(CATALOG_KINDS),
                "aliases": json.loads(receipt["aliases"]),
            }
