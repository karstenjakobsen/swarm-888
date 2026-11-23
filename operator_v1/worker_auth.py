import asyncio
import time
from collections.abc import Awaitable, Callable
from contextlib import suppress
from pathlib import Path

from .contracts import WorkerAuthStatus, WorkerLoginChallenge
from .model import CodexRpc, ModelError, app_server

LOGIN_TIMEOUT = 15 * 60


class WorkerAuth:
    """Run device sign-in in the same environment as model turns."""

    def __init__(
        self,
        directory: Path,
        wake: Callable[[], None],
        wait_until_idle: Callable[[], Awaitable[bool]],
    ):
        self.directory = directory
        self.wake = wake
        self.wait_until_idle = wait_until_idle
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
        can_disconnect: bool = False,
    ) -> None:
        status = WorkerAuthStatus(
            state=state,
            login=login,
            message=message,
            reconnect=self.status.reconnect or state == "ready",
            can_disconnect=can_disconnect,
        )
        if status != self.status:
            self.status = status
            self.wake()

    @staticmethod
    async def read_account(rpc: CodexRpc) -> tuple[bool, bool]:
        result = await rpc.request("account/read", {"refreshToken": False})
        account = result["account"]
        ready = account is not None or result["requiresOpenaiAuth"] is False
        return ready, account is not None and account.get("type") == "chatgpt"

    async def check(self, current: WorkerAuthStatus) -> None:
        try:
            async with asyncio.timeout(8), app_server(self.directory, lambda *_: None) as rpc:
                ready, chatgpt = await self.read_account(rpc)
        except (ModelError, OSError, TimeoutError, ValueError, KeyError):
            if self.status is current:
                self.publish("unavailable", message="Could not check the worker’s Codex session.")
        else:
            if self.status is current:
                self.publish("ready" if ready else "required", can_disconnect=chatgpt)
        finally:
            self.next_check = time.monotonic() + (60 if self.status.state == "ready" else 15)

    def require_reconnect(self) -> None:
        # A local account read can still see the credential that the provider rejected.
        self.rejected = True
        if self.status.state != "disconnecting":
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

    def disconnect(self) -> None:
        if self.status.state != "ready" or not self.status.can_disconnect:
            return
        previous = self.activity if self.busy() else None
        self.publish("disconnecting")
        self.activity = asyncio.create_task(self.sign_out(previous))

    async def sign_out(self, previous: asyncio.Task[None] | None) -> None:
        try:
            if previous:
                await asyncio.shield(asyncio.gather(previous, return_exceptions=True))
            await self.wait_until_idle()
            async with asyncio.timeout(15), app_server(self.directory, lambda *_: None) as rpc:
                # Recheck the account in case its credentials changed since the last probe.
                ready, chatgpt = await self.read_account(rpc)
                if chatgpt:
                    await rpc.request("account/logout", {})
                    ready, chatgpt = await self.read_account(rpc)
                if chatgpt:
                    raise ModelError("Codex still reports a ChatGPT session")
        except (ModelError, OSError, TimeoutError, ValueError, KeyError):
            self.publish(
                "required" if self.rejected else "unavailable",
                message="Could not confirm that Codex signed out.",
            )
        else:
            self.rejected = False
            self.publish("ready" if ready else "required")
        finally:
            self.next_check = time.monotonic() + (60 if self.status.state == "ready" else 15)

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
                        if not notice.get("success"):
                            raise ModelError("Codex did not verify sign-in")
                        _, chatgpt = await self.read_account(rpc)
                        if not chatgpt:
                            raise ModelError("Codex did not verify the ChatGPT account")
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
            self.publish("ready", can_disconnect=True)
        finally:
            self.next_check = time.monotonic() + (60 if self.status.state == "ready" else 15)
