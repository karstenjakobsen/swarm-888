import shutil
from uuid import uuid4

import pytest
from test_message import controller, headers, login, process, wait_until
from test_skills import bootstrap

from operator_v1.executor import Dependency, execute
from operator_v1.skill_program import ExecutableProgram, ExecutableTest, SkillError


def test_executable_uses_only_declared_and_authorized_commands():
    program = ExecutableProgram(
        source="executable",
        entrypoint="run.lua",
        dependencies=["sample"],
        input_schema={"type": "object"},
    )
    code = """
    assert(io == nil and os == nil and require == nil and python == nil)
    return function(args) return {run("sample", args.value)} end
    """
    policy = {
        "sample": Dependency.model_validate(
            {
                "executable": shutil.which("printf"),
                "commands": [{"prefix": ["allowed"]}],
            }
        )
    }
    assert execute(program, code, {"value": "allowed"}, policy=policy) == ["allowed"]
    with pytest.raises(SkillError, match="outside the owner-authorized"):
        execute(program, code, {"value": "denied"}, policy=policy)
    with pytest.raises(SkillError, match="is not configured"):
        execute(program, code, {"value": "allowed"}, policy={})

    test = ExecutableTest.model_validate(
        {
            "name": "offline",
            "arguments": {"value": "allowed"},
            "commands": [{"dependency": "sample", "argv": ["allowed"], "stdout": "stub"}],
            "expected": ["stub"],
        }
    )
    assert execute(program, code, test.arguments, policy={}, test=test) == test.expected


def test_live_core_processes_handle_memory_without_platform_commands(tmp_path, monkeypatch):
    settings, env = bootstrap(tmp_path)
    settings.create_owner_key()
    empty_path = tmp_path / "empty-path"
    empty_path.mkdir()
    monkeypatch.setenv("PATH", str(empty_path))
    assert shutil.which("docker") is None and shutil.which("nomad") is None
    with (
        controller(settings) as client,
        process(
            ["operator_v1.worker"],
            {**env, "PATH": str(empty_path), "OPERATOR_MODEL": "simulated"},
        ),
    ):
        login(client, settings)
        response = client.post(
            "/api/commands",
            headers=headers(settings),
            json={
                "kind": "message",
                "text": "Remember fixture port: The fixture listens on port 8080.",
                "requestId": str(uuid4()),
            },
        )
        assert response.status_code == 202
        wait_until(
            lambda: client.get("/api/snapshot").json()["tasks"][0]["checkpoint"] == "completed"
        )
        events = client.get("/api/snapshot").json()["events"]
        assert any(event["data"].get("action") == "memory_written" for event in events)
