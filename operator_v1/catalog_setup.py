import json
import os
import subprocess
import tempfile
from hashlib import sha256
from pathlib import Path

from .builtin_skills import builtin_skills
from .catalog import AUTHORING_SKILL, Catalog, CatalogError, display_remote
from .config import Settings
from .contracts import CatalogConnection, CatalogInfo, CatalogStatus, CatalogSync
from .skills import Skills
from .state import State
from .typed_catalogs import TypedCatalogs

# https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints
GITHUB_HOST_KEY = (
    "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n"
)


class CatalogSetup:
    def __init__(self, settings: Settings, state: State):
        self.settings = settings
        self.state = state
        self.key_directory = settings.directory / "catalog-ssh"
        self.sync_path = settings.directory / "catalog-sync.json"

    def public_key(self) -> str | None:
        key = self.key_directory / "identity.pub"
        if key.is_file() and (self.key_directory / "identity").is_file():
            return key.read_text().strip()
        return None

    def generate_key(self) -> None:
        try:
            with self.settings.service_lock("catalog-key"):
                if self.public_key():
                    return
                with tempfile.TemporaryDirectory(dir=self.settings.directory) as staging:
                    target = Path(staging) / "catalog-ssh"
                    target.mkdir(mode=0o700)
                    subprocess.run(
                        [
                            "ssh-keygen",
                            "-q",
                            "-t",
                            "ed25519",
                            "-N",
                            "",
                            "-C",
                            "swarm-catalog",
                            "-f",
                            str(target / "identity"),
                        ],
                        check=True,
                        capture_output=True,
                        timeout=10,
                    )
                    (target / "known_hosts").write_text(GITHUB_HOST_KEY)
                    target.rename(self.key_directory)
        except (OSError, subprocess.SubprocessError):
            raise CatalogError(
                "Could not prepare the catalog SSH key. Check the host setup."
            ) from None

    def sync(self, catalog: Catalog) -> CatalogSync:
        try:
            saved = json.loads(self.sync_path.read_text())
        except (FileNotFoundError, ValueError):
            return CatalogSync()
        if (
            saved.get("remote") != catalog.config.remote
            or saved.get("branch") != catalog.config.branch
        ):
            return CatalogSync()
        return CatalogSync.model_validate(saved)

    def save_sync(self, catalog: Catalog, sync: CatalogSync) -> None:
        with tempfile.NamedTemporaryFile(
            dir=self.settings.directory, delete=False, mode="w"
        ) as record:
            try:
                json.dump(
                    {
                        **sync.model_dump(),
                        "remote": catalog.config.remote,
                        "branch": catalog.config.branch,
                    },
                    record,
                )
                record.flush()
                os.replace(record.name, self.sync_path)
            finally:
                Path(record.name).unlink(missing_ok=True)

    def status(self) -> CatalogStatus:
        setup = {
            "public_key": self.public_key(),
            "builtins": builtin_skills(),
            "connections": TypedCatalogs(self.state).status(),
        }
        if not self.settings.catalog_config.exists():
            return CatalogStatus(**setup)
        catalog = Catalog.load(self.settings)
        return CatalogStatus(
            **self.sync(catalog).model_dump(),
            catalog=CatalogInfo(
                remote=display_remote(catalog.config.remote), branch=catalog.config.branch
            ),
            local_revision=catalog.git("rev-parse", "HEAD").strip(),
            authoring_revision=self.state.active_skill_revision(AUTHORING_SKILL),
            **setup,
        )

    def connect(self, request: CatalogConnection) -> None:
        if request.deploy_key and not self.public_key():
            raise CatalogError("Generate and register the deploy key before connecting.")
        if request.kinds is not None:
            TypedCatalogs(self.state).connect(
                request.remote,
                request.branch,
                request.kinds,
                publisher=request.publisher,
                deploy_key=request.deploy_key,
                replace=request.replace,
            )
            return
        identity = sha256(f"{request.remote}\n{request.branch}".encode()).hexdigest()[:24]
        checkout = self.settings.directory / "catalog-checkouts" / identity
        if self.settings.catalog_config.exists():
            checkout = Catalog.load(self.settings).checkout
        catalog = Catalog.initialize(
            self.settings,
            request.remote,
            request.branch,
            checkout,
            deploy_key=request.deploy_key,
            seed_if_empty=request.seed_if_empty,
        )
        Skills(catalog, self.state).install_seed()
        self.check_read()

    def configured(self) -> Catalog:
        try:
            return Catalog.load(self.settings)
        except FileNotFoundError:
            raise CatalogError("Connect a catalog first.") from None

    def check_read(self) -> None:
        catalog = self.configured()
        with catalog.locked():
            sync = self.sync(catalog)
            try:
                revision = catalog.remote_revision()
                if revision is None:
                    raise CatalogError("The configured branch does not exist on the remote.")
            except CatalogError as error:
                sync.read_error = str(error)
            else:
                sync.read_error = None
                sync.remote_revision = revision
            self.save_sync(catalog, sync)

    def publish(self) -> None:
        catalog = self.configured()
        with catalog.locked():
            sync = self.sync(catalog)
            try:
                revision = catalog.git("rev-parse", "HEAD").strip()
                before = catalog.remote_revision()
                if before != revision:
                    if before is None:
                        raise CatalogError(
                            "The configured branch is missing. Restore it before publishing."
                        )
                    self.verify_active_skills(catalog, before, revision)
                    catalog.push()
                    if catalog.remote_revision() != revision:
                        raise CatalogError(
                            "The remote branch did not report the published revision."
                        )
                    sync.published_revision = revision
                sync.remote_revision = revision
                sync.read_error = None
                sync.publish_error = None
            except CatalogError as error:
                sync.publish_error = str(error)
            self.save_sync(catalog, sync)

    def verify_active_skills(self, catalog: Catalog, base: str, revision: str) -> None:
        try:
            paths = catalog.git("diff", "--name-only", "-z", base, revision, "--", "skills").split(
                "\0"
            )
        except CatalogError:
            raise CatalogError("Fetch and reconcile the remote branch before publishing.") from None
        changed = sorted({path.split("/")[1] for path in paths if path.count("/") >= 2})
        for skill in changed:
            active = self.state.active_skill_revision(skill)
            try:
                if active and catalog.git("rev-parse", f"{active}:skills/{skill}") == catalog.git(
                    "rev-parse", f"{revision}:skills/{skill}"
                ):
                    continue
            except CatalogError:
                pass
            raise CatalogError(
                f"Test and activate the current revision of {skill} before publishing."
            )
