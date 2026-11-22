from __future__ import annotations

import asyncio
import contextlib
import inspect
import os
import socket
from collections.abc import Callable
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import Field, ValidationError

from .application import Application
from .catalog import Catalog
from .contracts import Contract, input_contract
from .runtime import CodexRuntime
from .state import State, exclusive, state_path


class RPC(Contract):
    method: str
    params: dict[str, Any] = Field(default_factory=dict)


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

    @api.exception_handler(RequestValidationError)
    async def invalid_request(_request, _exc):
        # FastAPI's default validation response includes the rejected request body.
        return JSONResponse({"detail": "Supply an RPC method and a parameters object"}, 422)

    def definitions(task: str) -> list[dict]:
        return app.tools(task).definitions()

    def call(task: str, key: str, arguments: dict) -> dict:
        return app.tools(task).call(key, arguments)

    handlers: dict[str, Callable[..., Any]] = {
        "summary": app.summary,
        "task": app.task_summary,
        "events": app.state.events,
        "submit": app.submit,
        "stop": app.stop,
        "follow": app.follow,
        "credential": app.credential,
        "skill": app.skill_view,
        "artifact": app.artifact,
        "attest": app.catalog.attest,
        "generation": app.catalog.generation,
        "definitions": definitions,
        "call": call,
    }
    contracts = {name: input_contract(handler) for name, handler in handlers.items()}

    @api.post("/rpc")
    async def dispatch(request: RPC):
        if request.method not in handlers:
            raise HTTPException(404, "Unknown method")
        method = handlers[request.method]
        try:
            contracts[request.method].model_validate(request.params, strict=True)
        except ValidationError as exc:
            # Unknown field names and invalid values can both contain credentials.
            fields = contracts[request.method].model_fields
            errors = exc.errors(include_input=False, include_context=False, include_url=False)
            detail = ", ".join(
                f"{e['loc'][0]}: {e['type']}" if e["loc"] and e["loc"][0] in fields else e["type"]
                for e in errors
            )
            raise HTTPException(
                400, f"Invalid {request.method} parameters: {detail[:500]}"
            ) from exc
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
