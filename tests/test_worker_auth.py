import sys
from pathlib import Path

from test_message import controller, headers, login, message, process, wait_until

from operator_v1.config import Settings


def test_worker_sign_in_keeps_the_queue_and_recovers_after_rejection(tmp_path):
    settings = Settings(tmp_path)
    settings.create_owner_key()
    fake_codex = tmp_path / "codex"
    fake_codex.write_text(
        f"#!{sys.executable}\n" + Path(__file__).with_name("fixture_codex_auth.py").read_text()
    )
    fake_codex.chmod(0o700)
    env = {
        "OPERATOR_STATE_DIR": str(tmp_path),
        "OPERATOR_MODEL": "codex",
        "OPERATOR_CODEX": str(fake_codex),
        "OPERATOR_TEST_CODEX_AUTH_STATE": str(tmp_path),
    }
    with controller(settings) as client, process(["operator_v1.worker"], env):
        connect = "/api/worker/auth/connect"
        cancel = "/api/worker/auth/cancel"
        disconnect = "/api/worker/auth/disconnect"
        assert client.get("/api/worker").status_code == 401
        assert client.post(connect, headers=headers(settings)).status_code == 401
        assert client.post(disconnect, headers=headers(settings)).status_code == 401
        login(client, settings)
        assert client.post(connect).status_code == 403
        assert client.post(cancel).status_code == 403
        assert client.post(disconnect).status_code == 403

        def auth():
            return client.get("/api/worker").json()["auth"] or {}

        def submit():
            receipt = client.post("/api/commands", json=message(), headers=headers(settings))
            assert receipt.status_code == 202
            return receipt.json()["taskId"]

        def snapshot():
            return client.get("/api/snapshot").json()

        wait_until(lambda: auth().get("state") == "required")
        task = submit()
        assert snapshot()["tasks"][0]["checkpoint"] == "queued"
        assert client.post(connect, headers=headers(settings)).status_code == 200
        wait_until(lambda: auth().get("state") == "waiting")
        challenge = auth()["login"]
        assert challenge["user_code"] == "TEST-1234"
        assert client.post(connect, headers=headers(settings)).json()["login"] == challenge
        assert client.get("/api/worker").headers["cache-control"] == "no-store"
        assert "TEST-1234" not in (tmp_path / "worker-status.json").read_text()
        assert client.post(cancel, headers=headers(settings)).json()["login"] is None
        assert auth()["state"] == "required"
        assert snapshot()["tasks"][0]["checkpoint"] == "queued"

        assert client.post(connect, headers=headers(settings)).json()["state"] == "starting"
        wait_until(lambda: auth().get("state") == "waiting")
        (tmp_path / "approve").touch()
        wait_until(lambda: auth().get("state") == "ready")
        wait_until(lambda: snapshot()["tasks"][0]["checkpoint"] == "completed")
        assert any(
            event["kind"] == "answered" and event["task"] == task for event in snapshot()["events"]
        )

        (tmp_path / "codex-session").unlink()
        rejected = submit()
        wait_until(lambda: auth().get("state") == "required")
        assert auth()["reconnect"] is True
        queued = submit()
        assert next(t for t in snapshot()["tasks"] if t["id"] == queued)["checkpoint"] == "queued"
        assert any(
            event["data"].get("action") == "worker_signin" and event["task"] == rejected
            for event in snapshot()["events"]
        )
        assert client.post(connect, headers=headers(settings)).status_code == 200
        wait_until(lambda: auth().get("state") == "waiting")
        (tmp_path / "approve").touch()
        wait_until(
            lambda: any(
                event["kind"] == "answered" and event["task"] == queued
                for event in snapshot()["events"]
            )
        )

        # Disconnect drains the current model turn and holds the next task.
        assert any(
            event["kind"] == "answered" and event["task"] == rejected
            for event in snapshot()["events"]
        )
        assert auth()["can_disconnect"] is True
        hold = tmp_path / "hold-turn"
        hold.touch()
        running = submit()
        wait_until(lambda: client.get("/api/worker").json()["report"]["active_task"] == running)
        assert client.post(disconnect, headers=headers(settings)).json()["state"] == "disconnecting"
        assert client.post(disconnect, headers=headers(settings)).json()["state"] == "disconnecting"
        held = submit()
        assert (tmp_path / "codex-session").is_file()
        hold.unlink()

        wait_until(lambda: auth()["state"] == "required")
        assert auth()["can_disconnect"] is False
        assert not (tmp_path / "codex-session").exists()
        worker = client.get("/api/worker").json()
        assert worker["health"] == "online"
        assert worker["queued_tasks"] == 1
        assert any(
            event["kind"] == "answered" and event["task"] == running
            for event in snapshot()["events"]
        )
        assert client.post(connect, headers=headers(settings)).json()["state"] == "starting"
        wait_until(lambda: auth().get("state") == "waiting")
        (tmp_path / "approve").touch()
        wait_until(
            lambda: any(
                event["kind"] == "answered" and event["task"] == held
                for event in snapshot()["events"]
            )
        )
