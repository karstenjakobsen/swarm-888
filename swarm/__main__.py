import argparse
import json
import os
from pathlib import Path

import httpx
import uvicorn

from .backup import export_state, restore_state
from .controller import controller, owner_key
from .runtime import verify_schema
from .state import state_path
from .worker import worker


def main() -> None:
    parser = argparse.ArgumentParser(prog="python -m swarm")
    commands = parser.add_subparsers(dest="command", required=True)
    for key in ("worker", "controller", "owner-key", "verify-protocol"):
        commands.add_parser(key)
    for key in ("backup", "restore"):
        commands.add_parser(key).add_argument("archive", type=Path)
    submit = commands.add_parser("submit")
    submit.add_argument("text")
    attest = commands.add_parser("attest")
    attest.add_argument("call")
    attest.add_argument("expected", type=json.loads)
    attest.add_argument("observation")
    args = parser.parse_args()
    path = state_path()
    match args.command:
        case "owner-key":
            print(owner_key(path))
        case "verify-protocol":
            print(json.dumps(verify_schema(), indent=2))
        case "controller":
            uvicorn.run(
                controller(path),
                host="127.0.0.1",
                port=int(os.getenv("SWARM_PORT", "8880")),
                access_log=False,
            )
        case "worker":
            worker()
        case "backup":
            export_state(path, args.archive)
        case "restore":
            restore_state(args.archive, path)
        case "submit" | "attest":
            params = vars(args).copy()
            method = params.pop("command")
            with httpx.Client(
                transport=httpx.HTTPTransport(uds=str(path / "worker.sock")),
                base_url="http://worker",
            ) as client:
                response = client.post("/rpc", json={"method": method, "params": params})
                response.raise_for_status()
                print(response.json())


if __name__ == "__main__":
    main()
