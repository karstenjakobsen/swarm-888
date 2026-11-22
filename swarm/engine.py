import asyncio
import logging
import threading

from . import catalog, codex, mesh
from .store import BlockedTask


class Engine:
    def __init__(self, store, count, executable, run_timeout=1800):
        self.store, self.count, self.executable = store, count, executable
        self.run_timeout = run_timeout
        self.stopping = threading.Event()
        self.thread = threading.Thread(target=self._thread, name="worker-supervisor")

    def start(self):
        self.store.recover()
        self.thread.start()

    def stop(self):
        self.stopping.set()
        self.thread.join()

    def _thread(self):
        asyncio.run(self._supervise())

    async def _supervise(self):
        workers = [
            asyncio.create_task(self._worker(f"worker-{i + 1:02d}")) for i in range(self.count)
        ]
        try:
            while not self.stopping.is_set():
                await asyncio.sleep(0.2)
        finally:
            for w in workers:
                w.cancel()
            await asyncio.gather(*workers, return_exceptions=True)

    async def _worker(self, name):
        while True:
            job = None
            try:
                job = self.store.claim(name)
                if not job:
                    await asyncio.sleep(0.45)
                    continue
                self.store.event(job["id"], f"Assigned to {name}")
                async with asyncio.timeout(self.run_timeout):
                    result = await self._run(job)
                self.store.finish(job, "completed", result)
            except BlockedTask as exc:
                self.store.finish(job, "blocked", str(exc)[:2000])
            except TimeoutError:
                if job:
                    self.store.finish(
                        job,
                        "failed",
                        "Run exceeded its time limit. Inspect the workspace before retrying.",
                    )
            except asyncio.CancelledError:
                # Running rows are reconciled after restart while holding the exclusive instance lock.
                raise
            except Exception as exc:
                if job:
                    message = str(exc)[:2000] or type(exc).__name__
                    self.store.finish(job, "failed", message)
                else:
                    logging.exception("Unable to claim work")
                    await asyncio.sleep(1)

    async def _run(self, job):
        if job["target"]:
            return await mesh.delegate(self.store, job)
        if job["kind"] in ("import", "publish"):
            return await catalog.operate(self.store, job)
        project = self.store.project(job["project"])
        if project["repo"] and not project["revision"]:
            raise ValueError(
                "Catalog import is incomplete. Retry the import before running this task."
            )
        workspace = self.store.workspace(project["id"])
        for sub in catalog.ROOTS:
            folder = workspace / sub
            if folder.resolve() != folder:
                raise ValueError("Catalog directories must stay inside the workspace")
            folder.mkdir(exist_ok=True, parents=True)
        self.store.event(job["id"], "Connecting to Codex")
        return await codex.run(self.store, job, self.executable)
