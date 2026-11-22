import json
from contextlib import contextmanager

import httpx
import pytest
from conftest import NoRuntime, csrf_token
from fastapi.testclient import TestClient
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
from mcp.server.fastmcp import FastMCP
from test_dns import provider_server, serve_provider

from swarm.application import Application
from swarm.catalog import Package
from swarm.controller import controller, owner_key
from swarm.dns import Intent
from swarm.worker import service


@contextmanager
def monitoring_provider():
    calls = []
    server = FastMCP("monitoring-fixture", stateless_http=True, json_response=True)

    @server.tool(name="unit-report", structured_output=False)
    def report(service: str) -> str:
        calls.append(("read", service))
        if service != "orders":
            raise ValueError("Provider denied access to this service")
        return "orders.service failed\nworker.service active\ntrace synthetic-access-token"

    @server.tool(name="restart-unit")
    def restart(service: str) -> dict:
        calls.append(("denied", service))
        raise ValueError("Provider credential has read-only scope")

    with serve_provider(server) as endpoint:
        yield calls, endpoint


def configure_observation(catalog, tmp_path, monkeypatch, endpoint):
    definition = {"endpoint": endpoint, "authentication": "bearer", "secret": "monitoring-reader"}
    catalog.define("connectors", "monitoring", definition)
    doc = {
        "monitoring": {
            **definition,
            "observations": {"orders": {"tool": "unit-report", "arguments": {"service": "orders"}}},
        }
    }
    path = tmp_path / "owner-grants.json"
    path.write_text(json.dumps(doc))
    monkeypatch.setenv("SWARM_CONNECTOR_GRANTS", str(path))
    return path


def test_observe_credential_ui_and_skill_composition(app, tmp_path, monkeypatch, run):
    with monitoring_provider() as (calls, endpoint):
        configure_observation(app.catalog, tmp_path, monkeypatch, endpoint)
        task = app.submit(
            "/observe monitoring orders Count the provider's lines with the installed count-lines skill"
        )
        package = Package(**app.tools(task).skill_template())
        rev = app.catalog.stage("setup", package)["revision"]
        assert app.catalog.test("setup", rev)["passed"]
        app.catalog.activate("setup", rev)

        class Consumer(NoRuntime):
            async def run(self, application, row):
                tools = application.tools(row["id"])
                observed = tools.call("connector_result", {"owner_task": row["id"]})
                result = tools.call(
                    "skill_run", {"name": package.name, "arguments": observed["result"]}
                )
                assert result["revision"] == rev and result["result"] == {"lines": 3}
                return "completed"

        app.runtime = Consumer()
        run(app.step())
        assert app.task_summary(task)["status"] == "credential" and not calls
        api = controller(app.state.path, httpx.ASGITransport(app=service(app, schedule=False)))
        with TestClient(api, base_url="http://localhost") as client:
            client.post("/login", data={"key": owner_key(app.state.path)})
            page = client.get("/?task=" + task).text
            assert endpoint in page and 'type="password"' in page
            csrf = csrf_token(page)
            response = client.post(
                "/action/credential",
                data={"task": task, "csrf": csrf, "token": "synthetic-access-token"},
            )
            assert response.status_code == 200 and "synthetic-access-token" not in response.text
        run(app.step())
        assert app.task_summary(task)["status"] == "answered"
        observed = app.tools(task).connector_result(task)
        assert (
            observed["result"]["text"].endswith("trace [redacted]")
            and observed["tool"] == "unit-report"
        )
        fresh = Application(app.state, app.catalog, Consumer())
        fresh.recover()
        run(fresh.follow(task, "Use the saved observation again"))
        run(fresh.step())
        assert calls == [("read", "orders")]
        assert "synthetic-access-token" not in str(app.state.events()) + app.catalog.git(
            "log", "-p"
        )

        async def outside_operator():
            async with (
                httpx.AsyncClient(
                    headers={"Authorization": "Bearer synthetic-access-token"}, trust_env=False
                ) as http,
                streamable_http_client(endpoint, http_client=http) as (receive, send, _),
                ClientSession(receive, send) as session,
            ):
                await session.initialize()
                return await session.call_tool("restart-unit", {"service": "orders"})

        assert run(outside_operator()).isError and calls[-1] == ("denied", "orders")


