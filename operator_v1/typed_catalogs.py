from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path

import yaml
from pydantic import ValidationError

from .catalog import Catalog, CatalogConfig, CatalogError, display_remote, run_git
from .catalog_manifest import (
    EXECUTABLE_TESTS,
    MANIFEST,
    MANIFEST_FILE,
    CatalogItem,
    CatalogSnapshot,
    ConnectorManifest,
    ExecutableSkillManifest,
    GuideSkillManifest,
    assign_canonical_id,
    discover_catalog,
    read_guide,
)
from .config import Settings
from .contracts import CatalogConnectionInfo, CatalogItemInfo, CatalogKind
from .state import State


@dataclass(frozen=True)
class CatalogBranch:
    catalog: Catalog
    publisher: str
    revision: str
    remote_revision: str | None = None
    published_revision: str | None = None
    publish_error: str | None = None

    def snapshot(self, kind: CatalogKind | None = None) -> CatalogSnapshot:
        return discover_catalog(self.catalog, self.revision, kind)

    def item(self, kind: CatalogKind, canonical_id: str) -> CatalogItem:
        for item in self.snapshot(kind).items:
            if item.manifest.canonical_id == canonical_id:
                return item
        raise CatalogError(f"No {kind} with that canonical ID in the accepted catalog snapshot")

    def item_revision(self, item: CatalogItem) -> str:
        return self.catalog.git("log", "-1", "--format=%H", self.revision, "--", item.path).strip()

    def source(self, item: CatalogItem) -> dict[str, str]:
        config = self.catalog.config
        return {"repo": display_remote(config.remote), "branch": config.branch, "path": item.path}


def catalog_remote(remote: str) -> str:
    if not remote or remote.startswith("-"):
        raise CatalogError("Provide a Git catalog remote")
    if remote.startswith("git@github.com:"):
        return remote.lower()
    return str(Path(remote).expanduser().resolve()) if ":" not in remote else remote


def catalog_branch_id(remote: str, branch: str) -> str:
    return sha256(f"{catalog_remote(remote)}\n{branch}".encode()).hexdigest()[:24]


def branch_checkout(settings: Settings, row) -> Catalog:
    return Catalog(
        settings,
        CatalogConfig(
            remote=row["remote"],
            branch=row["branch"],
            checkout=row["checkout"],
            seed_version=0,
            seed_revision="",
            deploy_key=bool(row["deploy_key"]),
        ),
        branch_id=row["id"],
    )


