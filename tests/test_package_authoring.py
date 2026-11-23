import asyncio
import json
from uuid import UUID, uuid4

import httpx
import pytest
from fixture_typed_catalog import PUBLISHER, typed_remote

from operator_v1.admin import HostCall, HostOperation, handle
from operator_v1.config import Settings
from operator_v1.connectors import ConnectorInvoke, ConnectorService
from operator_v1.credentials import CredentialError, CredentialRequired, Credentials
from operator_v1.model import connect_skills
from operator_v1.packages import SaveConnector, save_package
from operator_v1.skill_program import SkillError
from operator_v1.state import State
from operator_v1.task_objectives import work_events
from operator_v1.typed_catalogs import TypedCatalogs
from operator_v1.worker import MessageWorker


def connector_definition():
    body = {"name": "fixture"}
    response = {"item": {"id": 7, **body}}
    return {
        "name": "Fixture API",
        "auth": "bearer",
        "endpoint": "https://fixture.invalid",
        "secret_ref": "fixture",
        "tool": "create_item",
        "operations": {
            "create_item": {
                "description": "Create and verify an item",
                "scope": "items:create",
                "method": "POST",
                "path": "/items",
                "body_fields": ["name"],
                "input_schema": {
                    "type": "object",
                    "properties": {"name": {"type": "string"}},
                    "required": ["name"],
                    "additionalProperties": False,
                },
                "result_field": "item",
                "verify": {"path": "/items/{result_id}", "result_field": "item", "id_field": "id"},
                "tests": [
                    {
                        "name": "creation",
                        "arguments": body,
                        "expected": response["item"],
                        "exchanges": [
                            {
                                "method": "POST",
                                "path": "/items",
                                "body": body,
                                "response": response,
                            },
                            {"method": "GET", "path": "/items/7", "response": response},
                        ],
                    }
                ],
            }
        },
    }


def objective(state, task, kind):
    with state.transaction(write=True) as db:
        state.append(
            db,
            task,
            "system",
            "Goal",
            {
                "action": "task_objectives",
                "plan": {"objectives": [{"requirement": kind, "deliverable": "fixture item"}]},
            },
        )


def test_package_tools_commit_test_and_verify_after_restart(tmp_path, monkeypatch):
    settings = Settings(tmp_path / "state")
    state = State(settings)
    remote, _ = typed_remote(tmp_path / "repo")
    catalogs = TypedCatalogs(state)
    catalogs.connect(str(remote), "main", ["connector", "project"], publisher=PUBLISHER)
    task = state.submit(uuid4(), "Extend the fixture connector.")
    state.claim()
    objective(state, task, "connector")
    cid = PUBLISHER + "-connector-digital-ocean"
    pid = PUBLISHER + "-project-proof"

    async def author():
        async with connect_skills(settings, task) as mcp:
            read = await mcp.call_tool("connector_instructions", {"connector": cid})
            revision = read.structuredContent["revision"]
            draft = {
                "package": cid,
                "base_revision": revision,
                "definition": connector_definition(),
            }
            saved = await mcp.call_tool("connector_save", draft)
            assert not saved.isError, saved.content
            assert saved.structuredContent["tests"] == ["create_item: creation"]
            assert (await mcp.call_tool("connector_save", draft)).isError
            project = await mcp.call_tool(
                "project_save",
                {
                    "package": "proof",
                    "definition": {
                        "name": "Proof",
                        "description": "Fixture project",
                        "repo": "https://example.invalid/proof",
                        "connectors": [cid],
                    },
                },
            )
            assert project.structuredContent["project"] == pid
            assert (await mcp.call_tool("project_read", {"project": pid})).structuredContent[
                "connectors"
            ] == [cid]

    asyncio.run(author())
    call = ConnectorInvoke(connector=cid, operation="create_item", arguments={"name": "fixture"})
    with pytest.raises(SkillError, match="no requested live change"):
        ConnectorService(None, state, task).read(call, operation=call.operation)
    broken = connector_definition()
    broken["operations"]["create_item"]["tests"][0]["expected"] = {}
    binding = catalogs.for_kind("connector")
    with pytest.raises(CredentialError, match="Fixture"):
        save_package(
            state,
            task,
            SaveConnector(package=cid, base_revision=binding.revision, definition=broken),
        )
    assert catalogs.for_kind("connector").revision == binding.revision
    later = state.submit(uuid4(), "Create a fixture item.")
    objective(state, later, "change")

    def invoke():
        return ConnectorService(None, MessageWorker(settings).state, later).read(
            call, operation=call.operation
        )

    with pytest.raises(CredentialRequired):
        invoke()
    req = work_events(state, later)[-1]["data"]["request"]
    token = "fixture-bearer"
    Credentials(settings, state).supply(UUID(req), token)
    actual = []

    def respond(request):
        assert request.headers["Authorization"] == "Bearer " + token
        actual.append(request.method)
        if len(actual) == 2:
            return httpx.Response(503)
        return httpx.Response(200, json={"item": {"id": 7, "name": "fixture"}})

    client = httpx.Client
    monkeypatch.setattr(
        httpx,
        "Client",
        lambda **kw: (
            client(**{**kw, "transport": httpx.MockTransport(respond)})
            if "transport" not in kw
            else client(**kw)
        ),
    )
    with pytest.raises(CredentialError, match="failed"):
        invoke()
    for _ in range(2):
        assert invoke()["result"] == {"id": 7, "name": "fixture"}
    assert actual == ["POST", "GET", "GET"]
    assert token not in str(work_events(state, later))


