"""Process-group cleanup for background commands started in their own session."""

import asyncio
import os
import signal
from contextlib import suppress


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
