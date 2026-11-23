"""Socket-activated host operations delegated by the machine administrator."""

import hashlib
import json
import socket
import sys
from pathlib import Path
from typing import Literal

from pydantic import Field, TypeAdapter

from .executor import CommandRule, Dependency, run_command
from .skill_program import SkillError, SkillId
from .tool_types import ToolArguments

SOCKET = "/run/swarm-operator-admin.sock"
POLICY = Path("/etc/swarm-operator/admin-operations.json")
LIMIT = 1024 * 1024 + 4096


class HostCall(ToolArguments):
    operation: SkillId
    argv: list[str] = Field(default_factory=list, max_length=128)


class HostOperation(ToolArguments):
    description: str = Field(min_length=1)
    command: Dependency
    access: Literal["read", "write"]
    # For writes, the owner supplies a fixed independent state check.
    observe: list[str] = Field(default_factory=list)
    expected: str | None = None


def handle(request: dict, operations: dict[str, HostOperation]):
    if request == {"list": True}:
        return {
            name: {
                "revision": hashlib.sha256(op.model_dump_json().encode()).hexdigest(),
                "description": op.description,
                "access": op.access,
                "arguments": [rule.model_dump() for rule in op.command.commands],
            }
            for name, op in operations.items()
        }
    expected_revision = request.get("revision")
    call = HostCall.model_validate(
        {key: value for key, value in request.items() if key != "revision"}
    )
    op = operations.get(call.operation)
    if op is None:
        raise SkillError("Host operation has not been delegated")
    if expected_revision != hashlib.sha256(op.model_dump_json().encode()).hexdigest():
        raise SkillError("The delegated host operation changed. Inspect its current definition.")
    if op.access == "write" and (
        len(op.observe) < 2 or op.expected is None or not Path(op.observe[0]).is_absolute()
    ):
        raise SkillError("Delegated host writes require an observation command and expected result")
    output = run_command(op.command, call.argv)
    if op.access == "write":
        argv = op.observe[1:]
        check = Dependency(executable=Path(op.observe[0]), commands=[CommandRule(prefix=argv)])
        observed = run_command(check, argv).strip()
        if observed != op.expected:
            raise SkillError("Host observation did not confirm the requested change")
        return {"output": output, "observed": observed, "verified_write": True}
    return {"output": output, "verified_write": False}


def broker(request: dict):
    try:
        with socket.socket(socket.AF_UNIX) as sock:
            sock.settimeout(22)
            sock.connect(SOCKET)
            sock.sendall(json.dumps(request).encode() + b"\n")
            with sock.makefile("rb") as response:
                result = json.loads(response.readline(LIMIT))
    except FileNotFoundError:
        if request == {"list": True}:
            return {}
        raise SkillError("Host administration service is unavailable") from None
    except (OSError, ValueError):
        raise SkillError("Host administration service did not return a result") from None
    if "error" in result:
        raise SkillError(result["error"])
    return result["result"]


def main():
    try:
        operations = (
            TypeAdapter(dict[SkillId, HostOperation]).validate_json(POLICY.read_bytes())
            if POLICY.exists()
            else {}
        )
        request = json.loads(sys.stdin.buffer.readline(65536))
        result = {"result": handle(request, operations)}
    except SkillError as error:
        result = {"error": str(error)}
    except (ValueError, OSError, TypeError):
        result = {"error": "Invalid host operation or administration policy"}
    print(json.dumps(result))


def invoke_host(state, task: str | None, call: HostCall):
    from .effects import Dispatch
    from .task_objectives import allow_write

    if not task:
        raise SkillError("Run host operations from an owner task")
    entry = broker({"list": True}).get(call.operation)
    if not entry:
        raise SkillError("Host operation has not been delegated")
    if not any(CommandRule.model_validate(rule).accepts(call.argv) for rule in entry["arguments"]):
        raise SkillError("Arguments are outside the delegated host operation")
    dispatch = None
    if entry["access"] == "write":
        allow_write(state, task)
        dispatch = Dispatch(state, task, ["host", entry["revision"], call.operation, call.argv])
        saved = dispatch.saved()
        if saved:
            return saved["result"]
        dispatch.reserve()
    result = broker({**call.model_dump(), "revision": entry["revision"]})
    with state.transaction(write=True) as db:
        if dispatch:
            dispatch.finish(db, result)
        state.append(
            db,
            task,
            "evidence",
            f"Ran delegated host operation {call.operation}.",
            {"action": "host_executed", **call.model_dump(), **result},
        )
    return result


if __name__ == "__main__":
    main()