def test_unfulfilled_package_goal_cannot_complete(tmp_path, monkeypatch):
    monkeypatch.setenv("OPERATOR_MODEL", "codex")
    worker = MessageWorker(Settings(tmp_path))
    state = worker.state
    task = state.submit(uuid4(), "Extend the connector to create records")
    objective(state, task, "connector")

    async def answer(*args):
        return '{"status":"answered","text":"It only supports reads."}'

    monkeypatch.setattr(worker, "answer", answer)
    for _ in range(2):
        assert state.claim() == task
        asyncio.run(worker.run_task(task))
    assert state.claim() is None
    assert state.snapshot().tasks[0].checkpoint == "running"
    assert state.snapshot().tasks[0].outcome.key == "needs-you"


def test_delegated_host_command_and_verification(tmp_path):
    target = tmp_path / "value"
    target.write_text("old")
    op = HostOperation.model_validate(
        {
            "description": "Set fixture mode",
            "access": "write",
            "command": {
                "executable": "/usr/bin/chmod",
                "commands": [{"prefix": ["600", str(target)]}],
            },
            "observe": ["/usr/bin/stat", "-c", "%a", str(target)],
            "expected": "600",
        }
    )

    def invoke(argv):
        entry = handle({"list": True}, {"set-mode": op})["set-mode"]
        call = HostCall(operation="set-mode", argv=argv)
        return handle({**call.model_dump(), "revision": entry["revision"]}, {"set-mode": op})

    assert invoke(["600", str(target)])["observed"] == "600"
    with pytest.raises(SkillError, match="outside"):
        invoke(["700", str(target)])
    op.expected = "700"
    with pytest.raises(SkillError, match="did not confirm"):
        invoke(["600", str(target)])


def test_verified_completion_requires_the_current_revision(tmp_path, monkeypatch):
    from contextlib import asynccontextmanager

    from operator_v1.task_objectives import missing_evidence

    settings = Settings(tmp_path / "state")
    state = State(settings)
    remote, _ = typed_remote(tmp_path / "repo")
    catalogs = TypedCatalogs(state)
    catalogs.connect(str(remote), "main", ["connector"], publisher=PUBLISHER)
    task = state.submit(uuid4(), "Create an item connector")
    assert state.claim() == task
    objective(state, task, "connector")
    saved = save_package(
        state, task, SaveConnector(package="items", definition=connector_definition())
    )
    seq = work_events(state, task)[-1]["seq"]

    @asynccontextmanager
    async def assessment(*args, **kwargs):
        class Review:
            async def start(self, prompt):
                assert "fixture item" in prompt and "POST" in prompt
                return None

            async def result(self, turn):
                return json.dumps({"evidence": [[seq]], "remaining": ""})

        yield Review()

    monkeypatch.setattr("operator_v1.model.codex_session", assessment)
    assert asyncio.run(missing_evidence(state, task)) is None
    state.finish(task, "Added the operation", "Finished", modeled=True)
    assert state.snapshot().tasks[0].outcome.label == "Verified"
    assert work_events(state, task)[-1]["data"]["proof"][0]["events"] == [seq]
    # A later revision must not validate an old task's proposed completion.
    changed = connector_definition()
    changed["instructions"] = "Revised by another task"
    later = state.submit(uuid4(), "Revise instructions")
    save_package(
        state,
        later,
        SaveConnector(
            package=saved["connector"], base_revision=saved["revision"], definition=changed
        ),
    )
    assert "Missing verified evidence" in asyncio.run(missing_evidence(state, task))
