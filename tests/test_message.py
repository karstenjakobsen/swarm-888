import json
import os
import socket
import stat
import subprocess
import sys
import time
from contextlib import contextmanager
from uuid import uuid4

import httpx
import pytest

from operator_v1.config import Settings
from operator_v1.state import State


def message():
    return {"kind": "message", "requestId": str(uuid4()), "text": "Confirm you received this."}


def headers(settings):
    return {"Origin": settings.origin, "X-Operator-Action": "1"}


def login(client, settings):
    response = client.post(
        "/api/session",
        headers=headers(settings),
        json={"key": settings.owner_key.read_text().strip()},
    )
    assert response.status_code == 204
    assert "HttpOnly" in response.headers["set-cookie"]
    assert "Path=/api" in response.headers["set-cookie"]


def test_private_api_and_idempotent_submission(tmp_path):
    settings = Settings(tmp_path, instructions="Ask before changing host state.")
    settings.create_owner_key()
    with controller(settings) as client:
        body = message()
        assert client.get("/api/snapshot").status_code == 401
        assert client.get("/api/events").status_code == 401
        assert client.post("/api/commands", json=body, headers=headers(settings)).status_code == 401
        assert (
            client.post(
                "/api/session", json={"key": "invalid"}, headers=headers(settings)
            ).status_code
            == 401
        )
        login(client, settings)
        for denied in (
            {"Origin": settings.origin},
            {**headers(settings), "Origin": "http://elsewhere.invalid"},
        ):
            assert client.post("/api/commands", json=body, headers=denied).status_code == 403
        before = client.get("/api/snapshot").json()
        assert before["cursor"] == 0 and before["tasks"] == []
        # Observe the actual controller notification at the private worker endpoint.
        with socket.socket(socket.AF_UNIX) as listener:
            listener.bind(str(settings.socket))
            listener.listen()
            listener.settimeout(1)
            created = client.post("/api/commands", json=body, headers=headers(settings))
            listener.accept()[0].close()
        assert created.status_code == 202
        assert (
            client.post("/api/commands", json=body, headers=headers(settings)).json()
            == created.json()
        )
        assert (
            client.post(
                "/api/commands",
                json={**body, "text": "conflicting retry"},
                headers=headers(settings),
            ).status_code
            == 409
        )
        assert (
            client.post(
                "/api/commands", json={**body, "text": "  "}, headers=headers(settings)
            ).status_code
            == 422
        )
    with controller(Settings(tmp_path)) as restarted:
        login(restarted, settings)
        snapshot = restarted.get("/api/snapshot").json()
        assert snapshot["profile"] == before["profile"]
        assert snapshot["profile"]["instructions"] == settings.instructions
        assert snapshot["cursor"] == 2
        assert len(snapshot["tasks"]) == 1
        assert snapshot["tasks"][0]["checkpoint"] == "queued"


@contextmanager
def process(args, env, **options):
    child = subprocess.Popen([sys.executable, "-m", *args], env={**os.environ, **env}, **options)
    try:
        yield child
    finally:
        child.terminate()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()


def wait_until(check):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if check():
            return
        time.sleep(0.03)
    pytest.fail("Timed out waiting for the local operator")


@contextmanager
def controller(settings):
    env = {
        "OPERATOR_STATE_DIR": str(settings.directory),
        "OPERATOR_ORIGIN": settings.origin,
        "OPERATOR_INSTRUCTIONS": settings.instructions,
    }
    with socket.socket() as port:
        port.bind(("127.0.0.1", 0))
        port.listen()
        with (
            process(
                [
                    "uvicorn",
                    "operator_v1.controller:create_app",
                    "--factory",
                    "--fd",
                    str(port.fileno()),
                ],
                env,
                pass_fds=(port.fileno(),),
            ),
            httpx.Client(
                base_url=f"http://127.0.0.1:{port.getsockname()[1]}", trust_env=False
            ) as client,
        ):
            yield client


def test_worker_restart_and_stream_resume(tmp_path):
    settings = Settings(tmp_path)
    settings.create_owner_key()
    env = {"OPERATOR_STATE_DIR": str(tmp_path), "OPERATOR_ORIGIN": settings.origin}
    with controller(settings) as client:
        login(client, settings)
        cursor = client.get("/api/snapshot").json()["cursor"]
        # These commits occur after the snapshot and before the first SSE connection.
        task = client.post("/api/commands", json=message(), headers=headers(settings)).json()[
            "taskId"
        ]
        with client.stream("GET", "/api/events", params={"after": cursor}) as stream:
            assert stream.status_code == 200
            first = next(
                json.loads(line[6:]) for line in stream.iter_lines() if line.startswith("data: ")
            )
        assert first["seq"] == cursor + 1
        # A process that died immediately after claim left a running checkpoint.
        assert State(settings).claim() == task
        with process(["operator_v1.worker"], env):
            wait_until(lambda: settings.socket.exists())
            assert stat.S_IMODE(settings.socket.stat().st_mode) == 0o600
            wait_until(
                lambda: client.get("/api/snapshot").json()["tasks"][0]["checkpoint"] == "completed"
            )
            with client.stream(
                "GET", "/api/events?after=0", headers={"Last-Event-ID": str(first["seq"])}
            ) as resumed:
                replay = [first]
                for line in resumed.iter_lines():
                    if line.startswith("data: "):
                        replay.append(json.loads(line[6:]))
                        if replay[-1]["kind"] == "completed":
                            break
            snapshot = client.get("/api/snapshot").json()
            assert replay == snapshot["events"]
            assert snapshot["cursor"] == replay[-1]["seq"]
            assert [e["kind"] for e in replay] == [
                "received",
                "owner_message",
                "started",
                "answered",
                "completed",
            ]
            assert snapshot["tasks"] == [
                {"id": task, "checkpoint": "completed", "outcome": replay[-1]["outcome"]}
            ]
            assert replay[-1]["outcome"]["label"] == "Acknowledged"
