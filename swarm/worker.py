from __future__ import annotations

import asyncio
import contextlib
import inspect
import os
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from .application import Application
from .catalog import Catalog
from .runtime import CodexRuntime
from .state import State, exclusive, state_path


class RPC(BaseModel):
    method: str
    params: dict = {}


def service(app: Application, schedule: bool = True) -> FastAPI:
    @asynccontextmanager
    async def lifespan(_):
        app.recover()
        runner = asyncio.create_task(app.loop()) if schedule else None
        try:
            yield
        finally:
            if runner:
                runner.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await runner

    api = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    methods = {
        "summary": app.summary,
        "events": app.state.events,
        "submit": app.submit,
        "stop": app.stop,
        "follow": app.follow,
        "credential": app.credential,
        "skill": app.skill_view,
        "artifact": app.artifact,
        "attest": app.catalog.attest,
        "generation": lambda: app.state.one("SELECT coalesce(max(id),0) AS v FROM activations")[
            "v"
        ],
        "definitions": lambda task: app.tools(task).definitions(),
        "call": lambda task, key, arguments: app.tools(task).call(key, arguments),
    }

    @api.post("/rpc")
    async def dispatch(request: RPC):
        if request.method not in methods:
            raise HTTPException(404, "Unknown method")
        method = methods[request.method]
        try:
            if inspect.iscoroutinefunction(method):
                return await method(**request.params)
            return await asyncio.to_thread(method, **request.params)
        except (ValueError, KeyError, TypeError, OSError) as exc:
            raise HTTPException(400, app.state.redact(str(exc))[:800]) from exc

    return api


def build() -> Application:
    s = State(state_path())
    path = os.environ.get("SWARM_CATALOG")
    cat = Catalog(
        s,
        Path(path) if path else None,
        os.getenv("SWARM_REMOTE", ""),
        os.getenv("SWARM_BRANCH", "main"),
    )
    return Application(s, cat, CodexRuntime())


def worker() -> None:
    os.umask(0o077)
    if os.geteuid() == 0:
        raise SystemExit("Start the development worker as its dedicated ordinary user")
    path = state_path()
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    with exclusive(path / "worker.lock"):
        app = build()
        if app.maintenance.host.channel:
            app.maintenance.host.channel.set_inheritable(False)
        sock = path / "worker.sock"
        # Uvicorn chmods pathname sockets to 0666. Bind explicitly inside the private state directory.
        import socket

        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
            if sock.is_socket():
                sock.unlink()
            server.bind(str(sock))
            sock.chmod(0o600)
            server.listen(64)
            try:
                uvicorn.Server(
                    uvicorn.Config(service(app), access_log=False, log_level="warning")
                ).run(sockets=[server])
            finally:
                sock.unlink(missing_ok=True)
