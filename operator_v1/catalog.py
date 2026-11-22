import fcntl
import json
import os
import shutil
import subprocess
import tempfile
from collections.abc import Generator
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from .config import Settings

SEED = Path(__file__).parent / "seed" / "v1"
AUTHORING_SKILL = "create-skill"


class CatalogError(RuntimeError):
    """A catalog operation could not finish safely."""


def run_git(*args: str, cwd: Path | None = None, check: bool = True) -> subprocess.CompletedProcess:
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
        text=True,
        check=check,
        timeout=30,
        env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
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


class Catalog:
    def __init__(self, settings: Settings, config: CatalogConfig):
        self.settings = settings
        self.config = config
        self.checkout = Path(config.checkout)

    @classmethod
    def load(cls, settings: Settings) -> "Catalog":
        return cls(settings, CatalogConfig(**json.loads(settings.catalog_config.read_text())))

    def git(self, *args: str) -> str:
        try:
            return run_git(*args, cwd=self.checkout).stdout
        except (OSError, subprocess.SubprocessError):
            # Git's diagnostics can include credentials embedded in the URL.
            raise CatalogError(f"Git {args[0]} failed for the configured catalog") from None

    @contextmanager
    def locked(self) -> Generator[None, None, None]:
        with (self.settings.directory / "catalog.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            yield

    @classmethod
    def initialize(cls, settings: Settings, remote: str, branch: str, checkout: Path) -> "Catalog":
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

        catalog = cls(settings, CatalogConfig(remote, branch, str(checkout), 1, ""))
        with catalog.locked():
            if settings.catalog_config.exists():
                existing = cls.load(settings)
                if (existing.config.remote, existing.config.branch, existing.checkout) != (
                    remote,
                    branch,
                    checkout,
                ):
                    raise CatalogError("This state directory is already bound to a catalog")
                return existing

            checkout.mkdir(parents=True, exist_ok=True)
            if not any(checkout.iterdir()):
                catalog.git("init", "--initial-branch", branch)
                catalog.git("remote", "add", "origin", remote)
            if not (checkout / ".git").is_dir():
                raise CatalogError("Choose an empty directory or a catalog Git checkout")
            if catalog.git("remote", "get-url", "origin").strip() != remote:
                raise CatalogError("The checkout points to a different remote")
            if catalog.git("symbolic-ref", "--short", "HEAD").strip() != branch:
                raise CatalogError("The checkout is on a different branch")

            refs = catalog.git("ls-remote", "--heads", "origin")
            branch_ref = f"refs/heads/{branch}"
            if any(line.split()[-1] == branch_ref for line in refs.splitlines()):
                catalog.pull()
            elif refs.strip():
                raise CatalogError("The requested branch is missing from the nonempty remote")
            elif not (checkout / "seed.json").is_file():
                if set(p.name for p in checkout.iterdir()) != {".git"}:
                    raise CatalogError("The empty remote requires a clean checkout")
                shutil.copytree(SEED / "skills", checkout / "skills")
                for folder in ("connectors", "projects"):
                    (checkout / folder).mkdir()
                    (checkout / folder / ".gitkeep").touch()
                (checkout / "seed.json").write_text('{"version": 1}\n')
                catalog.git("add", "--", "skills", "projects", "connectors", "seed.json")
                catalog.git("commit", "-m", "Seed the foundational authoring skill v1")
            seed_version = json.loads(catalog.git("show", "HEAD:seed.json"))["version"]
            seed_revision = catalog.git(
                "log", "--format=%H", "-n", "1", "--", "skills/create-skill"
            ).strip()
            if seed_version != 1 or not seed_revision:
                raise CatalogError("The catalog lacks a supported foundational seed")
            if not refs.strip():
                catalog.push()
            config = CatalogConfig(remote, branch, str(checkout), seed_version, seed_revision)
            catalog.retain(AUTHORING_SKILL, seed_revision, "SKILL.md", "template.json")
            with tempfile.NamedTemporaryFile(dir=settings.directory, mode="w") as pending:
                json.dump(asdict(config), pending)
                pending.flush()
                os.link(pending.name, settings.catalog_config)
            return cls(settings, config)

    def pull(self) -> None:
        if self.git("status", "--porcelain"):
            raise CatalogError("Catalog checkout has local changes")
        self.git("fetch", "origin", f"refs/heads/{self.config.branch}")
        try:
            self.git("merge", "--ff-only", "FETCH_HEAD")
        except CatalogError:
            raise CatalogError(
                "Catalog history requires a merge. Local HEAD and FETCH_HEAD are preserved."
            ) from None

    def push(self) -> None:
        self.git("push", "origin", f"HEAD:refs/heads/{self.config.branch}")

    def retain(self, skill: str, revision: str, *files: str) -> Path:
        target = self.settings.directory / "revisions" / revision / skill
        if target.is_dir():
            return target
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = Path(tempfile.mkdtemp(dir=target.parent))
        try:
            for filename in files:
                content = self.git("show", f"{revision}:skills/{skill}/{filename}")
                (temporary / filename).write_text(content)
            temporary.rename(target)
        finally:
            if temporary.is_dir():
                shutil.rmtree(temporary)
        return target
