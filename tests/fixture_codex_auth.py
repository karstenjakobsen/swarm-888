import json
import os
import sys
import threading
from pathlib import Path

directory = Path(os.environ["OPERATOR_TEST_CODEX_AUTH_STATE"])
approval = directory / "approve"
session = directory / "codex-session"
output_lock = threading.Lock()
pending: threading.Event | None = None
attempt = 0


def send(message):
    with output_lock:
        print(json.dumps(message), flush=True)


def complete_login(login_id, canceled):
    while not canceled.wait(0.04):
        if approval.exists():
            approval.unlink()
            session.touch()
            send(
                {
                    "method": "account/login/completed",
                    "params": {"loginId": login_id, "success": True},
                }
            )
            return


for line in sys.stdin:
    request = json.loads(line)
    if "id" not in request:
        continue
    result = {}
    method = request["method"]
    if method == "account/read":
        result = {
            "account": {"type": "chatgpt"} if session.exists() else None,
            "requiresOpenaiAuth": True,
        }
    elif method == "account/login/start":
        assert request["params"] == {"type": "chatgptDeviceCode"}
        attempt += 1
        pending = threading.Event()
        result = {
            "type": "chatgptDeviceCode",
            "loginId": f"login-{attempt}",
            "verificationUrl": "https://auth.openai.com/codex/device",
            "userCode": "TEST-1234",
        }
        threading.Thread(
            target=complete_login, args=(result["loginId"], pending), daemon=True
        ).start()
    elif method == "account/login/cancel":
        assert pending is not None
        pending.set()
        result = {"status": "canceled"}
    elif method == "thread/start":
        result = {"thread": {"id": "thread"}}
    elif method == "turn/start":
        result = {"turn": {"id": "turn"}}
    send({"id": request["id"], "result": result})
    if method == "turn/start":
        turn = {"id": "turn", "status": "failed", "error": {"codexErrorInfo": "unauthorized"}}
        if session.exists():
            send(
                {
                    "method": "item/agentMessage/delta",
                    "params": {
                        "threadId": "thread",
                        "turnId": "turn",
                        "itemId": "answer",
                        "delta": "The signed-in worker handled the queued task.",
                    },
                }
            )
            turn = {"id": "turn", "status": "completed"}
        send({"method": "turn/completed", "params": {"threadId": "thread", "turn": turn}})
