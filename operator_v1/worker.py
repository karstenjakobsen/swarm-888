import fcntl
import os
import socket
import stat
from contextlib import closing

from .config import Settings
from .state import State


class MessageWorker:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.state = State(settings)

    def drain(self):
        while task := self.state.claim():
            self.state.finish(
                task, "I received your message.", "The worker acknowledged the owner’s message."
            )

    def serve(self):
        path = self.settings.socket
        with (
            (path.parent / "worker.lock").open("a") as lock,
            closing(socket.socket(socket.AF_UNIX)) as server,
        ):
            # Only the lock holder can replace a stale socket or recover running tasks.
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            try:
                mode = path.lstat().st_mode
            except FileNotFoundError:
                pass
            else:
                if not stat.S_ISSOCK(mode):
                    raise FileExistsError(f"Worker socket path is occupied by a non-socket: {path}")
                path.unlink()
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