class TypedCatalogs:
    def __init__(self, state: State):
        self.state = state

    def branch(self, row) -> CatalogBranch:
        catalog = branch_checkout(self.state.settings, row)
        return CatalogBranch(
            catalog,
            row["publisher"],
            row["revision"],
            row["remote_revision"],
            row["published_revision"],
            row["publish_error"],
        )

    def for_kind(self, kind: CatalogKind) -> CatalogBranch | None:
        with self.state.transaction() as db:
            row = db.execute(
                "SELECT b.* FROM catalog_branches b JOIN catalog_connections c ON c.branch_id=b.id WHERE c.kind=?",
                (kind,),
            ).fetchone()
        return self.branch(row) if row else None

    def bindings(self) -> list[tuple[CatalogKind, CatalogBranch]]:
        with self.state.transaction() as db:
            rows = db.execute(
                "SELECT c.kind,b.* FROM catalog_connections c JOIN catalog_branches b ON c.branch_id=b.id ORDER BY c.kind"
            ).fetchall()
        return [(row["kind"], self.branch(row)) for row in rows]

    def branches(self) -> list[CatalogBranch]:
        with self.state.transaction() as db:
            return [
                self.branch(row) for row in db.execute("SELECT * FROM catalog_branches ORDER BY id")
            ]

    def canonical_id(self, kind: CatalogKind, reference: str) -> str:
        with self.state.transaction() as db:
            row = db.execute(
                "SELECT canonical_id FROM catalog_legacy_ids WHERE kind=? AND legacy_id=?",
                (kind, reference),
            ).fetchone()
        return row[0] if row else reference

    def for_branch(self, branch_id: str) -> CatalogBranch:
        with self.state.transaction() as db:
            row = db.execute(
                """SELECT * FROM catalog_branches WHERE id=?
                   AND EXISTS (SELECT 1 FROM catalog_connections WHERE branch_id=catalog_branches.id)""",
                (branch_id,),
            ).fetchone()
        if row is None:
            raise CatalogError("Choose a connected catalog branch")
        return self.branch(row)

    def accept(
        self, catalog: Catalog, revision: str, *, remote_revision: str | None = None
    ) -> None:
        with self.state.transaction(write=True) as db:
            db.execute(
                "UPDATE catalog_branches SET revision=?,remote_revision=COALESCE(?,remote_revision) WHERE id=?",
                (revision, remote_revision, catalog.branch_id),
            )

    def pull(self, branch_id: str) -> None:
        binding = self.for_branch(branch_id)
        catalog = binding.catalog
        with catalog.locked():
            fetched = catalog.fetch()
            discover_catalog(catalog, fetched)
            head = catalog.git("rev-parse", "HEAD").strip()
            discover_catalog(catalog, head)
            try:
                catalog.git("merge", "--ff-only", fetched)
            except CatalogError:
                raise CatalogError(
                    "Catalog history requires a merge. Local commits are preserved."
                ) from None
            self.accept(catalog, catalog.git("rev-parse", "HEAD").strip(), remote_revision=fetched)

    def write_item(
        self,
        kind: CatalogKind,
        item: str,
        fields: dict,
        *,
        files: dict[str, str] | None = None,
        base_revision: str | None = None,
        check_base: bool = False,
    ) -> tuple[CatalogBranch, CatalogItem, str]:
        binding = self.for_kind(kind)
        if binding is None:
            raise CatalogError(f"Connect a {kind} catalog before saving an item")
        catalog = binding.catalog
        files = files or {}
        with catalog.locked():
            if catalog.git("status", "--porcelain"):
                raise CatalogError("Catalog checkout has local changes")
            head = catalog.git("rev-parse", "HEAD").strip()
            snapshot = discover_catalog(catalog, head)
            items = {found.manifest.canonical_id: found for found in snapshot.items}
            current = items.get(item)
            if not current and item.startswith(f"{binding.publisher}-{kind}-"):
                raise CatalogError("Use an existing canonical ID or a slug for a new item")
            canonical_id = item if current else assign_canonical_id(binding.publisher, kind, item)
            current = items.get(canonical_id)
            if check_base and base_revision != head and (current or base_revision):
                if (
                    not current
                    or base_revision
                    != catalog.git("log", "-1", "--format=%H", head, "--", current.path).strip()
                ):
                    raise CatalogError(
                        "The catalog changed. Read the current definition before revising it."
                    )
            if current and current.manifest.kind != kind:
                raise CatalogError("An existing catalog item has a different kind")
            relative = Path(current.path) if current else Path(item) / MANIFEST_FILE
            if not current and (catalog.checkout / relative.parent).exists():
                raise CatalogError(f"Choose an unused item directory for {item}")
            try:
                manifest = MANIFEST.validate_python(
                    {**fields, "schema_version": 1, "kind": kind, "canonical_id": canonical_id}
                )
            except ValidationError as error:
                raise CatalogError("The catalog item does not match its manifest schema") from error
            guide = None
            if isinstance(manifest, (ExecutableSkillManifest, GuideSkillManifest)):
                if set(files) != set(manifest.assets):
                    raise CatalogError("Supply the skill assets declared by the manifest")
            elif files:
                raise CatalogError("Only skill manifests declare assets")
            if isinstance(manifest, ExecutableSkillManifest):
                try:
                    EXECUTABLE_TESTS.validate_json(files[manifest.tests])
                except ValidationError:
                    raise CatalogError("Supply valid executable self-tests") from None
            elif isinstance(manifest, GuideSkillManifest):
                guide, _ = read_guide(manifest, files.__getitem__, relative.parent.as_posix() + "/")
            contents = {
                relative: yaml.safe_dump(manifest.model_dump(exclude_none=True), sort_keys=False),
                **{relative.parent / name: text for name, text in files.items()},
            }
            paths = [str(path) for path in contents]
            before = {}
            for path, content in contents.items():
                target = catalog.checkout / path
                if (
                    target.is_symlink()
                    or target.parent.is_symlink()
                    or (target.exists() and not target.is_file())
                ):
                    raise CatalogError("Catalog item files must be regular files")
                original = target.read_bytes() if target.is_file() else None
                if original != content.encode():
                    before[target] = original
            if before:
                try:
                    for path, content in contents.items():
                        target = catalog.checkout / path
                        target.parent.mkdir(exist_ok=True)
                        target.write_text(content)
                    catalog.git("add", "--", *paths)
                    catalog.git("commit", "-m", f"Define {canonical_id}", "--", *paths)
                except (CatalogError, OSError):
                    catalog.git("reset", "HEAD", "--", *paths)
                    for target, original in before.items():
                        if original is None:
                            target.unlink(missing_ok=True)
                        else:
                            target.write_bytes(original)
                    if not current:
                        directory = catalog.checkout / relative.parent
                        if directory.is_dir() and not any(directory.iterdir()):
                            directory.rmdir()
                    raise
                head = catalog.git("rev-parse", "HEAD").strip()
                discover_catalog(catalog, head)
            self.accept(catalog, head)
            revision = catalog.git("log", "-n", "1", "--format=%H", "--", *paths).strip()
            return (
                binding,
                CatalogItem(path=relative.as_posix(), manifest=manifest, guide=guide),
                revision,
            )

    @staticmethod
    def check_bindings(db, kinds: list[CatalogKind], branch_id: str, replace: bool) -> None:
        if replace:
            return
        current = dict(db.execute("SELECT kind,branch_id FROM catalog_connections"))
        conflicting = [kind for kind in kinds if current.get(kind, branch_id) != branch_id]
        if conflicting:
            raise CatalogError(f"Confirm a catalog switch for {', '.join(conflicting)}")

    def connect(
        self,
        remote: str,
        branch: str,
        kinds: list[CatalogKind],
        *,
        publisher: str | None = None,
        deploy_key: bool = False,
        replace: bool = False,
    ) -> CatalogBranch:
        remote = catalog_remote(remote)
        settings = self.state.settings
        if settings.catalog_config.is_file():
            legacy = Catalog.load(settings).config
            if (catalog_remote(legacy.remote), legacy.branch) == (remote, branch):
                raise CatalogError(
                    "Migrate the existing checkout before attaching it as a typed catalog"
                )
        if (
            branch.startswith("-")
            or run_git("check-ref-format", "--branch", branch, check=False).returncode
        ):
            raise CatalogError("Provide a valid Git branch")
        if not kinds or len(set(kinds)) != len(kinds):
            raise CatalogError("Select each catalog kind at most once")
        if publisher is None and remote.startswith("git@github.com:"):
            publisher = remote.removeprefix("git@github.com:").split("/", 1)[0]
        if not publisher:
            raise CatalogError("Provide a publisher for this catalog")
        assign_canonical_id(publisher, "skill", "example")
        branch_id = catalog_branch_id(remote, branch)
        checkout = settings.directory / "typed-catalogs" / branch_id
        catalog = Catalog(
            settings,
            CatalogConfig(remote, branch, str(checkout), 0, "", deploy_key),
            branch_id=branch_id,
        )
        with catalog.locked():
            with self.state.transaction() as db:
                self.check_bindings(db, kinds, branch_id, replace)
                row = db.execute(
                    "SELECT * FROM catalog_branches WHERE id=?", (branch_id,)
                ).fetchone()
            if row:
                if (row["publisher"], bool(row["deploy_key"])) != (publisher, deploy_key):
                    raise CatalogError(
                        "Use the existing publisher and SSH settings for this branch"
                    )
                binding = self.branch(row)
            else:
                catalog.prepare_checkout()
                revision = catalog.fetch()
                discover_catalog(catalog, revision)
                catalog.git("merge", "--ff-only", revision)
                head = catalog.git("rev-parse", "HEAD").strip()
                if head != revision:
                    discover_catalog(catalog, head)
                binding = CatalogBranch(catalog, publisher, head, revision)
            with self.state.transaction(write=True) as db:
                self.check_bindings(db, kinds, branch_id, replace)
                db.execute(
                    """INSERT OR IGNORE INTO catalog_branches
                       (id,remote,branch,checkout,publisher,deploy_key,revision,remote_revision)
                       VALUES (?,?,?,?,?,?,?,?)""",
                    (
                        branch_id,
                        remote,
                        branch,
                        str(checkout),
                        publisher,
                        deploy_key,
                        binding.revision,
                        binding.remote_revision,
                    ),
                )
                db.executemany(
                    """INSERT INTO catalog_connections VALUES (?,?)
                       ON CONFLICT(kind) DO UPDATE SET branch_id=excluded.branch_id
                       WHERE branch_id<>excluded.branch_id""",
                    [(kind, branch_id) for kind in kinds],
                )
        return binding

    def status(self) -> list[CatalogConnectionInfo]:
        snapshots: dict[str, CatalogSnapshot] = {}
        with self.state.transaction() as db:
            active = dict(db.execute("SELECT skill,revision FROM active_skills"))
        result = []
        for kind, binding in self.bindings():
            branch_id = binding.catalog.branch_id
            assert branch_id is not None
            if branch_id not in snapshots:
                snapshots[branch_id] = binding.snapshot()
            snapshot = snapshots[branch_id]
            items = [
                CatalogItemInfo(
                    canonical_id=item.manifest.canonical_id,
                    name=item.manifest.name,
                    path=item.path,
                    revision=snapshot.revision,
                    active_revision=active.get(item.manifest.canonical_id)
                    if isinstance(item.manifest, ExecutableSkillManifest)
                    else binding.item_revision(item)
                    if kind in ("connector", "project")
                    else None,
                    guide=item.guide,
                    operations=item.manifest.tools()
                    if isinstance(item.manifest, ConnectorManifest)
                    else [],
                    instructions=item.manifest.instructions
                    if isinstance(item.manifest, ConnectorManifest)
                    else None,
                )
                for item in snapshot.items
                if item.manifest.kind == kind
            ]
            result.append(
                CatalogConnectionInfo(
                    remote=display_remote(binding.catalog.config.remote),
                    branch=snapshot.branch,
                    kind=kind,
                    branch_id=branch_id,
                    revision=snapshot.revision,
                    items=items,
                    remote_revision=binding.remote_revision,
                    published_revision=binding.published_revision,
                    publish_error=binding.publish_error,
                )
            )
        return result
