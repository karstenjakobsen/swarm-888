import asyncio
import json
import multiprocessing
import socket
import threading
import time
from contextlib import contextmanager
from pathlib import Path

import pytest
import uvicorn
from conftest import Clock, NoRuntime
from mcp.server.fastmcp import FastMCP
from starlette.responses import Response

from swarm.application import Application
from swarm.catalog import Catalog
from swarm.dns import DNSProvider, Intent, RemoteMCP
from swarm.state import State


class Zone:
    def __init__(self):
        self.records = []
        self.calls = []
        self.unreadable = False
        self.lose = False
        self.created = threading.Event()
        self.stop = threading.Event()


@contextmanager
def provider_server(allowed: Intent | None = None):
    zone = Zone()
    server = FastMCP("provider-fixture", stateless_http=True, json_response=True)

    @server.tool(name="domain-record-list")
    async def listing(Domain: str, Page: int, PerPage: int) -> dict:
        if allowed and Domain != allowed.zone:
            zone.calls.append(("denied", Domain))
            raise ValueError("Provider credential has no access to this zone")
        zone.calls.append(("list", Domain))
        if zone.unreadable:
            raise ValueError("Unavailable")
        return {"domain_records": zone.records[(Page - 1) * PerPage : Page * PerPage]}

    @server.tool(name="domain-record-create")
    async def create(Domain: str, Type: str, Name: str, Data: str) -> dict:
        if allowed and (Domain, Type, Name, Data) != (
            allowed.zone,
            "A",
            allowed.label,
            allowed.address,
        ):
            zone.calls.append(("denied", Domain))
            raise ValueError("Provider denied changing this record")
        zone.calls.append(("create", Domain))
        zone.records.append({"type": Type, "name": Name, "data": Data})
        zone.created.set()
        if zone.lose:
            while not zone.stop.is_set():
                await asyncio.sleep(0.03)
        return {"domain_record": zone.records[-1]}

    with serve_provider(server) as endpoint:
        try:
            yield zone, endpoint
        finally:
            zone.stop.set()


@contextmanager
def serve_provider(server):
    asgi = server.streamable_http_app()
    from starlette.middleware.base import BaseHTTPMiddleware

    async def auth(request, call_next):
        if request.headers.get("authorization") != "Bearer synthetic-access-token":
            return Response(status_code=401)
        return await call_next(request)

    asgi.add_middleware(BaseHTTPMiddleware, dispatch=auth)
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        sock.listen()
        http = uvicorn.Server(uvicorn.Config(asgi, log_level="error", access_log=False))
        thread = threading.Thread(target=lambda: http.run(sockets=[sock]), daemon=True)
        thread.start()
        deadline = time.monotonic() + 5
        while not http.started:
            assert time.monotonic() < deadline
            time.sleep(0.02)
        try:
            yield "http://127.0.0.1:" + str(sock.getsockname()[1]) + "/mcp"
        finally:
            http.should_exit = True
            thread.join(5)


def configured(path, endpoint):
    state = State(Path(path), Clock())
    catalog = Catalog(state)
    definition = catalog.path / "connectors/digitalocean.json"
    catalog.define(
        "connectors",
        "digitalocean",
        {"endpoint": endpoint, "authentication": "bearer", "secret": "digitalocean"},
    )
    remote = RemoteMCP(state, definition, {"digitalocean": endpoint})
    return Application(state, catalog, NoRuntime(), DNSProvider(remote)), remote


def dispatch(path, endpoint):
    app, _ = configured(path, endpoint)
    asyncio.run(app.step())


def lose_create_reply(tmp_path, zone, endpoint):
    app, remote = configured(tmp_path / "state", endpoint)
    key = app.submit("/dns example.test orders 192.0.2.8")
    asyncio.run(app.step())
    assert app.state.one("SELECT status FROM tasks WHERE id=?", key)["status"] == "credential"
    app.credential(key, "synthetic-access-token")
    app.state.change("UPDATE tasks SET thread='discarded-thread' WHERE id=?", key)
    assert asyncio.run(remote.call()) == ["domain-record-create", "domain-record-list"]
    zone.lose = True
    process = multiprocessing.get_context("spawn").Process(
        target=dispatch, args=(app.state.path, endpoint)
    )
    process.start()
    try:
        assert zone.created.wait(12)
        assert app.state.one("SELECT * FROM operations WHERE task=?", key)["status"] == "dispatched"
    finally:
        process.kill()
        process.join(5)
        zone.stop.set()
    return app, key


