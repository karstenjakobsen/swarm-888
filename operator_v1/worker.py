import fcntl
import logging
import os
import socket
from contextlib import closing

from .config import Settings
from .state import State


def wake_worker(settings: Settings):
    # SQLite is the durable queue. Startup and timed reconciliation also find a
    # committed message when a notification is lost or the worker is offline.
    with closing(socket.socket(socket.AF_UNIX)) as client:
        client.settimeout(0.2)
        try:
            client.connect(str(settings.socket))
        except (FileNotFoundError, ConnectionRefusedError, TimeoutError):
            return
        except OSError as error:
            logging.getLogger(__name__).warning("Worker notification failed: %s", error.strerror)


class MessageWorker:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.state = State(settings)

    def drain(self):
        while task := self.state.claim():
            self.state.finish(task, "I received your message.")

    def serve(self):
        path = self.settings.socket
        with (
            (path.parent / "worker.lock").open("a") as lock,
            closing(socket.socket(socket.AF_UNIX)) as server,
        ):
            # Only the lock holder can replace a stale socket or recover running tasks.
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            path.unlink(missing_ok=True)
            server.bind(str(path))
            try:
                path.chmod(0o600)
                server.listen()
                server.settimeout(2)
                while True:
                    self.drain()
                    try:
                        connection, _ = server.accept()
                        connection.close()
                    except TimeoutError:
                        continue
            finally:
                path.unlink(missing_ok=True)


if __name__ == "__main__":
    os.umask(0o077)
    MessageWorker(Settings.load()).serve()
