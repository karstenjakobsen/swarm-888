"""One Codex App Server stdio session per active run; the thread survives the process."""

import asyncio
import json
import os
import signal
from contextlib import suppress

from .store import BlockedTask

OUTCOME_SCHEMA = {
    "type": "object",
    "properties": {
        "outcome": {"type": "string", "enum": ["completed", "blocked", "failed"]},
        "summary": {"type": "string"},
    },
    "required": ["outcome", "summary"],
    "additionalProperties": False,
}

INSTRUCTIONS = """You are a local project worker. Complete the user's task in the current workspace.
Keep reusable projects in projects/, Codex skills in .agents/skills/, and connector code in connectors/.
Read MEMORY.md when present for durable project facts. Update it when decisions or verified state change.
Use the project's existing files and conversation for continuity. Verify changes before reporting completion.
Report completed only after verifying the requested result. Report blocked when a dependency or unavailable tool prevents completion.
Credentials belong outside source files and chat. Explain any external dependency that prevents completion."""


async def stop_process(proc):
    if proc.returncode is not None:
        return
    with suppress(ProcessLookupError):
        os.killpg(proc.pid, signal.SIGTERM)
    try:
        await asyncio.wait_for(proc.wait(), 3)
    except TimeoutError:
        with suppress(ProcessLookupError):
            os.killpg(proc.pid, signal.SIGKILL)
        await proc.wait()


async def run(store, job, executable):
    project = store.project(job["project"])
    cwd = str(store.workspace(project["id"]))
    env = os.environ.copy()
    api_key = env.pop("OPENAI_API_KEY", None)
    proc = await asyncio.create_subprocess_exec(
        executable,
        "app-server",
        "--listen",
        "stdio://",
        cwd=cwd,
        env=env,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
        limit=16 * 1024 * 1024,
        start_new_session=True,
    )

    async def send(method, params, ident=None):
        msg = {"method": method, "params": params}
        if ident is not None:
            msg["id"] = ident
        proc.stdin.write(json.dumps(msg).encode() + b"\n")
        await proc.stdin.drain()

    async def start_thread():
        params = {
            "cwd": cwd,
            "sandbox": "workspace-write",
            "approvalPolicy": "never",
            "developerInstructions": INSTRUCTIONS,
        }
        method = "thread/start"
        if project["thread"]:
            method = "thread/resume"
            params["threadId"] = project["thread"]
        await send(method, params, 3)

    thread = turn = final = ""
    try:
        await send(
            "initialize",
            {"clientInfo": {"name": "swarm888", "title": "Swarm 888", "version": "0.1.0"}},
            1,
        )
        while line := await proc.stdout.readline():
            msg = json.loads(line)
            ident, method = msg.get("id"), msg.get("method", "")
            if method and ident is not None:
                # Unattended runs never grant permissions or solicit interactive user input.
                proc.stdin.write(
                    json.dumps(
                        {
                            "id": ident,
                            "error": {"code": -32601, "message": "Interactive request unavailable"},
                        }
                    ).encode()
                    + b"\n"
                )
                await proc.stdin.drain()
                continue
            if "error" in msg and ident is not None:
                raise RuntimeError(str(msg["error"].get("message", "Codex request failed"))[:1200])
            res, p = msg.get("result") or {}, msg.get("params") or {}
            if ident == 1:
                await send("initialized", {})
                if api_key:
                    await send("account/login/start", {"type": "apiKey", "apiKey": api_key}, 2)
                else:
                    await start_thread()
            elif ident == 2:
                await start_thread()
            elif ident == 3:
                thread = res["thread"]["id"]
                store.update("UPDATE projects SET thread=? WHERE id=?", (thread, project["id"]))
                # A crash after Codex finished but before SQLite committed must not repeat the turn.
                for old in res["thread"].get("turns") or []:
                    if old.get("id") == job["turn"] and old.get("status") == "completed":
                        return outcome(answer(old.get("items", [])))
                prompt = job["prompt"]
                if job["attempts"] > 1:
                    prompt = (
                        "An earlier attempt was interrupted. Inspect the workspace and previous turn first. "
                        "Verify completed work and continue only the outstanding steps.\n\n"
                        + prompt
                    )
                await send(
                    "turn/start",
                    {
                        "threadId": thread,
                        "input": [{"type": "text", "text": prompt}],
                        "outputSchema": OUTCOME_SCHEMA,
                    },
                    4,
                )
            elif ident == 4:
                turn = res["turn"]["id"]
                store.update("UPDATE jobs SET turn=? WHERE id=?", (turn, job["id"]))
            elif p.get("threadId") == thread and thread:
                if method.startswith("item/") and p.get("turnId") == turn and turn:
                    item = p.get("item") or {}
                    if method == "item/started":
                        label = {
                            "commandExecution": "Running a workspace command",
                            "fileChange": "Editing files",
                            "mcpToolCall": "Calling a connector",
                            "webSearch": "Searching the web",
                        }.get(item.get("type"))
                        if label:
                            store.event(job["id"], label)
                    elif method == "item/completed" and item.get("type") == "agentMessage":
                        final = item.get("text", "")
                elif (
                    method == "turn/completed" and (p.get("turn") or {}).get("id") == turn and turn
                ):
                    done = p["turn"]
                    if done.get("status") != "completed":
                        raise RuntimeError(
                            (done.get("error") or {}).get("message")
                            or "Codex turn " + str(done.get("status"))
                        )
                    return outcome(final or answer(done.get("items") or []))
        raise RuntimeError(
            "Codex disconnected before completing the run. Check Codex authentication and version."
        )
    finally:
        proc.stdin.close()
        await stop_process(proc)


def answer(items):
    return next(
        (item.get("text", "") for item in reversed(items) if item.get("type") == "agentMessage"),
        "Codex completed the turn.",
    )


def outcome(raw):
    try:
        response = json.loads(raw)
        status, summary = response["outcome"], response["summary"]
        if not isinstance(summary, str) or not summary.strip():
            raise ValueError()
    except ValueError, KeyError, TypeError:
        raise RuntimeError("Codex ended without a valid task outcome.") from None
    if status == "blocked":
        raise BlockedTask(summary)
    if status != "completed":
        raise RuntimeError(summary)
    return summary[:64000]
