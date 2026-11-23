import fcntl
import json
import os
import shlex
import shutil
import subprocess
import tempfile
from collections.abc import Generator
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from hashlib import sha256
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from .config import Settings

SEED_VERSION = 2
SEED = Path(__file__).parent / "seed" / f"v{SEED_VERSION}"
AUTHORING_SKILL = "create-skill"
LEGACY_SEED_FILES = ("SKILL.md", "template.json")


class CatalogError(RuntimeError):
    """A catalog operation could not finish safely."""


def run_git(
    *args: str,
    cwd: Path | None = None,
    check: bool = True,
    ssh_command: str | None = None,
    input_text: str | None = None,
    index: Path | None = None,
) -> subprocess.CompletedProcess:
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}
    if ssh_command is not None:
        env["GIT_SSH_COMMAND"] = ssh_command
    if index is not None:
        env["GIT_INDEX_FILE"] = str(index)
    return subprocess.run(
        [
            "git",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "protocol.ext.allow=never",
            "-c",
            "user.name=VPS operator",
            "-c",
            "user.email=operator@localhost",
            *args,
        ],
        cwd=cwd,
        capture_output=True,
        input=input_text,
        text=True,
        check=check,
        timeout=30,
        env=env,
    )


def display_remote(remote: str) -> str:
    parsed = urlsplit(remote)
    if not parsed.netloc:
        return remote.split("@", 1)[-1] if ":" in remote else remote
    return urlunsplit((parsed.scheme, parsed.netloc.rsplit("@", 1)[-1], parsed.path, "", ""))


@dataclass(frozen=True)
class CatalogConfig:
    remote: str
    branch: str
    checkout: str
    seed_version: int
    seed_revision: str
    deploy_key: bool = False