@pytest.mark.parametrize("unreadable", [False, True], ids=["observed", "unknown"])
def test_dns_crash_recovery(tmp_path, unreadable):
    with provider_server() as (zone, endpoint):
        app, key = lose_create_reply(tmp_path, zone, endpoint)
        zone.unreadable = unreadable
        fresh, _ = configured(app.state.path, endpoint)

        class RecoveryRuntime(NoRuntime):
            async def run(self, application, row):
                self.calls += 1
                assert row["thread"] is None
                checkpoint = json.loads(application.context(row))["checkpoint"]
                assert checkpoint["goal"] == "/dns example.test orders 192.0.2.8"
                assert checkpoint["dns_recovery"]["operation"] in checkpoint["outstanding"]
                application.state.change(
                    "UPDATE tasks SET thread='fresh-thread' WHERE id=?", row["id"]
                )
                tools = application.tools(row["id"])
                assert [t["name"] for t in tools.definitions()] == ["connector_observe_recovery"]
                result = await asyncio.to_thread(tools.call, "connector_observe_recovery", {})
                assert result["observation"]["status"] == ("unknown" if unreadable else "healthy")
                return "completed"

        fresh.runtime = RecoveryRuntime()
        fresh.recover()
        for _ in range(10):
            asyncio.run(fresh.step())
            fresh.state.clock.advance()
        task = fresh.state.one("SELECT * FROM tasks WHERE id=?", key)
        assert fresh.runtime.calls == 1 and task["thread"] == "fresh-thread"
        assert fresh.state.rows(
            "SELECT 1 FROM events WHERE task=? AND run=? AND kind='dns.recovery.result'",
            key,
            task["run"],
        )
        operation = fresh.state.one("SELECT * FROM operations WHERE task=?", key)
        assert operation["id"] in json.loads(task["checkpoint"])["operations"]
        assert task["status"] == ("unknown" if unreadable else "verified")
        assert operation["attempts"] <= fresh.dns.limit
        assert len(fresh.state.rows("SELECT * FROM alerts")) == int(unreadable)
        assert len(list((fresh.state.path / "notifications").glob("*.json"))) == int(unreadable)
        assert zone.records == [{"type": "A", "name": "orders", "data": "192.0.2.8"}]
        if not unreadable:
            again = fresh.submit("/dns example.test orders 192.0.2.8")
            asyncio.run(fresh.step())
            assert (
                fresh.state.one("SELECT status FROM tasks WHERE id=?", again)["status"]
                == "verified"
            )
        assert [c for c in zone.calls if c[0] == "create"] == [("create", "example.test")]
        assert "synthetic-access-token" not in str(fresh.state.events())
        assert "synthetic-access-token" not in fresh.catalog.git("log", "--all", "-p")


@pytest.mark.parametrize(
    ("records", "answer"),
    [
        ([], "absent"),
        ([{"type": "A", "name": "orders", "data": "192.0.2.8"}], "healthy"),
        ([{"type": "A", "name": "orders", "data": "192.0.2.9"}], "conflict"),
        ([{"type": "CNAME", "name": "orders", "data": "other.test"}], "conflict"),
        ([{"type": "A", "name": "*", "data": "192.0.2.9"}], "conflict"),
        ([{"type": "A", "name": "*.other", "data": "192.0.2.9"}], "absent"),
        ([{"broken": True}], "unknown"),
    ],
)
def test_observation(records, answer):
    class Remote:
        async def call(self, *args):
            return {"domain_records": records}

    observed = asyncio.run(
        DNSProvider(Remote()).observe(Intent("example.test", "orders", "192.0.2.8"))
    )
    assert observed.status == answer


def test_secret_destination_and_redaction(app):
    app.state.secret("digitalocean", "synthetic-access-token")
    app.catalog.define(
        "connectors",
        "digitalocean",
        {
            "endpoint": "https://elsewhere.invalid",
            "authentication": "bearer",
            "secret": "digitalocean",
        },
    )
    with pytest.raises(ValueError, match="grant"):
        app.remote.settings()
    task = app.submit("remember synthetic-access-token")
    assert "synthetic-access-token" not in str(app.state.events())
    assert "[redacted]" in app.state.one("SELECT goal FROM tasks WHERE id=?", task)["goal"]


def test_overlapping_owner_tasks_do_not_replay_unacknowledged_create(app, clock, run):
    from swarm.dns import DNSReconciler, Observation

    class StaleReader:
        creates = 0

        async def observe(self, intent):
            return Observation("absent", "Replica still reports absence")

        async def create(self, intent, operation):
            self.creates += 1
            raise TimeoutError

    provider = StaleReader()
    app.dns = DNSReconciler(app.state, provider)
    first = app.submit("/dns example.test orders 192.0.2.8")
    run(app.step())
    second = app.submit("/dns example.test orders 192.0.2.8")
    run(app.step())
    assert (
        provider.creates == 1
        and app.state.one("SELECT status FROM tasks WHERE id=?", second)["status"] == "waiting"
    )
    assert (
        app.tools(first).connector_result(second)["evidence"]["prior_operation"]
        == app.tools(first).connector_result(first)["id"]
    )
