import asyncio
import secrets
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from hashlib import sha256
from typing import Annotated, Literal

from fastapi import Depends, FastAPI, Header, HTTPException, Path, Query, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, StreamingResponse

from .catalog import Catalog, CatalogError, display_remote
from .catalog_publish import CatalogPublishing
from .catalog_setup import CatalogSetup
from .config import Settings
from .contracts import (
    ApiError,
    CatalogConnection,
    CatalogInfo,
    CatalogItemWrite,
    CatalogPublishPreview,
    CatalogPublishTips,
    CatalogStatus,
    DockerStart,
    OwnerLogin,
    OwnerMessage,
    OwnerSteer,
    OwnerStop,
    Receipt,
    Snapshot,
    SupplyCredential,
    WorkerStatus,
)
from .credentials import CredentialError, Credentials
from .ipc import wake_worker
from .operations import Operations, OperationUnavailable
from .skill_program import SkillError, SkillRevision
from .skills import Skills
from .state import RequestConflict, State
from .typed_catalogs import TypedCatalogs
from .worker_status import HEARTBEAT_MAX_AGE, read_worker_report

COOKIE = "operator_session"
SESSION_SECONDS = 12 * 60 * 60


def create_app(
    settings: Settings | None = None, *, shutting_down: Callable[[], bool] = lambda: False
) -> FastAPI:
    runtime: Settings
    store: State
    owner_key: bytes
    session_cookie: str

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        nonlocal store, owner_key, runtime, session_cookie
        runtime = settings or Settings.load()
        # Browsers share cookies across ports on the same hostname.
        session_cookie = f"{COOKIE}_{sha256(runtime.origin.encode()).hexdigest()[:16]}"
        with runtime.service_lock("controller"):
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

    @app.exception_handler(CatalogError)
    async def catalog_error(_request: Request, error: CatalogError):
        return JSONResponse({"detail": str(error)}, status_code=409)

    @app.middleware("http")
    async def private_response(request: Request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        return response

    def owner(request: Request) -> str:
        token = request.cookies.get(session_cookie, request.cookies.get(COOKIE, ""))
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
            session_cookie,
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

    @app.post(
        "/api/secrets",
        status_code=204,
        dependencies=[Depends(owner), Depends(same_origin)],
        responses={
            401: unauthorized,
            403: forbidden,
            409: {"model": ApiError, "description": "Credential request unavailable"},
        },
    )
    def supply_credential(body: SupplyCredential) -> None:
        try:
            Credentials(runtime, store).supply(body.request_id, body.value.get_secret_value())
        except CredentialError as exc:
            raise HTTPException(409, str(exc)) from exc
        wake_worker(runtime.socket)

    @app.get("/api/snapshot", dependencies=[Depends(owner)], responses={401: unauthorized})
    def snapshot() -> Snapshot:
        snapshot = store.snapshot()
        if runtime.catalog_config.is_file():
            config = Catalog.load(runtime).config
            snapshot.catalog = CatalogInfo(
                remote=display_remote(config.remote), branch=config.branch
            )
        else:
            bindings = TypedCatalogs(store).bindings()
            if bindings:
                config = bindings[0][1].catalog.config
                snapshot.catalog = CatalogInfo(
                    remote=display_remote(config.remote), branch=config.branch
                )
        return snapshot

    @app.get("/api/catalog", dependencies=[Depends(owner)], responses={401: unauthorized})
    def catalog_status() -> CatalogStatus:
        return CatalogSetup(runtime, store).status()

    catalog_mutation = {
        401: unauthorized,
        403: forbidden,
        409: {"model": ApiError, "description": "Catalog setup could not complete"},
    }

    @app.post(
        "/api/catalog",
        dependencies=[Depends(owner), Depends(same_origin)],
        responses=catalog_mutation,
    )
    def connect_catalog(body: CatalogConnection) -> CatalogStatus:
        setup = CatalogSetup(runtime, store)
        setup.connect(body)
        wake_worker(runtime.socket)
        return setup.status()

    @app.post(
        "/api/catalog/items",
        dependencies=[Depends(owner), Depends(same_origin)],
        responses=catalog_mutation,
    )
    def write_catalog_item(body: CatalogItemWrite) -> CatalogStatus:
        TypedCatalogs(store).write_item(body.kind, body.item, body.definition)
        return CatalogSetup(runtime, store).status()

    @app.post(
        "/api/catalog/branches/{branch_id}/pull",
        dependencies=[Depends(owner), Depends(same_origin)],
        responses=catalog_mutation,
    )
    def pull_catalog_branch(branch_id: str) -> CatalogStatus:
        TypedCatalogs(store).pull(branch_id)
        return CatalogSetup(runtime, store).status()

    @app.get(
        "/api/catalog/branches/{branch_id}/publish",
        dependencies=[Depends(owner)],
        responses={401: unauthorized, 409: catalog_mutation[409]},
    )
    def preview_catalog_publish(branch_id: str) -> CatalogPublishPreview:
        return CatalogPublishing(store).preview(branch_id)

    @app.post(
        "/api/catalog/branches/{branch_id}/publish",
        dependencies=[Depends(owner), Depends(same_origin)],
        responses=catalog_mutation,
    )
    def publish_catalog_branch(branch_id: str, body: CatalogPublishTips) -> CatalogStatus:
        CatalogPublishing(store).publish(branch_id, body)
        return CatalogSetup(runtime, store).status()

    @app.post(
        "/api/catalog/skills/activate",
        dependencies=[Depends(owner), Depends(same_origin)],
        responses=catalog_mutation,
    )
    def activate_catalog_skill(body: SkillRevision) -> CatalogStatus:
        skills = Skills(None, store)
        try:
            skills.test(body.skill, body.revision)
            skills.activate(body.skill, body.revision, owner=True)
        except SkillError as error:
            raise HTTPException(409, str(error)) from None
        return CatalogSetup(runtime, store).status()

    @app.post(
        "/api/catalog/{action}",
        dependencies=[Depends(owner), Depends(same_origin)],
        responses=catalog_mutation,
    )
    def catalog_action(action: Literal["key", "check", "publish"]) -> CatalogStatus:
        setup = CatalogSetup(runtime, store)
        if action == "key":
            setup.generate_key()
        elif action == "check":
            setup.check_read()
        else:
            setup.publish()
        return setup.status()

    @app.get("/api/worker", dependencies=[Depends(owner)], responses={401: unauthorized})
    def worker_status() -> WorkerStatus:
        report = read_worker_report(runtime)
        count = store.queued_tasks()
        if report is None:
            return WorkerStatus(health="unreported", queued_tasks=count, report=None)
        age = (datetime.now(UTC) - report.last_heartbeat).total_seconds()
        return WorkerStatus(
            health="online" if 0 <= age <= HEARTBEAT_MAX_AGE else "stale",
            queued_tasks=count,
            report=report,
        )

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

    @app.post(
        "/api/tasks/{task}/control",
        status_code=204,
        dependencies=[Depends(owner), Depends(same_origin)],
        responses={
            401: unauthorized,
            403: forbidden,
            409: {"model": ApiError, "description": "Task or request conflict"},
        },
    )
    def task_control(
        task: Annotated[str, Path(pattern=r"^[a-f0-9]{32}$")], body: OwnerSteer | OwnerStop
    ):
        try:
            store.control(
                task, body.request_id, body.kind, body.text if isinstance(body, OwnerSteer) else ""
            )
        except RequestConflict as exc:
            raise HTTPException(409, str(exc)) from exc
        wake_worker(runtime.socket)

    @app.post(
        "/api/operations/docker-start",
        status_code=202,
        dependencies=[Depends(owner), Depends(same_origin)],
        responses={
            401: unauthorized,
            403: forbidden,
            409: {"model": ApiError, "description": "Conflicting request or inactive skill"},
        },
    )
    def docker_start(body: DockerStart) -> Receipt:
        try:
            task_id = Operations(store).authorize(body.request_id, body.target, body.skill)
        except (RequestConflict, OperationUnavailable) as exc:
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
