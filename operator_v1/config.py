import os
import secrets
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    directory: Path
    origin: str = "http://127.0.0.1:8080"

    name: str = "Private operator"
    purpose: str = "Assist the owner on this host."
    instructions: str = ""

    @classmethod
    def load(cls):
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

    def prepare(self):
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        if self.directory.stat().st_mode & 0o077:
            raise PermissionError("Choose a private state directory with mode 0700")

    @property
    def socket(self):
        return self.directory / "worker.sock"

    @property
    def owner_key(self):
        return self.directory / "owner.key"

    def create_owner_key(self):
        self.prepare()
        # A concurrent initializer must never replace the owner's key.
        fd = os.open(self.owner_key, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "w") as target:
            target.write(secrets.token_urlsafe(32) + "\n")


if __name__ == "__main__":
    settings = Settings.load()
    try:
        settings.create_owner_key()
    except FileExistsError:
        pass
    print(f"Owner key file: {settings.owner_key}")
