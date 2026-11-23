import argparse
import os
from pathlib import Path

from .catalog import Catalog, CatalogError
from .catalog_setup import CatalogSetup
from .config import Settings
from .skills import Skills
from .state import State


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "action", choices=("init", "pull", "push", "switch"), default="init", nargs="?"
    )
    parser.add_argument("--from-remote")
    parser.add_argument("--deploy-key", action="store_true")
    args = parser.parse_args()
    settings = Settings.load()
    if args.action in ("pull", "push"):
        try:
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
    if not remote or not checkout:
        raise SystemExit("Set OPERATOR_CATALOG_REMOTE and OPERATOR_CATALOG_CHECKOUT")
    branch = os.environ.get("OPERATOR_CATALOG_BRANCH", "main")
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
