import hashlib
import json
import os
import tempfile
from urllib.parse import urlsplit
from uuid import UUID, uuid4

from pydantic import Field, ValidationError, field_validator

from .config import Settings
from .skill_program import SkillId
from .state import State
from .tool_types import ToolArguments

DIGITALOCEAN_ORIGIN = "https://api.digitalocean.com"
DIGITALOCEAN_SCOPE = "domain:read"


class CredentialError(RuntimeError):
    """A credential request or its destination could not be authorized."""


class CredentialRequired(CredentialError):
    """The task is paused for its approved credential."""


def fingerprint(value: str) -> str:
    return "sha256:" + hashlib.sha256(value.encode()).hexdigest()[:10]


class Destination(ToolArguments):
    endpoint: str = Field(max_length=300)
    secret_ref: SkillId

    @field_validator("endpoint")
    @classmethod
    def loopback(cls, value: str) -> str:
        if value == DIGITALOCEAN_ORIGIN:
            return value
        address = urlsplit(value)
        if (
            address.scheme != "http"
            or address.hostname not in ("127.0.0.1", "::1")
            or address.port is None
            or address.username is not None
            or address.query
            or address.fragment
        ):
            raise ValueError("Use a loopback MCP URL or the supported DigitalOcean API origin")
        return value


class Credentials:
    def __init__(self, settings: Settings, state: State):
        self.settings = settings
        self.state = state

    def authorize(self, connector: str, destination: Destination) -> None:
        if destination.endpoint == DIGITALOCEAN_ORIGIN:
            with self.state.transaction() as db:
                row = db.execute(
                    "SELECT endpoint,secret_ref FROM connector_approvals WHERE connector=?",
                    (connector,),
                ).fetchone()
            if row and tuple(row) == (destination.endpoint, destination.secret_ref):
                return
            raise CredentialError("Approve the DigitalOcean connector destination first")
        try:
            bindings = json.loads((self.settings.directory / "connector-bindings.json").read_text())
            binding = Destination.model_validate(bindings.get(connector))
        except (OSError, ValueError, AttributeError):
            raise CredentialError("The owner must bind this connector to its destination") from None
        if binding != destination:
            raise CredentialError("Catalog destination differs from its owner-authorized binding")

    def require(
        self, task: str, connector: str, destination: Destination, *, replace: bool = False
    ) -> str | None:
        self.authorize(connector, destination)
        file = self.settings.directory / "secrets" / destination.secret_ref
        with self.state.transaction(write=True) as db:
            existing = db.execute(
                "SELECT * FROM credential_requests WHERE task=? AND connector=?", (task, connector)
            ).fetchone()
            if existing and (existing["endpoint"], existing["secret_ref"]) != (
                destination.endpoint,
                destination.secret_ref,
            ):
                raise CredentialError("This task already has a request for a different destination")
            if replace:
                if existing:
                    db.execute("DELETE FROM credential_requests WHERE id=?", (existing["id"],))
                existing = None
            if not replace and file.is_file() and (not existing or existing["supplied"]):
                return file.read_text()
            if not existing:
                request_id = str(uuid4())
                db.execute(
                    "INSERT INTO credential_requests(id,task,connector,endpoint,secret_ref) VALUES (?,?,?,?,?)",
                    (request_id, task, connector, destination.endpoint, destination.secret_ref),
                )
                evidence = {
                    "action": "credential_requested",
                    "request": request_id,
                    "connector": connector,
                    "destination": destination.endpoint,
                }
                if destination.endpoint == DIGITALOCEAN_ORIGIN:
                    evidence["scope"] = DIGITALOCEAN_SCOPE
                    evidence["label"] = "DigitalOcean API token"
                reason = (
                    "DigitalOcean rejected the token. Supply a token with domain:read."
                    if replace
                    else f"Provide a credential for {connector}."
                )
                self.state.append(db, task, "waiting", reason, evidence)
            return None

    def supply(self, request_id: UUID, value: str) -> None:
        if not 1 <= len(value) <= 4096 or any(not 32 <= ord(char) <= 126 for char in value):
            raise CredentialError("Enter a valid printable bearer token")
        with self.state.transaction(write=True) as db:
            row = db.execute(
                "SELECT * FROM credential_requests WHERE id=?", (str(request_id),)
            ).fetchone()
            if not row:
                raise CredentialError("Credential request is unknown")
            try:
                destination = Destination(endpoint=row["endpoint"], secret_ref=row["secret_ref"])
            except ValidationError:
                raise CredentialError("Stored credential destination is invalid") from None
            self.authorize(row["connector"], destination)
            directory = self.settings.directory / "secrets"
            target = directory / destination.secret_ref
            if row["supplied"]:
                if target.is_file() and target.read_text() == value:
                    return
                raise CredentialError("Credential request already supplied")
            if (
                db.execute("SELECT checkpoint FROM tasks WHERE id=?", (row["task"],)).fetchone()[0]
                == "completed"
            ):
                raise CredentialError("Credential request task has ended")
            directory.mkdir(mode=0o700, exist_ok=True)
            with tempfile.NamedTemporaryFile(dir=directory, mode="w", delete=False) as temporary:
                try:
                    temporary.write(value)
                    temporary.flush()
                    os.fsync(temporary.fileno())
                    os.replace(temporary.name, target)
                finally:
                    if os.path.exists(temporary.name):
                        os.unlink(temporary.name)
            db.execute("UPDATE credential_requests SET supplied=1 WHERE id=?", (str(request_id),))
            self.state.append(
                db,
                row["task"],
                "evidence",
                "Credential accepted. The task can resume.",
                {
                    "action": "credential_supplied",
                    "request": str(request_id),
                    "fingerprint": fingerprint(value),
                },
            )
