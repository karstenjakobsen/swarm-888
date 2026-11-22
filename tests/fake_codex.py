#!/usr/bin/env python3
"""Protocol fixture for deterministic tests without model calls."""

import json
import sys
import time
from pathlib import Path


def emit(**msg):
    print(json.dumps(msg), flush=True)


for line in sys.stdin:
    msg = json.loads(line)
    method = msg.get("method")
    ident = msg.get("id")
    params = msg.get("params", {})
    if method in ("initialize", "account/login/start"):
        emit(id=ident, result={})
    if method in ("thread/start", "thread/resume"):
        assert params["approvalPolicy"] == "never" and params["sandbox"] == "workspace-write"
        if method == "thread/resume":
            if params["threadId"] == "expired-thread":
                emit(id=ident, error={"code": -32600, "message": "Thread unavailable"})
                continue
            assert params["threadId"] == "fixture-thread"
        emit(id=ident, result={"thread": {"id": "fixture-thread", "turns": []}})
    if method == "turn/start":
        prompt = params["input"][0]["text"]
        memory = ""
        if prompt == "missing credential":
            memory = "The registry needs an external credential."
        if prompt == "recall previous decision":
            assert "registry needs an external credential" in params["input"][1]["text"]
        if prompt == "continue from SQLite":
            assert "missing credential" in params["input"][1]["text"]
            assert "recall previous decision" not in params["input"][1]["text"]
        assert "memory" in params["outputSchema"]["required"]
        emit(id=ident, result={"turn": {"id": "fixture-turn"}})
        emit(
            method="item/started",
            params={
                "threadId": "fixture-thread",
                "turnId": "fixture-turn",
                "item": {"type": "fileChange"},
            },
        )
        if prompt == "Wait for restart":
            time.sleep(30)
        path = Path("projects") / "sample"
        path.mkdir(exist_ok=True, parents=True)
        (path / "README.md").write_text("Fixture result\n")
        emit(
            method="item/completed",
            params={
                "threadId": "fixture-thread",
                "turnId": "fixture-turn",
                "item": {
                    "type": "agentMessage",
                    "text": json.dumps(
                        {
                            "outcome": "blocked" if prompt == "missing credential" else "completed",
                            "summary": "Fixture result: " + prompt,
                            "memory": memory,
                        }
                    ),
                },
            },
        )
        emit(
            method="turn/completed",
            params={
                "threadId": "fixture-thread",
                "turn": {"id": "fixture-turn", "status": "completed"},
            },
        )
