import json
import os
import socket
import stat
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from uuid import uuid4

import httpx
import pytest

from operator_v1.config import Settings
from operator_v1.state import State
from operator_v1.worker import MessageWorker


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
        for field in (
            {"params": {"after": "9223372036854775808"}},
            {"headers": {"Last-Event-ID": "-1"}},
        ):
            invalid = client.get("/api/events", **field)
            assert invalid.status_code == 422
            assert invalid.json() == {"detail": "Invalid request"}
        for query in ({"after": 1}, {"epoch": "different-state"}):
            reset = client.get("/api/events", params=query)
            assert reset.status_code == 200
            assert "event: reset" in reset.text
        # Observe the actual controller notification at the private worker endpoint.
        with socket.socket(socket.AF_UNIX) as listener:
            listener.bind(str(settings.socket))
            listener.listen()
            listener.settimeout(1)
            created = client.post("/api/commands", json=body, headers=headers(settings))
            listener.accept()[0].close()
        assert created.status_code == 202
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


def test_sessions_on_the_same_hostname_keep_separate_cookies(tmp_path):
    first = Settings(tmp_path / "local", origin="http://127.0.0.1:8080")
    second = Settings(tmp_path / "preview", origin="http://127.0.0.1:8083")
    first.create_owner_key()
    second.create_owner_key()

    with (
        controller(first) as local,
        controller(second) as preview,
        httpx.Client(trust_env=False) as browser,
    ):
        local_session = local.base_url.join("/api/session")
        preview_session = preview.base_url.join("/api/session")
        for settings, session_url in ((first, local_session), (second, preview_session)):
            assert browser.get(session_url).status_code == 401
            assert (
                browser.post(
                    session_url,
                    headers=headers(settings),
                    json={"key": settings.owner_key.read_text().strip()},
                ).status_code
                == 204
            )
        assert browser.get(local_session).status_code == 204
        assert browser.get(preview_session).status_code == 204


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
                event_type = None
                for line in resumed.iter_lines():
                    if line.startswith("event: "):
                        event_type = line[7:]
                    elif line.startswith("data: "):
                        data = json.loads(line[6:])
                        if event_type == "caught-up":
                            assert data == replay[-1]["seq"]
                            break
                        assert event_type == "op"
                        replay.append(data)
                else:
                    pytest.fail("Stream ended before catch-up")
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


def test_concurrent_message_retry(tmp_path):
    settings = Settings(tmp_path)
    settings.create_owner_key()
    body = message()
    with controller(settings) as client:
        login(client, settings)

        def submit(_):
            response = client.post("/api/commands", json=body, headers=headers(settings))
            assert response.status_code == 202
            return response.json()["taskId"]

        with ThreadPoolExecutor(max_workers=4) as pool:
            assert len(set(pool.map(submit, range(4)))) == 1
        assert client.get("/api/snapshot").json()["cursor"] == 2


def test_private_state_files(tmp_path):
    settings = Settings(tmp_path)
    settings.create_owner_key()
    original = settings.read_owner_key()
    with pytest.raises(FileExistsError):
        settings.create_owner_key()
    assert settings.read_owner_key() == original
    settings.owner_key.chmod(0o644)
    with pytest.raises(PermissionError):
        settings.read_owner_key()
    settings.socket.write_text("existing file")
    with pytest.raises(FileExistsError):
        MessageWorker(settings).serve()
    assert settings.socket.read_text() == "existing file"
