import asyncio
from uuid import uuid4

import httpx
from fixture_typed_catalog import PUBLISHER, typed_remote
from test_message import controller, headers, login

from operator_v1.catalog import run_git
from operator_v1.config import Settings
from operator_v1.digitalocean import TokenRejected, list_dns_records
from operator_v1.model import connect_skills
from operator_v1.state import State
from operator_v1.typed_catalogs import TypedCatalogs
from operator_v1.worker import MessageWorker


def test_digitalocean_read_keeps_the_origin_when_paginating():
    pages = []

    def respond(request):
        assert str(request.url.copy_with(query=None)) == (
            "https://api.digitalocean.com/v2/domains/example.com/records"
        )
        page = int(request.url.params["page"])
        pages.append(page)
        return httpx.Response(
            200,
            json={
                "domain_records": [{"id": page}],
                "links": {"pages": {"next": "https://elsewhere.invalid/"}} if page == 1 else {},
            },
        )

    async def read():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as http:
            return await list_dns_records(http, {"zone": "example.com"})

    assert asyncio.run(read()) == [{"id": 1}, {"id": 2}]
    assert pages == [1, 2]


def test_dns_goal_approval_credential_and_verified_read_resume_same_task(tmp_path, monkeypatch):
    settings = Settings(tmp_path / "state")
    settings.create_owner_key()
    state = State(settings)
    remote, original_revision = typed_remote(tmp_path / "fixture")
    catalogs = TypedCatalogs(state)
    catalogs.connect(str(remote), "main", ["connector"], publisher=PUBLISHER)
    monkeypatch.setenv("OPERATOR_MODEL", "simulated")
    token = "fixture-token-" + uuid4().hex
    rejected = "fixture-rejected-token"
    zones = []

    async def adapter(http, arguments):
        if http.headers["Authorization"] == f"Bearer {rejected}":
            raise TokenRejected("Rejected")
        assert http.headers["Authorization"] == f"Bearer {token}"
        zones.append(arguments["zone"])
        return [{"name": "@", "type": "A", "data": "192.0.2.1"}]

    monkeypatch.setattr("operator_v1.connectors.list_dns_records", adapter)
    worker = MessageWorker(settings)
    action = headers(settings)
    with controller(settings) as client:
        login(client, settings)

        def submit():
            response = client.post(
                "/api/commands",
                headers=action,
                json={
                    "kind": "message",
                    "text": "List DNS records for example.com using DigitalOcean.",
                    "requestId": str(uuid4()),
                },
            )
            assert response.status_code == 202
            return response.json()["taskId"]

        def events(task):
            return [event for event in state.snapshot().events if event.task == task]

        task = submit()
        asyncio.run(worker.drain())
        first = events(task)
        assert first[-1].outcome.label == "Needs approval"
        assert first[-1].data["scope"] == "domain:read"
        assert (
            len([event for event in first if event.data.get("action") == "dns_task_objective"]) == 1
        )
        assert not zones
        asyncio.run(worker.drain())
        assert events(task) == first

        binding = catalogs.for_kind("connector")
        created = next(
            item
            for item in binding.snapshot("connector").items
            if item.manifest.canonical_id.endswith("-connector-digitalocean-dns")
        )
        path = binding.catalog.checkout / created.path
        original = path.read_bytes()
        path.write_text("instructions: uncommitted change\n")

        async def read_instructions():
            async with connect_skills(settings, task) as mcp:
                found = await mcp.call_tool("connector_discover", {"query": "DigitalOcean DNS"})
                assert found.structuredContent["connectors"] == [
                    {
                        "connector": created.manifest.canonical_id,
                        "name": "DigitalOcean DNS",
                        "tool": "list_dns_records",
                        "has_instructions": True,
                    }
                ]
                return await mcp.call_tool(
                    "connector_instructions", {"connector": created.manifest.canonical_id}
                )

        try:
            instructions = asyncio.run(read_instructions()).structuredContent
        finally:
            path.write_bytes(original)
        assert instructions["instructions"] == created.manifest.instructions
        assert '"zone": "example.com"' in instructions["instructions"]
        assert instructions["revision"] == binding.revision
        assert instructions["catalog"]["path"] == created.path
        assert "secret_ref" not in instructions
        assert "secret" not in instructions
        assert all(event.data.get("action") != "credential_requested" for event in events(task))

        approve = f"/api/tasks/{task}/approve-dns"
        assert client.post(approve).status_code == 403
        assert client.post(approve, headers=action).status_code == 204
        assert client.post(approve, headers=action).status_code == 204
        asyncio.run(worker.drain())
        waiting = events(task)[-1]
        assert waiting.data["action"] == "credential_requested"
        assert waiting.data["scope"] == "domain:read"
        assert (
            client.post(
                "/api/secrets",
                headers=action,
                json={"requestId": waiting.data["request"], "value": rejected},
            ).status_code
            == 204
        )
        asyncio.run(worker.drain())
        replacement = events(task)[-1]
        assert replacement.data["action"] == "credential_requested"
        assert replacement.data["request"] != waiting.data["request"]
        assert (
            client.post(
                "/api/secrets",
                headers=action,
                json={"requestId": replacement.data["request"], "value": token},
            ).status_code
            == 204
        )
        asyncio.run(MessageWorker(settings).drain())
        assert next(t for t in state.snapshot().tasks if t.id == task).outcome.key == "verified"
        assert any(event.data.get("action") == "connector_used" for event in events(task))
        assert not any(event.data.get("action") == "dns_goal" for event in events(task))
        assert token not in client.get("/api/snapshot").text

        again = submit()
        asyncio.run(worker.drain())
        assert next(t for t in state.snapshot().tasks if t.id == again).outcome.key == "verified"
        assert zones == ["example.com", "example.com"]
        assert all(event.kind != "waiting" for event in events(again))
    assert run_git("rev-parse", "main", cwd=remote).stdout.strip() == original_revision
    assert not (binding.catalog.checkout / "list-digitalocean-dns-records").exists()
