import fcntl
import os
import secrets
import stat
import tempfile
from collections.abc import Generator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Self


@dataclass(frozen=True)
class Settings:
    directory: Path
    origin: str = "http://127.0.0.1:8080"

    name: str = "Private operator"
    purpose: str = "Assist the owner on this host."
    instructions: str = ""

    @classmethod
    def load(cls) -> Self:
        default = Path.home() / ".local/state/vps-operator"
        path = Path(os.environ.get("OPERATOR_STATE_DIR", default)).expanduser().resolve()
        if path.is_relative_to(Path(__file__).resolve().parents[1]):
            raise ValueError("OPERATOR_STATE_DIR must be outside the source checkout")
        return cls(
            path,
            os.environ.get("OPERATOR_ORIGIN", cls.origin),
            os.environ.get("OPERATOR_NAME", cls.name),
            os.environ.get("OPERATOR_PURPOSE", cls.purpose),
            os.environ.get("OPERATOR_INSTRUCTIONS", cls.instructions),
        )

    def prepare(self) -> None:
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        if self.directory.stat().st_mode & 0o077:
            raise PermissionError("Choose a private state directory with mode 0700")

    @property
    def socket(self) -> Path:
        return self.directory / "worker.sock"

    @property
    def owner_key(self) -> Path:
        return self.directory / "owner.key"

    @property
    def catalog_config(self) -> Path:
        return self.directory / "catalog.json"

    @contextmanager
    def service_lock(self, service: str) -> Generator[None, None, None]:
        self.prepare()
        fd = os.open(
            self.directory / f"{service}.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600
        )
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if os.geteuid() == 0:
                owner = self.directory.stat()
                os.fchown(fd, owner.st_uid, owner.st_gid)
            yield
        finally:
            os.close(fd)

    @contextmanager
    def database_identity(self) -> Generator[None, None, None]:
        # The explicit root fixture worker is single-threaded. Create SQLite
        # journals as the state owner so the ordinary controller can recover them.
        if os.geteuid() or os.environ.get("OPERATOR_ALLOW_ROOT_WORKER") != "1":
            yield
            return
        owner = self.directory.stat()
        if not owner.st_uid:
            yield
            return
        group = os.getegid()
        os.setegid(owner.st_gid)
        try:
            os.seteuid(owner.st_uid)
            try:
                yield
            finally:
                os.seteuid(0)
        finally:
            os.setegid(group)

    def read_owner_key(self) -> bytes:
        self.prepare()
        try:
            fd = os.open(self.owner_key, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except FileNotFoundError as exc:
            raise RuntimeError("Initialize a private owner key with make owner-key") from exc
        with os.fdopen(fd, "rb") as source:
            mode = os.fstat(source.fileno()).st_mode
            if not stat.S_ISREG(mode) or mode & 0o077:
                raise PermissionError("The owner key must be a private regular file")
            key = source.read().strip()
        if len(key) < 32:
            raise ValueError("The owner key must be at least 32 bytes")
        return key

    def create_owner_key(self) -> None:
        self.prepare()
        # Publish a complete 0600 key without replacing a concurrent initializer.
        with tempfile.NamedTemporaryFile(dir=self.directory) as candidate:
            candidate.write(secrets.token_urlsafe(32).encode() + b"\n")
            candidate.flush()
            os.link(candidate.name, self.owner_key)


if __name__ == "__main__":
    settings = Settings.load()
    try:
        settings.create_owner_key()
    except FileExistsError:
        settings.read_owner_key()
    print(f"Owner key file: {settings.owner_key}")
