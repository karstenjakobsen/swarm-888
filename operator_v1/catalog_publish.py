from collections import defaultdict
from pathlib import PurePosixPath

from .catalog import Catalog, CatalogError
from .catalog_manifest import (
    CatalogItem,
    ExecutableSkillManifest,
    GuideSkillManifest,
    discover_catalog,
)
from .contracts import (
    CatalogPendingCommit,
    CatalogPendingItem,
    CatalogPublishPreview,
    CatalogPublishTips,
)
from .state import State
from .typed_catalogs import TypedCatalogs


def item_paths(item: CatalogItem) -> set[str]:
    paths = {item.path}
    if isinstance(item.manifest, (ExecutableSkillManifest, GuideSkillManifest)):
        directory = PurePosixPath(item.path).parent
        paths.update(str(directory / file) for file in item.manifest.assets)
    return paths


def snapshot_items(catalog: Catalog, revision: str) -> dict[str, CatalogItem]:
    return {item.manifest.canonical_id: item for item in discover_catalog(catalog, revision).items}


def skill_contents(catalog: Catalog, revision: str, item: CatalogItem) -> tuple:
    manifest = item.manifest
    assert isinstance(manifest, ExecutableSkillManifest)
    directory = PurePosixPath(item.path).parent
    return manifest, *(
        catalog.git("rev-parse", f"{revision}:{directory / name}").strip()
        for name in manifest.assets
    )


class CatalogPublishing:
    def __init__(self, state: State):
        self.state = state
        self.catalogs = TypedCatalogs(state)

    def tips(self, catalog: Catalog) -> CatalogPublishTips:
        remote = catalog.remote_revision()
        if not remote:
            raise CatalogError("The configured remote branch is missing")
        return CatalogPublishTips(
            local_revision=catalog.git("rev-parse", "HEAD").strip(),
            remote_revision=remote,
        )

    def record(
        self,
        branch_id: str,
        *,
        remote: str | None = None,
        published: str | None = None,
        error: str | None = None,
    ) -> None:
        with self.state.transaction(write=True) as db:
            db.execute(
                """UPDATE catalog_branches SET remote_revision=COALESCE(?,remote_revision),
                   published_revision=COALESCE(?,published_revision),publish_error=? WHERE id=?""",
                (remote, published, error, branch_id),
            )

    @staticmethod
    def require_fast_forward(catalog: Catalog, tips: CatalogPublishTips) -> None:
        try:
            catalog.git("merge-base", "--is-ancestor", tips.remote_revision, tips.local_revision)
        except CatalogError:
            raise CatalogError("Pull and reconcile the remote branch before publishing") from None

    def preview(self, branch_id: str) -> CatalogPublishPreview:
        catalog = self.catalogs.for_branch(branch_id).catalog
        with catalog.locked():
            tips = self.tips(catalog)
            self.require_fast_forward(catalog, tips)
            base, head = tips.remote_revision, tips.local_revision
            original = snapshot_items(catalog, base)
            final = snapshot_items(catalog, head)
            revisions = catalog.git("rev-list", "--reverse", f"{base}..{head}").splitlines()
            commits = []
            owners: dict[str, set[str]] = defaultdict(set)
            known: dict[str, CatalogItem] = {}
            for snapshot in (original, final):
                for identity, item in snapshot.items():
                    known[identity] = item
                    for path in item_paths(item):
                        owners[path].add(identity)
            for revision in revisions:
                paths = sorted(
                    set(
                        catalog.git(
                            "diff-tree",
                            "--root",
                            "-r",
                            "-m",
                            "--no-renames",
                            "--no-commit-id",
                            "--name-only",
                            "-z",
                            revision,
                        ).split("\0")
                    )
                    - {""}
                )
                commits.append(
                    CatalogPendingCommit(
                        revision=revision,
                        subject=catalog.git("show", "-s", "--format=%s", revision).rstrip("\n"),
                        paths=paths,
                    )
                )
                if revision == head:
                    continue
                # An intermediate commit can be incomplete. Its raw paths still appear in the preview.
                try:
                    intermediate = snapshot_items(catalog, revision)
                except CatalogError:
                    continue
                for identity, item in intermediate.items():
                    known.setdefault(identity, item)
                    for path in item_paths(item):
                        owners[path].add(identity)
            changed: dict[str, set[str]] = defaultdict(set)
            for commit in commits:
                for path in commit.paths:
                    for identity in owners[path]:
                        changed[identity].add(path)
            items = []
            for identity, paths in sorted(changed.items()):
                old, new = original.get(identity), final.get(identity)
                item = new or old or known[identity]
                change = "changed"
                if old and not new:
                    change = "removed"
                elif new and not old:
                    change = "added"
                elif old and new and old.path != new.path:
                    change = "moved"
                items.append(
                    CatalogPendingItem(
                        canonical_id=identity,
                        kind=item.manifest.kind,
                        path=item.path,
                        paths=sorted(paths),
                        change=change,
                    )
                )
            return CatalogPublishPreview(**tips.model_dump(), commits=commits, items=items)

    def publish(self, branch_id: str, reviewed: CatalogPublishTips) -> None:
        catalog = self.catalogs.for_branch(branch_id).catalog
        with catalog.locked():
            try:
                tips = self.tips(catalog)
                if tips != reviewed:
                    raise CatalogError("The branch tips changed. Review a fresh publish preview.")
                self.require_fast_forward(catalog, tips)
                head = tips.local_revision
                if head == tips.remote_revision:
                    self.record(branch_id, remote=head)
                    return
                self.verify_active_skills(catalog, tips)
                output = catalog.git(
                    "push", "--porcelain", "origin", f"{head}:refs/heads/{catalog.config.branch}"
                )
                if catalog.remote_revision() != head:
                    raise CatalogError("The remote branch did not report the published revision")
            except CatalogError as error:
                self.record(branch_id, error=str(error))
                raise
            self.catalogs.accept(catalog, head, remote_revision=head)
            changed = any(line.startswith(" \t") for line in output.splitlines())
            self.record(branch_id, remote=head, published=head if changed else None)

    def verify_active_skills(self, catalog: Catalog, tips: CatalogPublishTips) -> None:
        base = snapshot_items(catalog, tips.remote_revision)
        final = snapshot_items(catalog, tips.local_revision)
        for identity, item in final.items():
            if not isinstance(item.manifest, ExecutableSkillManifest):
                continue
            desired = skill_contents(catalog, tips.local_revision, item)
            old = base.get(identity)
            if (
                old
                and isinstance(old.manifest, ExecutableSkillManifest)
                and (skill_contents(catalog, tips.remote_revision, old) == desired)
            ):
                continue
            active = self.state.active_skill_revision(identity)
            if active:
                try:
                    pinned = snapshot_items(catalog, active).get(identity)
                    if (
                        pinned
                        and isinstance(pinned.manifest, ExecutableSkillManifest)
                        and skill_contents(catalog, active, pinned) == desired
                    ):
                        continue
                except CatalogError:
                    pass
            raise CatalogError(
                f"Test and activate the current revision of {identity} before publishing"
            )
