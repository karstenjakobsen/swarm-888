from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, SecretStr, StringConstraints, computed_field

Text = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2000)]
Kind = Literal["received", "owner_message", "started", "answered", "completed"]


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


class Receipt(BaseModel):
    task_id: str = Field(serialization_alias="taskId")


class Profile(BaseModel):
    id: str
    name: str
    purpose: str
    instructions: str


class Outcome(BaseModel):
    key: Literal["working", "unverified"]
    label: str
    seq: int
    why: str


class Event(BaseModel):
    seq: int
    at: str
    task: str
    kind: Kind
    text: str

    @computed_field
    @property
    def outcome(self) -> Outcome:
        if self.kind in ("received", "owner_message"):
            return Outcome(key="working", label="Queued", seq=self.seq, why=self.text)
        if self.kind == "started":
            return Outcome(key="working", label="Working", seq=self.seq, why=self.text)
        return Outcome(key="unverified", label="Acknowledged", seq=self.seq, why=self.text)


class TaskState(BaseModel):
    id: str
    checkpoint: Literal["queued", "running", "completed"]
    outcome: Outcome


class Snapshot(BaseModel):
    profile: Profile
    cursor: int = Field(ge=0)
    tasks: list[TaskState]
    events: list[Event]
