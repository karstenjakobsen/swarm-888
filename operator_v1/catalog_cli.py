import argparse
import json
import os
from pathlib import Path

from .catalog import Catalog, CatalogError
from .catalog_manifest import CATALOG_KINDS, discover_catalog
from .catalog_migration import CatalogMigration
from .catalog_publish import CatalogPublishing
from .catalog_setup import CatalogSetup
from .config import Settings
from .contracts import CatalogPublishTips
from .skills import Skills
from .state import State
from .typed_catalogs import TypedCatalogs


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "action",
        choices=("init", "pull", "push", "switch", "discover", "connect", "preview", "migrate"),
        default="init",
        nargs="?",
    )
    parser.add_argument("--from-remote")
    parser.add_argument("--deploy-key", action="store_true")
    parser.add_argument("--revision", help="Full commit SHA for discovery (defaults to local HEAD)")
    parser.add_argument("--kind", choices=CATALOG_KINDS, help="Filter discovered manifests by kind")
    parser.add_argument("--kinds", choices=CATALOG_KINDS, nargs="+")
    parser.add_argument("--publisher")
    parser.add_argument("--replace", action="store_true")
    parser.add_argument("--branch-id")
    parser.add_argument("--local-revision")
    parser.add_argument("--remote-revision")
    parser.add_argument("--apply", action="store_true", help="Apply a catalog migration")
    args = parser.parse_args()
    settings = Settings.load()
    if args.action == "migrate":
        if not args.publisher:
            parser.error("Set --publisher for the migration")
        try:
            if args.apply:
                with settings.service_lock("controller"), settings.service_lock("worker"):
                    result = CatalogMigration(State(settings)).migrate(args.publisher, apply=True)
            else:
                catalog = Catalog.load(settings)
                head = catalog.git("rev-parse", "HEAD").strip()
                result = CatalogMigration.plan(catalog, head, args.publisher).summary()
            print(json.dumps(result, indent=2))
        except (CatalogError, BlockingIOError, FileNotFoundError) as error:
            raise SystemExit(str(error)) from None
        return
    if args.action == "discover":
        try:
            bindings = TypedCatalogs(State(settings)).bindings()
            binding = next((item for kind, item in bindings if args.kind in (None, kind)), None)
            catalog = binding.catalog if binding else Catalog.load(settings)
            revision = args.revision or (
                binding.revision if binding else catalog.git("rev-parse", "HEAD").strip()
            )
            print(discover_catalog(catalog, revision, args.kind).model_dump_json(indent=2))
        except (CatalogError, FileNotFoundError) as error:
            raise SystemExit(str(error)) from None
        return
    if args.action in ("pull", "push", "preview"):
        try:
            state = State(settings)
            typed = TypedCatalogs(state)
            branches = {binding.catalog.branch_id for _, binding in typed.bindings()}
            if branches or args.action == "preview" or args.branch_id:
                branch_id = args.branch_id
                if not branch_id and len(branches) == 1:
                    branch_id = next(iter(branches))
                if not branch_id:
                    raise CatalogError("Select a connected catalog branch with --branch-id")
                if args.action == "pull":
                    typed.pull(branch_id)
                    print(typed.for_branch(branch_id).revision)
                elif args.action == "preview":
                    print(CatalogPublishing(state).preview(branch_id).model_dump_json(indent=2))
                else:
                    if not args.local_revision or not args.remote_revision:
                        raise CatalogError(
                            "Review the preview and supply both reviewed revision tips"
                        )
                    CatalogPublishing(state).publish(
                        branch_id,
                        CatalogPublishTips(
                            local_revision=args.local_revision,
                            remote_revision=args.remote_revision,
                        ),
                    )
                    print(typed.for_branch(branch_id).published_revision or "No pending commits")
                return
            catalog = Catalog.load(settings)
            with catalog.locked():
                sync = catalog.pull if args.action == "pull" else catalog.push
                sync()
                print(catalog.git("rev-parse", "HEAD").strip())
        except (CatalogError, FileNotFoundError) as error:
            raise SystemExit(str(error)) from None
        return
    remote = os.environ.get("OPERATOR_CATALOG_REMOTE")
    checkout = os.environ.get("OPERATOR_CATALOG_CHECKOUT")
    branch = os.environ.get("OPERATOR_CATALOG_BRANCH", "main")
    if args.action == "connect":
        if not remote or not args.kinds:
            parser.error("Set OPERATOR_CATALOG_REMOTE and select --kinds")
        try:
            state = State(settings)
            if args.deploy_key and not CatalogSetup(settings, state).public_key():
                raise CatalogError("Generate and register the deploy key before connecting.")
            binding = TypedCatalogs(state).connect(
                remote,
                branch,
                args.kinds,
                publisher=args.publisher,
                deploy_key=args.deploy_key,
                replace=args.replace,
            )
            print(binding.revision)
        except CatalogError as error:
            raise SystemExit(str(error)) from None
        return
    if not remote or not checkout:
        raise SystemExit("Set OPERATOR_CATALOG_REMOTE and OPERATOR_CATALOG_CHECKOUT")
    try:
        if args.action == "switch":
            if not args.from_remote:
                raise CatalogError("Enter the current catalog remote with --from-remote.")
            with settings.service_lock("controller"), settings.service_lock("worker"):
                state = State(settings)
                setup = CatalogSetup(settings, state)
                if args.deploy_key and not setup.public_key():
                    raise CatalogError("Generate and register the deploy key before switching.")
                catalog = Catalog.initialize(
                    settings,
                    remote,
                    branch,
                    Path(checkout),
                    deploy_key=args.deploy_key,
                    seed_if_empty=False,
                    replace_from=args.from_remote,
                )
                Skills(catalog, state).install_seed(replace=True)
                setup.check_read()
                print(f"Active authoring seed {catalog.config.seed_revision}")
            return
        catalog = Catalog.initialize(settings, remote, branch, Path(checkout))
    except (CatalogError, BlockingIOError) as error:
        raise SystemExit(str(error)) from None
    Skills(catalog, State(settings)).install_seed()
    print(f"Foundational seed v{catalog.config.seed_version} at {catalog.config.seed_revision}")


if __name__ == "__main__":
    os.umask(0o077)
    main()
