import argparse
import os
from pathlib import Path

from .catalog import Catalog, CatalogError
from .config import Settings
from .skills import Skills
from .state import State


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("init", "pull", "push"), default="init", nargs="?")
    args = parser.parse_args()
    settings = Settings.load()
    if args.action != "init":
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
    try:
        catalog = Catalog.initialize(
            settings, remote, os.environ.get("OPERATOR_CATALOG_BRANCH", "main"), Path(checkout)
        )
    except CatalogError as error:
        raise SystemExit(str(error)) from None
    Skills(catalog, State(settings)).install_seed()
    print(f"Foundational seed v{catalog.config.seed_version} at {catalog.config.seed_revision}")


if __name__ == "__main__":
    os.umask(0o077)
    main()
