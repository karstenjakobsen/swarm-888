import asyncio
import time
from collections.abc import Callable
from contextlib import suppress
from pathlib import Path

from .contracts import WorkerAuthStatus, WorkerLoginChallenge
from .model import CodexRpc, ModelError, app_server

LOGIN_TIMEOUT = 15 * 60


class WorkerAuth:
    """Run device sign-in in the same environment as model turns."""

    def __init__(self, directory: Path, wake: Callable[[], None]):
        self.directory = directory
        self.wake = wake
        self.status = WorkerAuthStatus(state="checking")
        self.activity: asyncio.Task[None] | None = None
        self.next_check = 0.0
        self.rejected = False

    def tick(self) -> None:
        if self.busy() or time.monotonic() < self.next_check or self.rejected:
            return
        self.activity = asyncio.create_task(self.check(self.status))

    def busy(self) -> bool:
        return self.activity is not None and not self.activity.done()

    def publish(
        self,
        state: str,
        *,
        login: WorkerLoginChallenge | None = None,
        message: str | None = None,
    ) -> None:
        status = WorkerAuthStatus(
            state=state,
            login=login,
            message=message,
            reconnect=self.status.reconnect or state == "ready",
        )
        if status != self.status:
            self.status = status
            self.wake()

    @staticmethod
    async def has_account(rpc: CodexRpc) -> bool:
        account = await rpc.request("account/read", {"refreshToken": False})
        return account["account"] is not None or account["requiresOpenaiAuth"] is False

    async def check(self, current: WorkerAuthStatus) -> None:
        try:
            async with asyncio.timeout(8), app_server(self.directory, lambda *_: None) as rpc:
                ready = await self.has_account(rpc)
        except (ModelError, OSError, TimeoutError, ValueError, KeyError):
            if self.status is current:
                self.publish("unavailable", message="Could not check the worker’s Codex session.")
        else:
            if self.status is current:
                self.publish("ready" if ready else "required")
        finally:
            self.next_check = time.monotonic() + (60 if self.status.state == "ready" else 15)

    def require_reconnect(self) -> None:
        # A local account read can still see the credential that the provider rejected.
        self.rejected = True
        self.publish("required", message="Codex rejected the worker’s saved session.")

    def start(self) -> None:
        if self.status.state not in ("required", "unavailable"):
            return
        previous = self.activity if self.busy() else None
        self.publish("starting")
        self.activity = asyncio.create_task(self.sign_in(previous))

    def cancel(self) -> None:
        if self.status.state in ("starting", "waiting") and self.activity:
            self.next_check = time.monotonic() + 15
            self.publish("required", message="Sign-in canceled.")
            self.activity.cancel()

    async def close(self) -> None:
        if self.busy() and self.activity:
            self.activity.cancel()
            with suppress(asyncio.CancelledError):
                await self.activity

    async def sign_in(self, previous: asyncio.Task[None] | None) -> None:
        notices: asyncio.Queue[dict | None] = asyncio.Queue()

        def receive(method: str, params: dict) -> None:
            if method == "account/login/completed":
                notices.put_nowait(params)
            elif method == "disconnected":
                notices.put_nowait(None)

        try:
            if previous:
                await asyncio.shield(asyncio.gather(previous, return_exceptions=True))
            async with app_server(self.directory, receive, startup_timeout=10) as rpc:
                async with asyncio.timeout(15):
                    result = await rpc.request("account/login/start", {"type": "chatgptDeviceCode"})
                login_id = result["loginId"]
                try:
                    challenge = WorkerLoginChallenge(
                        verification_url=result["verificationUrl"], user_code=result["userCode"]
                    )
                    self.publish("waiting", login=challenge)
                    async with asyncio.timeout(LOGIN_TIMEOUT):
                        while True:
                            notice = await notices.get()
                            if notice is None:
                                raise ModelError("Codex disconnected during sign-in")
                            if notice.get("loginId") == login_id:
                                break
                    async with asyncio.timeout(8):
                        if not notice.get("success") or not await self.has_account(rpc):
                            raise ModelError("Codex did not verify sign-in")
                except (asyncio.CancelledError, TimeoutError):
                    with suppress(ModelError, OSError, TimeoutError):
                        async with asyncio.timeout(2):
                            await rpc.request("account/login/cancel", {"loginId": login_id})
                    raise
        except TimeoutError:
            self.publish("required", message="Sign-in timed out. Try again for a new code.")
        except (ModelError, OSError, ValueError, KeyError):
            self.publish("required", message="ChatGPT sign-in did not complete. Try again.")
        else:
            self.rejected = False
            self.publish("ready")
        finally:
            self.next_check = time.monotonic() + (60 if self.status.state == "ready" else 15)
