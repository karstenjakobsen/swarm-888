import logging
import os
import socket
import tempfile
import time
from datetime import UTC, datetime
from pathlib import Path

from .config import Settings
from .contracts import WorkerReport

HEARTBEAT_INTERVAL = 5
HEARTBEAT_MAX_AGE = 30


def read_worker_report(settings: Settings) -> WorkerReport | None:
    try:
        fd = os.open(
            settings.directory / "worker-status.json", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
        )
        with os.fdopen(fd, "rb") as report:
            return WorkerReport.model_validate_json(report.read(4096))
    except (OSError, ValueError):
        return None


class WorkerHeartbeat:
    def __init__(self, settings: Settings, mode: str):
        self.directory = settings.directory
        release = Path(__file__).resolve().parents[1] / ".framework-revision"
        revision = release.read_text().strip() if release.is_file() else None
        now = datetime.now(UTC)
        self.report = WorkerReport(
            host=socket.gethostname(),
            pid=os.getpid(),
            mode=mode,
            uid=os.geteuid(),
            gid=os.getegid(),
            started_at=now,
            last_heartbeat=now,
            revision=revision,
            active_task=None,
        )
        self.next_beat = 0.0

    def publish(self, task: str | None = None) -> None:
        now = time.monotonic()
        if self.next_beat > now and self.report.active_task == task:
            return
        update = self.report.model_copy(
            update={"last_heartbeat": datetime.now(UTC), "active_task": task}
        )
        try:
            with tempfile.NamedTemporaryFile(dir=self.directory, delete=False) as pending:
                try:
                    if os.geteuid() == 0:
                        owner = self.directory.stat()
                        os.fchown(pending.fileno(), owner.st_uid, owner.st_gid)
                    pending.write(update.model_dump_json().encode())
                    pending.flush()
                    os.replace(pending.name, self.directory / "worker-status.json")
                finally:
                    Path(pending.name).unlink(missing_ok=True)
        except OSError as error:
            logging.getLogger(__name__).warning(
                "Could not publish worker heartbeat: %s", error.strerror
            )
        self.report = update
        self.next_beat = now + HEARTBEAT_INTERVAL
