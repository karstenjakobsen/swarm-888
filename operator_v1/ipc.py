import asyncio
import logging
import socket
from contextlib import closing, suppress
from pathlib import Path
from typing import Literal

from .contracts import WorkerAuthStatus


def wake_worker(path: Path) -> None:
    # SQLite is the durable queue. Startup and timed reconciliation also find a
    # committed message when a notification is lost or the worker is offline.
    with closing(socket.socket(socket.AF_UNIX)) as client:
        client.settimeout(0.2)
        try:
            client.connect(str(path))
        except (FileNotFoundError, ConnectionRefusedError, TimeoutError):
            return
        except OSError as error:
            logging.getLogger(__name__).warning("Worker notification failed: %s", error.strerror)


async def worker_auth(
    path: Path, action: Literal["connect", "cancel", "disconnect", "status"]
) -> WorkerAuthStatus:
    async with asyncio.timeout(2):
        reader, writer = await asyncio.open_unix_connection(str(path), limit=4096)
        try:
            writer.write(f"auth/{action}\n".encode())
            await writer.drain()
            return WorkerAuthStatus.model_validate_json(await reader.readline())
        finally:
            writer.close()
            with suppress(OSError):
                await writer.wait_closed()
