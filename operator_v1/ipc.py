import logging
import socket
from contextlib import closing
from pathlib import Path


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
