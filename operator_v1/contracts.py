from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, SecretStr, StringConstraints

Text = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2000)]
Kind = Literal["received", "owner_message", "started", "answered", "completed"]


class OwnerLogin(BaseModel):
    model_config = ConfigDict(extra="forbid")
    key: SecretStr


class OwnerMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["message"]
    text: Text
    requestId: UUID


class Receipt(BaseModel):
    taskId: str


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
    outcome: Outcome


class TaskState(BaseModel):
    id: str
    checkpoint: Literal["queued", "running", "completed"]
    outcome: Outcome


class Snapshot(BaseModel):
    profile: Profile
    cursor: int = Field(ge=0)
    tasks: list[TaskState]
    events: list[Event]