class Catalog:
    def __init__(self, settings: Settings, config: CatalogConfig, *, branch_id: str | None = None):
        self.settings = settings
        self.config = config
        self.checkout = Path(config.checkout)
        self.branch_id = branch_id

    @classmethod
    def load(cls, settings: Settings) -> "Catalog":
        return cls(settings, CatalogConfig(**json.loads(settings.catalog_config.read_text())))

    def git(self, *args: str, input_text: str | None = None, index: Path | None = None) -> str:
        ssh = None
        if self.config.deploy_key:
            directory = self.settings.directory / "catalog-ssh"
            ssh = shlex.join(
                [
                    "ssh",
                    "-F",
                    "/dev/null",
                    "-i",
                    str(directory / "identity"),
                    "-o",
                    "IdentitiesOnly=yes",
                    "-o",
                    "BatchMode=yes",
                    "-o",
                    "StrictHostKeyChecking=yes",
                    "-o",
                    "HostKeyAlgorithms=ssh-ed25519",
                    "-o",
                    f"UserKnownHostsFile={directory / 'known_hosts'}",
                ]
            )
        try:
            return run_git(
                *args,
                cwd=self.checkout,
                ssh_command=ssh,
                input_text=input_text,
                index=index,
            ).stdout
        except (OSError, subprocess.SubprocessError):
            # Git's diagnostics can include credentials embedded in the URL.
            raise CatalogError(f"Git {args[0]} failed for the configured catalog") from None

    @contextmanager
    def locked(self) -> Generator[None, None, None]:
        name = f"catalog-{self.branch_id}.lock" if self.branch_id else "catalog.lock"
        with (self.settings.directory / name).open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            yield

    @classmethod
    def initialize(
        cls,
        settings: Settings,
        remote: str,
        branch: str,
        checkout: Path,
        *,
        deploy_key: bool = False,
        seed_if_empty: bool = True,
        replace_from: str | None = None,
    ) -> "Catalog":
        settings.prepare()
        checkout = checkout.resolve()
        if (
            not remote
            or branch.startswith("-")
            or run_git("check-ref-format", "--branch", branch, check=False).returncode
        ):
            raise CatalogError("Provide a catalog remote and a valid Git branch")
        if not urlsplit(remote).scheme and ":" not in remote:
            remote = str(Path(remote).expanduser().resolve())
        framework = Path(__file__).resolve().parents[1]
        if checkout.is_relative_to(framework) or framework.is_relative_to(checkout):
            raise CatalogError("Use a separate checkout outside the framework repository")

        catalog = cls(
            settings, CatalogConfig(remote, branch, str(checkout), SEED_VERSION, "", deploy_key)
        )
        with catalog.locked():
            previous = None
            if settings.catalog_config.exists():
                existing = cls.load(settings)
                if (
                    existing.config.remote,
                    existing.config.branch,
                    existing.checkout,
                    existing.config.deploy_key,
                ) == (
                    remote,
                    branch,
                    checkout,
                    deploy_key,
                ):
                    return existing
                if existing.config.remote != replace_from or checkout == existing.checkout:
                    raise CatalogError("This state directory is already bound to a catalog")
                previous = settings.catalog_config.read_bytes()

            catalog.prepare_checkout()

            refs = catalog.git("ls-remote", "--heads", "origin")
            branch_ref = f"refs/heads/{branch}"
            has_branch = any(line.split()[-1] == branch_ref for line in refs.splitlines())
            remote_seeded = False
            if has_branch:
                catalog.pull()
                remote_seeded = bool(
                    catalog.git("ls-tree", "--name-only", "FETCH_HEAD", "seed.json")
                )
            elif refs.strip():
                raise CatalogError("The requested branch is missing from the nonempty remote")

            if not remote_seeded and not seed_if_empty:
                raise CatalogError(
                    "This branch has no catalog seed. Allow publishing the foundational seed to continue."
                )
            if not (checkout / "seed.json").is_file():
                if set(p.name for p in checkout.iterdir()) != {".git"}:
                    raise CatalogError("Add the foundational seed only to an empty catalog branch")
                directory = Path("skills") / AUTHORING_SKILL
                (checkout / directory).mkdir(parents=True)
                for name in LEGACY_SEED_FILES:
                    shutil.copyfile(SEED / directory / name, checkout / directory / name)
                for folder in ("connectors", "projects"):
                    (checkout / folder).mkdir()
                    (checkout / folder / ".gitkeep").touch()
                (checkout / "seed.json").write_text(json.dumps({"version": SEED_VERSION}) + "\n")
                catalog.git("add", "--", "skills", "projects", "connectors", "seed.json")
                catalog.git(
                    "commit", "-m", f"Seed the foundational authoring skill v{SEED_VERSION}"
                )
            seed_version = json.loads(catalog.git("show", "HEAD:seed.json"))["version"]
            seed_revision = catalog.git(
                "log", "--format=%H", "-n", "1", "--", "skills/create-skill"
            ).strip()
            if seed_version not in (1, SEED_VERSION) or not seed_revision:
                raise CatalogError("The catalog lacks a supported foundational seed")
            if not remote_seeded:
                catalog.push()
            config = CatalogConfig(
                remote, branch, str(checkout), seed_version, seed_revision, deploy_key
            )
            catalog.retain(AUTHORING_SKILL, seed_revision, *LEGACY_SEED_FILES)
            with tempfile.NamedTemporaryFile(dir=settings.directory, mode="w") as pending:
                json.dump(asdict(config), pending)
                pending.flush()
                if previous is None:
                    os.link(pending.name, settings.catalog_config)
                else:
                    history = settings.directory / "catalog-history"
                    history.mkdir(mode=0o700, exist_ok=True)
                    archived = history / (sha256(previous).hexdigest() + ".json")
                    if not archived.exists():
                        os.link(settings.catalog_config, archived)
                    # Keep the temporary filename for its context manager to remove.
                    replacement = history / (pending.name.rsplit("/", 1)[-1] + ".pending")
                    os.link(pending.name, replacement)
                    try:
                        os.replace(replacement, settings.catalog_config)
                    finally:
                        replacement.unlink(missing_ok=True)
            return cls(settings, config)

    def prepare_checkout(self) -> None:
        self.checkout.mkdir(parents=True, exist_ok=True)
        if not any(self.checkout.iterdir()):
            self.git("init", "--initial-branch", self.config.branch)
            self.git("remote", "add", "origin", self.config.remote)
        if not (self.checkout / ".git").is_dir():
            raise CatalogError("Choose an empty directory or a catalog Git checkout")
        if self.git("config", "--get", "remote.origin.url").strip() != self.config.remote:
            raise CatalogError("The checkout points to a different remote")
        if self.git("symbolic-ref", "--short", "HEAD").strip() != self.config.branch:
            raise CatalogError("The checkout is on a different branch")

    def fetch(self) -> str:
        if self.git("status", "--porcelain"):
            raise CatalogError("Catalog checkout has local changes")
        self.git("fetch", "origin", f"refs/heads/{self.config.branch}")
        return self.git("rev-parse", "FETCH_HEAD").strip()

    def pull(self) -> None:
        self.fetch()
        try:
            self.git("merge", "--ff-only", "FETCH_HEAD")
        except CatalogError:
            raise CatalogError(
                "Catalog history requires a merge. Local HEAD and FETCH_HEAD are preserved."
            ) from None

    def push(self) -> None:
        self.git("push", "origin", f"HEAD:refs/heads/{self.config.branch}")

    def remote_revision(self) -> str | None:
        branch = f"refs/heads/{self.config.branch}"
        for ref in self.git("ls-remote", "--heads", "origin", branch).splitlines():
            revision, name = ref.split()
            if name == branch:
                return revision
        return None

    def retain(self, skill: str, revision: str, *files: str) -> Path:
        target = self.settings.directory / "revisions" / revision / skill
        if target.is_dir():
            return target
        return self.retain_files(
            skill,
            revision,
            {name: self.git("show", f"{revision}:skills/{skill}/{name}") for name in files},
        )

    def retain_files(self, skill: str, revision: str, files: dict[str, str]) -> Path:
        target = self.settings.directory / "revisions" / revision / skill
        if target.is_dir():
            return target
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = Path(tempfile.mkdtemp(dir=target.parent))
        try:
            for filename, content in files.items():
                (temporary / filename).write_text(content)
            temporary.rename(target)
        finally:
            if temporary.is_dir():
                shutil.rmtree(temporary)
        return target
