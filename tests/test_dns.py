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
def provider_server():
    zone = Zone()
    server = FastMCP("provider-fixture", stateless_http=True, json_response=True)

    @server.tool(name="domain-record-list")
    async def listing(Domain: str, Page: int, PerPage: int) -> dict:
        zone.calls.append(("list", Domain))
        if zone.unreadable:
            raise ValueError("Unavailable")
        return {"domain_records": zone.records[(Page - 1) * PerPage : Page * PerPage]}

    @server.tool(name="domain-record-create")
    async def create(Domain: str, Type: str, Name: str, Data: str) -> dict:
        zone.calls.append(("create", Domain))
        zone.records.append({"type": Type, "name": Name, "data": Data})
        zone.created.set()
        if zone.lose:
            while not zone.stop.is_set():
                await asyncio.sleep(0.03)
        return {"domain_record": zone.records[-1]}

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
            yield zone, "http://127.0.0.1:" + str(sock.getsockname()[1]) + "/mcp"
        finally:
            zone.stop.set()
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


@pytest.mark.parametrize("unreadable", [False, True], ids=["observed", "unknown"])
def test_dns_crash_recovery(tmp_path, unreadable):
    with provider_server() as (zone, endpoint):
        app, remote = configured(tmp_path / "state", endpoint)
        key = app.submit("/dns example.test orders 192.0.2.8")
        asyncio.run(app.step())
        assert app.state.one("SELECT status FROM tasks WHERE id=?", key)["status"] == "credential"
        app.credential(key, "synthetic-access-token")
        assert asyncio.run(remote.call()) == ["domain-record-create", "domain-record-list"]
        zone.lose = True
        process = multiprocessing.get_context("spawn").Process(
            target=dispatch, args=(app.state.path, endpoint)
        )
        process.start()
        try:
            assert zone.created.wait(12)
            assert (
                app.state.one("SELECT * FROM operations WHERE task=?", key)["status"]
                == "dispatched"
            )
        finally:
            process.kill()
            process.join(5)
            zone.stop.set()
        zone.unreadable = unreadable
        fresh, _ = configured(app.state.path, endpoint)
        fresh.recover()
        for _ in range(10):
            asyncio.run(fresh.step())
            fresh.state.clock.advance()
        task = fresh.state.one("SELECT * FROM tasks WHERE id=?", key)
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
