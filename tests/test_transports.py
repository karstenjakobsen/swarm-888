import asyncio
import json
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import httpx
import pytest
import uvicorn
from conftest import csrf_token
from fastapi.testclient import TestClient
from mcp import ClientSession, StdioServerParameters, types
from mcp.client.stdio import stdio_client

from swarm.controller import controller, owner_key
from swarm.ingress import verify_ingress
from swarm.state import ROOT
from swarm.worker import service


def test_mcp_hotplug_inflight_rollback(app, monkeypatch):
    active = app.catalog.active
    hold, started, release = threading.Event(), threading.Event(), threading.Event()

    def select_revision(key):
        selected = active(key)
        if hold.is_set():
            hold.clear()
            started.set()
            assert release.wait(15)
        return selected

    monkeypatch.setattr(app.catalog, "active", select_revision)
    with tempfile.TemporaryDirectory() as directory, socket.socket(socket.AF_UNIX) as sock:
        path = str(Path(directory) / "s")
        sock.bind(path)
        sock.listen(32)
        server = uvicorn.Server(
            uvicorn.Config(service(app, schedule=False), log_level="error", access_log=False)
        )
        thread = threading.Thread(target=lambda: server.run(sockets=[sock]), daemon=True)
        thread.start()
        try:
            deadline = time.monotonic() + 6
            while not server.started:
                assert time.monotonic() < deadline
                time.sleep(0.02)
            task = app.submit("Author and exercise a versioned local tool")
            app.state.change("UPDATE tasks SET status='running' WHERE id=?", task)

            async def scenario():
                notices = asyncio.Event()

                async def handle(message):
                    if (
                        getattr(getattr(message, "root", None), "method", "")
                        == "notifications/tools/list_changed"
                    ):
                        notices.set()

                params = StdioServerParameters(
                    command=sys.executable, args=[str(ROOT / "swarm/bridge.py"), path, task]
                )
                async with (
                    stdio_client(params) as (read, write),
                    ClientSession(read, write, message_handler=handle) as client,
                ):
                    init = await client.initialize()
                    assert init.capabilities.tools and init.capabilities.tools.listChanged

                    async def names():
                        return [t.name for t in (await client.list_tools()).tools]

                    async def call(tool, **args):
                        answer = await client.call_tool(tool, args)
                        assert not answer.isError, answer.content
                        return answer.structuredContent

                    assert "local_count_lines" not in await names()
                    package = await call("skill_template")

                    async def install():
                        rev = (await call("skill_stage", package=package))["revision"]
                        assert (await call("skill_test", revision=rev))["passed"]
                        await call("skill_activate", revision=rev)
                        return rev

                    a = await install()
                    await asyncio.wait_for(notices.wait(), 5)
                    assert "local_count_lines" in await names()
                    hold.set()
                    pinned = asyncio.create_task(
                        call("local_count_lines", arguments={"text": "one\ntwo"})
                    )
                    assert await asyncio.to_thread(started.wait, 4)
                    package["sql"] = (
                        "SELECT CASE WHEN json_extract(:input,'$.invalid') THEN json('invalid') ELSE "
                        "json_object('lines',count(*)+coalesce(json_extract(:input,'$.extra'),0)) END FROM lines"
                    )
                    package["tests"] = [
                        {"input": {"text": "one", "extra": 2}, "expected": {"lines": 3}}
                    ]
                    b = await install()
                    release.set()
                    assert (await pinned)["revision"] == a
                    assert (await call("local_count_lines", arguments={"extra": 5}))["result"] == {
                        "lines": 5
                    }
                    failed = await client.call_tool(
                        "local_count_lines", {"arguments": {"invalid": True}}
                    )
                    assert failed.isError
                    recorded = app.skill_view("count-lines")["calls"][0]
                    assert isinstance(failed.content[0], types.TextContent)
                    assert recorded["id"] in failed.content[0].text
                    evidence = await call("skill_evidence", call=recorded["id"])
                    assert evidence["failure"]["exit_status"] == 1 and evidence["actual"] is None
                    package["sql"] = "not a program"
                    bad = (await call("skill_stage", package=package))["revision"]
                    assert not (await call("skill_test", revision=bad))["passed"]
                    assert (await client.call_tool("skill_activate", {"revision": bad})).isError
                    assert (await call("skill_run", name="count-lines", arguments={}))[
                        "revision"
                    ] == b
                    await call("skill_rollback", name="count-lines", revision=a)
                    assert (await call("local_count_lines", arguments={"extra": 5}))["result"] == {
                        "lines": 0
                    }

            asyncio.run(scenario())
        finally:
            release.set()
            server.should_exit = True
            thread.join(7)


