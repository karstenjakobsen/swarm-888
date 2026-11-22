import json
import socket
import time
from pathlib import Path
from uuid import uuid4

import httpx
from test_message import controller, headers, login, process, wait_until
from test_skills import bootstrap

from operator_v1.catalog import run_git


def test_connector_pause_redaction_timeout_and_destination_binding(tmp_path, capfd):
    settings, env = bootstrap(tmp_path)
    settings.create_owner_key()
    checkout = Path(env["OPERATOR_CATALOG_CHECKOUT"])
    path = checkout / "connectors" / "fixture.json"
    token = "test-credential-" + uuid4().hex
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        endpoint = f"http://127.0.0.1:{listener.getsockname()[1]}/mcp"
        binding = {"endpoint": endpoint, "secret_ref": "fixture-token"}
        (settings.directory / "connector-bindings.json").write_text(
            json.dumps({"fixture": binding})
        )
        definition = {
            **binding,
            "name": "Fixture",
            "auth": "bearer",
            "tool": "fixture_status",
            "timeout": 1,
        }
        path.write_text(json.dumps(definition))
        run_git("add", "--", "connectors", cwd=checkout)
        run_git("commit", "-m", "Configure the fixture read", cwd=checkout)
        args = [
            "uvicorn",
            "fixture_connector:app",
            "--app-dir",
            "tests",
            "--fd",
            str(listener.fileno()),
        ]
        with (
            process(args, {"FIXTURE_MCP_TOKEN": token}, pass_fds=(listener.fileno(),)),
            controller(settings) as client,
            process(["operator_v1.worker"], {**env, "OPERATOR_MODEL": "simulated"}),
        ):

            def submit(text):
                response = client.post(
                    "/api/commands",
                    headers=headers(settings),
                    json={"kind": "message", "text": text, "requestId": str(uuid4())},
                )
                assert response.status_code == 202
                return response.json()["taskId"]

            def task_events(task):
                snapshot = client.get("/api/snapshot").json()
                return [event for event in snapshot["events"] if event["task"] == task]

            def find(task, action):
                return next(
                    (event for event in task_events(task) if event["data"].get("action") == action),
                    None,
                )

            login(client, settings)
            first = submit("Read connector fixture")
            wait_until(lambda: find(first, "credential_requested"))
            request = find(first, "credential_requested")["data"]["request"]
            assert task_events(first)[-1]["outcome"]["key"] == "needs-you"
            body = {"requestId": request, "value": token}
            assert client.get("/api/secrets").status_code == 405
            assert client.post("/api/secrets", json=body).status_code == 403
            with httpx.Client(base_url=str(client.base_url), trust_env=False) as anonymous:
                assert (
                    anonymous.post("/api/secrets", json=body, headers=headers(settings)).status_code
                    == 401
                )
            assert (
                client.post("/api/secrets", json=body, headers=headers(settings)).status_code == 204
            )
            wait_until(lambda: task_events(first)[-1]["kind"] == "completed")
            assert find(first, "connector_used")["data"]["result"] == {
                "status": "ready",
                "redactionProbe": "[redacted]",
            }
            assert (
                find(first, "connector_configured")["data"]["tools"][0]["name"] == "fixture_status"
            )
            before = time.monotonic()
            delayed = submit("Read connector fixture slowly")
            wait_until(lambda: find(delayed, "connector_timeout"))
            assert time.monotonic() - before < 5
            assert find(delayed, "connector_used") is None
            assert find(delayed, "connector_timeout")["outcome"]["key"] == "failed"

            path.write_text(json.dumps({**definition, "endpoint": endpoint + "/wrong"}))
            run_git("commit", "-m", "Change catalog destination", "--", str(path), cwd=checkout)
            moved = submit("Read connector fixture")
            wait_until(lambda: task_events(moved)[-1]["kind"] == "failed")
            assert "differs from its owner-authorized binding" in task_events(moved)[-1]["text"]
            assert find(moved, "connector_used") is None
            assert token not in client.get("/api/snapshot").text
        assert token not in run_git("log", "-p", cwd=checkout).stdout
        assert token not in "\n".join(capfd.readouterr())