def test_changed_grant_cannot_consume_a_waiting_credential(app, tmp_path, monkeypatch, run):
    with monitoring_provider() as (calls, endpoint):
        path = configure_observation(app.catalog, tmp_path, monkeypatch, endpoint)
        task = app.submit("/observe monitoring orders")
        run(app.step())
        doc = json.loads(path.read_text())
        doc["monitoring"]["observations"]["orders"]["arguments"]["service"] = "different"
        path.write_text(json.dumps(doc))
        with pytest.raises(ValueError, match="binding"):
            app.credential(task, "synthetic-access-token")
        assert not calls and not list((app.state.path / "secrets").iterdir())


def test_unreadable_provider_exhausts_observation_budget(app, tmp_path, monkeypatch, run, clock):
    with monitoring_provider() as (calls, endpoint):
        path = configure_observation(app.catalog, tmp_path, monkeypatch, endpoint)
        doc = json.loads(path.read_text())
        doc["monitoring"]["observations"]["orders"]["arguments"]["service"] = "unavailable"
        path.write_text(json.dumps(doc))
        task = app.submit("/observe monitoring orders")
        run(app.step())
        app.credential(task, "synthetic-access-token")
        for _ in range(8):
            run(app.step())
            clock.advance(5)
        assert app.task_summary(task)["status"] == "unknown"
        assert calls == [("read", "unavailable")] * 4


def test_missing_grants_file_only_blocks_tasks_using_the_provider(app, tmp_path, monkeypatch, run):
    monkeypatch.setenv("SWARM_CONNECTOR_GRANTS", str(tmp_path / "absent.json"))
    fresh = Application(app.state, app.catalog, app.runtime)
    local = fresh.submit("Summarize failed services\norders.service failed")
    run(fresh.step())
    assert fresh.task_summary(local)["status"] == "answered"
    dns = fresh.submit("/dns example.test orders 192.0.2.8")
    run(fresh.step())
    assert fresh.task_summary(dns)["status"] == "waiting"
    assert not fresh.state.rows("SELECT 1 FROM operations WHERE task=?", dns)


def test_dns_gateway_limits_and_recovery_pin(app, tmp_path, monkeypatch, run, clock):
    intent = Intent("example.test", "orders", "192.0.2.8")
    path = tmp_path / "owner-grants.json"
    monkeypatch.setenv("SWARM_CONNECTOR_GRANTS", str(path))

    def bind(endpoint):
        definition = {"endpoint": endpoint, "secret": "dns-gateway", "authentication": "bearer"}
        path.write_text(json.dumps({"digitalocean": definition}))
        app.catalog.define("connectors", "digitalocean", definition)
        return Application(app.state, app.catalog, app.runtime)

    with provider_server(intent) as (first, endpoint), provider_server(intent) as (second, changed):
        one = bind(endpoint)
        task = one.submit("/dns example.test orders 192.0.2.8")
        run(one.step())
        assert one.task_summary(task)["credential_destination"] == endpoint
        one.credential(task, "synthetic-access-token")
        run(one.step())
        assert first.records == [{"type": "A", "name": "orders", "data": intent.address}]

        async def outside_grant():
            async with (
                httpx.AsyncClient(
                    headers={"Authorization": "Bearer synthetic-access-token"}, trust_env=False
                ) as http,
                streamable_http_client(endpoint, http_client=http) as (receive, send, _),
                ClientSession(receive, send) as session,
            ):
                await session.initialize()
                return await session.call_tool(
                    "domain-record-create",
                    {
                        "Domain": intent.zone,
                        "Type": "A",
                        "Name": "unapproved",
                        "Data": intent.address,
                    },
                )

        assert (
            run(outside_grant()).isError
            and first.calls[-1] == ("denied", intent.zone)
            and len(first.records) == 1
        )
        two = bind(changed)
        second.records.extend(first.records)
        clock.advance(5)
        run(two.step())
        assert two.task_summary(task)["status"] == "waiting" and second.calls == []
        restored = bind(endpoint)
        run(restored.follow(task, "recheck"))
        run(restored.step())
        assert restored.task_summary(task)["status"] == "verified"
        assert first.calls.count(("create", intent.zone)) == 1
