from __future__ import annotations

import asyncio
import hmac
import os
import secrets
import time
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse, StreamingResponse
from fastapi.templating import Jinja2Templates
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .state import ROOT, encode

templates = Jinja2Templates(directory=ROOT / "swarm/web/templates")


def owner_key(state: Path) -> str:
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    if state.stat().st_mode & 0o077 or state.stat().st_uid != os.getuid():
        raise ValueError("State must be private and owned by the controller user")
    key = state / "controller.key"
    try:
        fd = os.open(key, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        return key.read_text().strip()
    token = secrets.token_urlsafe(32)
    with os.fdopen(fd, "w") as f:
        f.write(token + "\n")
    return token


def controller(state: Path, transport: httpx.AsyncBaseTransport | None = None) -> FastAPI:
    if os.geteuid() == 0:
        raise ValueError("Run the controller as an ordinary user")
    key = owner_key(state)
    sessions = {}
    api = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    api.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost", "[::1]"])

    async def rpc(method: str, **params):
        channel = transport or httpx.AsyncHTTPTransport(uds=str(state / "worker.sock"))
        try:
            async with httpx.AsyncClient(
                transport=channel, base_url="http://worker", timeout=60
            ) as client:
                response = await client.post("/rpc", json={"method": method, "params": params})
        except httpx.HTTPError as exc:
            raise HTTPException(503, "Worker unavailable. Start make worker.") from exc
        if response.is_error:
            raise HTTPException(400, response.json().get("detail", "Worker rejected request"))
        return response.json()

    def session(request: Request) -> str:
        entry = sessions.get(request.cookies.get("operator_session"))
        if not entry or entry[1] < time.monotonic():
            raise HTTPException(401, "Sign in to the operator console")
        return entry[0]

    @api.middleware("http")
    async def security(request: Request, call_next):
        if request.method == "POST":
            origin = request.headers.get("origin")
            if origin and origin != str(request.base_url).rstrip("/"):
                return HTMLResponse("Origin rejected", 403)
            if request.headers.get("sec-fetch-site") == "cross-site":
                return HTMLResponse("Cross-site request rejected", 403)
            length = request.headers.get("content-length", "0")
            if not length.isdecimal() or int(length) > 100000:
                return HTMLResponse("Request too large", 413)
        response = await call_next(request)
        response.headers.update(
            {
                "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
                "X-Content-Type-Options": "nosniff",
                "Referrer-Policy": "same-origin",
                "Cache-Control": "no-store",
            }
        )
        return response

    @api.get("/static/{asset}")
    async def asset(asset: str):
        if asset not in {"console.css", "console.js", "alpine-csp.js"}:
            raise HTTPException(404)
        return FileResponse(ROOT / "swarm/web/static" / asset)

    @api.get("/")
    async def home(request: Request, task: str = ""):
        try:
            csrf = session(request)
        except HTTPException:
            return templates.TemplateResponse(request, "login.html", {})
        summary = await rpc("summary")
        selected = next((r for r in summary["tasks"] if r["id"] == task), None)
        return templates.TemplateResponse(
            request, "home.html", {"state": summary, "selected": selected, "csrf": csrf}
        )

    @api.post("/login")
    async def login(request: Request):
        form = await request.form()
        if not hmac.compare_digest(str(form.get("key", "")).encode(), key.encode()):
            await asyncio.sleep(0.3)
            raise HTTPException(403, "Invalid owner key")
        token = secrets.token_urlsafe(32)
        for old, (_, expiry) in list(sessions.items()):
            if expiry < time.monotonic():
                sessions.pop(old)
        sessions[token] = (secrets.token_urlsafe(32), time.monotonic() + 12 * 3600)
        response = RedirectResponse("/", 303)
        response.set_cookie(
            "operator_session", token, httponly=True, samesite="strict", max_age=43200
        )
        return response

    async def formdata(request: Request) -> dict:
        csrf = session(request)
        form = dict(await request.form())
        if not hmac.compare_digest(csrf.encode(), str(form.pop("csrf", "")).encode()):
            raise HTTPException(403, "Invalid form token")
        return form

    @api.post("/message")
    async def message(request: Request):
        form = await formdata(request)
        task = form.get("task")
        if task:
            await rpc("follow", task=task, text=form.get("text", ""))
        else:
            task = await rpc("submit", text=form.get("text", ""))
        return RedirectResponse("/?task=" + task, 303)

    @api.post("/action/{action}")
    async def action(request: Request, action: str):
        form = await formdata(request)
        if action == "logout":
            sessions.pop(request.cookies.get("operator_session"), None)
            response = RedirectResponse("/", 303)
            response.delete_cookie("operator_session")
            return response
        if action not in ("credential", "stop"):
            raise HTTPException(404)
        await rpc(action, **form)
        return RedirectResponse("/?task=" + form["task"], 303)

    @api.get("/skills/{name}")
    async def skill(request: Request, name: str):
        session(request)
        view = await rpc("skill", key=name)
        return templates.TemplateResponse(request, "skill.html", {"view": view, "name": name})

    @api.get("/artifacts/{revision}")
    async def artifact(request: Request, revision: str):
        session(request)
        if len(revision) != 64 or any(c not in "0123456789abcdef" for c in revision):
            raise HTTPException(404)
        return await rpc("artifact", key=revision)

    @api.get("/activity")
    async def activity(request: Request, after: int = 0, once: bool = False):
        session(request)
        try:
            cursor = max(0, int(request.headers.get("last-event-id", after)))
        except ValueError as exc:
            raise HTTPException(400, "Invalid event cursor") from exc

        async def stream():
            nonlocal cursor
            while not await request.is_disconnected():
                session(request)
                events = await rpc("events", after=cursor)
                for event in events:
                    cursor = event["id"]
                    yield f"id: {cursor}\ndata: {encode(event)}\n\n"
                if once:
                    return
                if len(events) < 100:
                    yield ": keepalive\n\n"
                    await asyncio.sleep(1)

        return StreamingResponse(
            stream(), media_type="text/event-stream", headers={"X-Accel-Buffering": "no"}
        )

    return api
