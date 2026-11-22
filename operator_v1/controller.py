import asyncio
import secrets
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, StreamingResponse

from .config import Settings
from .contracts import OwnerLogin, OwnerMessage, Receipt, Snapshot
from .state import State
from .worker import wake_worker

COOKIE = "operator_session"
SESSION_SECONDS = 12 * 60 * 60


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.load()

    store: State
    owner_key: bytes

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        nonlocal store, owner_key
        store = State(settings)
        if not settings.owner_key.is_file() or settings.owner_key.stat().st_mode & 0o077:
            raise RuntimeError("Initialize a private owner key with make owner-key")
        owner_key = settings.owner_key.read_bytes().strip()
        if len(owner_key) < 32:
            raise RuntimeError("The owner key must be at least 32 bytes")
        yield

    app = FastAPI(
        title="VPS operator",
        version="1",
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )

    @app.exception_handler(RequestValidationError)
    async def invalid_request(_request: Request, _error: RequestValidationError):
        return JSONResponse({"detail": "Invalid request"}, status_code=422)

    @app.middleware("http")
    async def private_response(request: Request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        return response

    def owner(request: Request) -> str:
        token = request.cookies.get(COOKIE, "")
        if not token or not store.authenticated(token):
            raise HTTPException(401, "Sign in as the owner")
        return token

    def same_origin(request: Request):
        if (
            request.headers.get("origin") != settings.origin
            or request.headers.get("x-operator-action") != "1"
        ):
            raise HTTPException(403, "Same-origin owner action required")

    @app.post("/api/session", status_code=204, dependencies=[Depends(same_origin)])
    def login(body: OwnerLogin, response: Response):
        if not secrets.compare_digest(body.key.get_secret_value().encode(), owner_key):
            raise HTTPException(401, "Invalid owner key")
        response.set_cookie(
            COOKIE,
            store.new_session(SESSION_SECONDS),
            max_age=SESSION_SECONDS,
            path="/api",
            httponly=True,
            samesite="strict",
            secure=settings.origin.startswith("https://"),
        )

    @app.get("/api/session", status_code=204, dependencies=[Depends(owner)])
    def session():
        pass

    @app.get("/api/snapshot", dependencies=[Depends(owner)])
    def snapshot() -> Snapshot:
        return store.snapshot()

    @app.post("/api/commands", status_code=202, dependencies=[Depends(owner), Depends(same_origin)])
    def command(body: OwnerMessage) -> Receipt:
        try:
            task_id = store.submit(body)
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        wake_worker(settings)
        return Receipt(taskId=task_id)

    @app.get(
        "/api/events",
        response_class=StreamingResponse,
        responses={200: {"content": {"text/event-stream": {}}}},
    )
    async def events(
        token: Annotated[str, Depends(owner)],
        after: Annotated[int, Query(ge=0)] = 0,
        last_id: Annotated[int | None, Header(alias="Last-Event-ID", ge=0)] = None,
    ):
        async def stream() -> AsyncIterator[str]:
            cursor = after if last_id is None else last_id
            yield ": connected\n\n"
            idle = 0
            while await run_in_threadpool(store.authenticated, token):
                batch = await run_in_threadpool(store.after, cursor)
                for event in batch:
                    yield f"id: {event.seq}\nevent: op\ndata: {event.model_dump_json()}\n\n"
                    cursor = event.seq
                if batch:
                    idle = 0
                else:
                    idle += 1
                    if idle % 40 == 0:
                        yield ": keepalive\n\n"
                    await asyncio.sleep(0.25)

        return StreamingResponse(stream(), media_type="text/event-stream")

    return app