def test_ui_auth_replay_artifact_and_wait(app):
    api = controller(app.state.path, httpx.ASGITransport(app=service(app, schedule=False)))
    with TestClient(api, base_url="http://localhost") as client:
        assert client.get("/").headers["referrer-policy"] == "same-origin"
        assert client.get("/activity?once=true").status_code == 401
        assert client.get("/artifacts/invalid").status_code == 401
        assert client.post("/message", data={"text": "untrusted"}).status_code == 401
        assert (
            client.post(
                "/login", headers={"origin": "https://other.test"}, data={"key": "no"}
            ).status_code
            == 403
        )
        assert client.post("/login", data={"key": owner_key(app.state.path)}).status_code == 200
        assert client.post("/message", data={"text": "no token"}).status_code == 403
        csrf = csrf_token(client.get("/").text)
        response = client.post("/message", data={"csrf": csrf, "text": "<script>alert(1)</script>"})
        assert response.status_code == 200 and "<script>alert" not in response.text
        task = app.summary()["tasks"][0]["id"]
        before = client.get("/activity?once=true").text
        events = [json.loads(line[6:]) for line in before.splitlines() if line.startswith("data: ")]
        cursor = events[-1]["id"]
        assert f'data-event-cursor="{cursor}"' in response.text
        other = app.submit("Unrelated conversation")
        scoped = client.get("/activity", params={"task": task, "once": "true"}).text
        assert task in scoped and other not in scoped
        app.state.change("UPDATE tasks SET status='running' WHERE id=?", task)
        app.tools(task).call("ask_owner", {"question": "Which project?"})
        resume = {"Last-Event-ID": str(cursor)}
        assert other in client.get("/activity?once=true", headers=resume).text
        replay = client.get("/activity", params={"task": task, "once": "true"}, headers=resume).text
        assert '"kind":"question"' in replay and '"kind":"owner.message"' not in replay
        response = client.post("/message", data={"task": task, "csrf": csrf, "text": "Orders"})
        assert response.status_code == 200 and app.task_summary(task)["status"] == "queued"
        assert client.get("/artifacts/..%2Fcontroller.key").status_code == 404
        assert client.get("/skills/skill-author").status_code == 200
        assert client.post("/action/logout", data={"csrf": csrf}).status_code == 200
        assert client.get("/activity?once=true").status_code == 401


def test_owner_key_is_published_complete_and_empty_keys_fail_closed(tmp_path):
    state = tmp_path / "private"
    with ThreadPoolExecutor(8) as pool:
        keys = list(pool.map(lambda _: owner_key(state), range(16)))
    assert len(set(keys)) == 1 and keys[0]
    key = state / "controller.key"
    assert key.stat().st_mode & 0o777 == 0o600
    key.write_text("\n")
    with pytest.raises(ValueError, match="empty"):
        controller(state)


def test_worker_rpc_validates_arguments_before_dispatch(app):
    with TestClient(service(app, schedule=False)) as client:
        for method, params in [
            ("submit", {"text": []}),
            ("credential", {"task": "missing", "token": ["private-value"]}),
            ("generation", {"private-value": "private-value"}),
            ("attest", {"call": "missing", "expected": [], "observation": "checked"}),
        ]:
            r = client.post("/rpc", json={"method": method, "params": params})
            assert r.status_code == 400 and "private-value" not in r.text
        assert client.post("/rpc", json={"method": "unknown"}).status_code == 404
        invalid = client.post("/rpc", json={"method": "credential", "params": ["private-value"]})
        assert invalid.status_code == 422 and "private-value" not in invalid.text
        assert client.post("/rpc", json={"method": "generation"}).json() == 0
        assert app.summary()["tasks"] == []


def test_tls_service_specific_probe(tmp_path):
    cert, key = tmp_path / "cert.pem", tmp_path / "key.pem"
    subprocess.run(
        [
            "openssl",
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-days",
            "1",
            "-subj",
            "/CN=localhost",
            "-addext",
            "subjectAltName=DNS:localhost",
            "-out",
            cert,
            "-keyout",
            key,
        ],
        capture_output=True,
        check=True,
    )

    class Service(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"orders-service build 42")

        def log_message(self, format, *args):
            pass

    with HTTPServer(("127.0.0.1", 0), Service) as server:
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(cert, key)
        server.socket = tls.wrap_socket(server.socket, server_side=True)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            opts = {"ca_file": str(cert), "port": server.server_port}
            assert verify_ingress("localhost", "orders-service", **opts)["verified"]
            assert not verify_ingress("localhost", "accounts-service", **opts)["verified"]
            with pytest.raises(httpx.ConnectError):
                verify_ingress("127.0.0.1", "orders-service", **opts)
        finally:
            server.shutdown()
            thread.join()
