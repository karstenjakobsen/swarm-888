from typing import Annotated, Literal
from uuid import UUID

from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    JsonValue,
    SecretStr,
    StringConstraints,
    computed_field,
)

Text = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2000)]
Kind = Literal[
    "received",
    "owner_message",
    "started",
    "answered",
    "completed",
    "evidence",
    "failed",
    "verified",
    "unknown",
    "waiting",
    "system",
    "stopped",
]


class ApiError(BaseModel):
    detail: str


class OwnerLogin(BaseModel):
    model_config = ConfigDict(extra="forbid")
    key: SecretStr


class OwnerMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["message"]
    text: Text
    request_id: UUID = Field(alias="requestId")


class DockerStart(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: UUID = Field(alias="requestId")
    target: Annotated[str, StringConstraints(pattern=r"^[a-f0-9]{64}$")]
    skill: Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9-]{0,47}$")]


class OwnerSteer(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["steer"]
    request_id: UUID = Field(alias="requestId")
    text: Text


class OwnerStop(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["stop"]
    request_id: UUID = Field(alias="requestId")


class SupplyCredential(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: UUID = Field(alias="requestId")
    value: SecretStr


class Receipt(BaseModel):
    task_id: str = Field(serialization_alias="taskId")


class Profile(BaseModel):
    id: str
    name: str
    purpose: str
    instructions: str


class Outcome(BaseModel):
    key: Literal["working", "unverified", "failed", "verified", "unknown", "needs-you", "stopped"]
    label: str
    seq: int
    why: str


class Event(BaseModel):
    seq: int
    at: str
    task: str
    kind: Kind
    text: str
    data: dict[str, JsonValue] = Field(default_factory=dict)

    @computed_field
    @property
    def outcome(self) -> Outcome:
        if self.kind in ("received", "owner_message"):
            label = "Working" if self.data.get("intent") == "steer" else "Queued"
            return Outcome(key="working", label=label, seq=self.seq, why=self.text)
        if self.kind in ("started", "evidence", "system"):
            return Outcome(key="working", label="Working", seq=self.seq, why=self.text)
        if self.kind == "failed":
            return Outcome(key="failed", label="Failed", seq=self.seq, why=self.text)
        if self.kind == "verified":
            return Outcome(
                key="verified", label="Verified independently", seq=self.seq, why=self.text
            )
        if self.kind == "unknown":
            return Outcome(key="unknown", label="Outcome unknown", seq=self.seq, why=self.text)
        if self.kind == "waiting":
            return Outcome(key="needs-you", label="Needs a credential", seq=self.seq, why=self.text)
        if self.kind == "stopped":
            return Outcome(key="stopped", label="Stopped", seq=self.seq, why=self.text)
        label = "Answered, awaiting verification" if self.data.get("modeled") else "Acknowledged"
        return Outcome(key="unverified", label=label, seq=self.seq, why=self.text)


class TaskState(BaseModel):
    id: str
    checkpoint: Literal["queued", "running", "completed"]
    outcome: Outcome


class CatalogInfo(BaseModel):
    remote: str
    branch: str


class CatalogConnection(BaseModel):
    model_config = ConfigDict(extra="forbid")
    remote: Annotated[
        str,
        StringConstraints(
            strip_whitespace=True,
            max_length=255,
            pattern=r"^git@github\.com:[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9_.-]+\.git$",
        ),
    ]
    branch: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=255)
    ] = "main"
    deploy_key: bool = False
    seed_if_empty: bool = False


class CatalogSync(BaseModel):
    remote_revision: str | None = None
    read_error: str | None = None
    published_revision: str | None = None
    publish_error: str | None = None


class CatalogStatus(CatalogSync):
    catalog: CatalogInfo | None = None
    local_revision: str | None = None
    authoring_revision: str | None = None
    public_key: str | None = None


class Snapshot(BaseModel):
    profile: Profile
    cursor: int = Field(ge=0)
    tasks: list[TaskState]
    events: list[Event]
    catalog: CatalogInfo | None = None


class WorkerReport(BaseModel):
    host: str
    pid: int = Field(gt=0)
    mode: Literal["acknowledge", "codex", "simulated"]
    uid: int = Field(ge=0)
    gid: int = Field(ge=0)
    started_at: AwareDatetime
    last_heartbeat: AwareDatetime
    revision: str | None
    active_task: str | None


class WorkerStatus(BaseModel):
    health: Literal["online", "stale", "unreported"]
    queued_tasks: int = Field(ge=0)
    report: WorkerReport | None
