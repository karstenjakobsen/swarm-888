import os

import uvicorn
from fastapi import FastAPI

from .controller import create_app


def main() -> None:
    # Uvicorn calls the factory after constructing the server. Streams can then
    # finish on its stop signal, before Uvicorn waits for connections to drain.
    def application() -> FastAPI:
        return create_app(shutting_down=lambda: server.should_exit)

    server = uvicorn.Server(
        uvicorn.Config(
            application,
            factory=True,
            host="127.0.0.1",
            port=int(os.environ.get("CONTROLLER_PORT", "8000")),
            timeout_graceful_shutdown=5,
        )
    )
    server.run()


if __name__ == "__main__":
    main()
