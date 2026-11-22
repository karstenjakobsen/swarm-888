import asyncio
import secrets
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, StreamingResponse

from .config import Settings
from .contracts import ApiError, OwnerLogin, OwnerMessage, Receipt, Snapshot
from .ipc import wake_worker
from .state import RequestConflict, State

COOKIE = "operator_session"
SESSION_SECONDS = 12 * 60 * 60


def create_app(
    settings: Settings | None = None, *, shutting_down: Callable[[], bool] = lambda: False
) -> FastAPI:
    runtime: Settings
    store: State
    owner_key: bytes

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        nonlocal store, owner_key, runtime
        runtime = settings or Settings.load()
        owner_key = runtime.read_owner_key()
        store = State(runtime)
        yield

    app = FastAPI(
        title="VPS operator",
        version="1",
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        responses={422: {"model": ApiError, "description": "Invalid request"}},
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
            request.headers.get("origin") != runtime.origin
            or request.headers.get("x-operator-action") != "1"
        ):
            raise HTTPException(403, "Same-origin owner action required")

    unauthorized = {"model": ApiError, "description": "Owner authentication required"}
    forbidden = {"model": ApiError, "description": "Same-origin owner action required"}

    @app.post(
        "/api/session",
        status_code=204,
        dependencies=[Depends(same_origin)],
        responses={401: unauthorized, 403: forbidden},
    )
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
            secure=runtime.origin.startswith("https://"),
        )

    @app.get(
        "/api/session",
        status_code=204,
        dependencies=[Depends(owner)],
        responses={401: unauthorized},
    )
    def session():
        pass

    @app.get("/api/snapshot", dependencies=[Depends(owner)], responses={401: unauthorized})
    def snapshot() -> Snapshot:
        return store.snapshot()

    @app.post(
        "/api/commands",
        status_code=202,
        dependencies=[Depends(owner), Depends(same_origin)],
        responses={
            401: unauthorized,
            403: forbidden,
            409: {"model": ApiError, "description": "Conflicting request ID"},
        },
    )
    def command(body: OwnerMessage) -> Receipt:
        try:
            task_id = store.submit(body.request_id, body.text)
        except RequestConflict as exc:
            raise HTTPException(409, str(exc)) from exc
        wake_worker(runtime.socket)
        return Receipt(task_id=task_id)

    @app.get(
        "/api/events",
        response_class=StreamingResponse,
        responses={
            200: {"content": {"text/event-stream": {"schema": {"type": "string"}}}},
            401: unauthorized,
        },
    )
    async def events(
        token: Annotated[str, Depends(owner)],
        after: Annotated[int, Query(ge=0, le=2**63 - 1)] = 0,
        epoch: str | None = None,
        last_id: Annotated[int | None, Header(alias="Last-Event-ID", ge=0, le=2**63 - 1)] = None,
    ):
        async def stream() -> AsyncIterator[str]:
            cursor = after if last_id is None else last_id
            identity, head = await run_in_threadpool(store.stream_head)
            if cursor > head or (epoch is not None and epoch != identity):
                yield "event: reset\ndata: {}\n\n"
                return
            yield ": connected\n\n"
            catching_up = True
            idle = 0
            while not shutting_down() and await run_in_threadpool(store.authenticated, token):
                if catching_up and cursor >= head:
                    yield f"event: caught-up\ndata: {cursor}\n\n"
                    catching_up = False
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
