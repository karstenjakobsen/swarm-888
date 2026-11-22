"""Owner-installed adapter used only for the authorized Docker recovery acceptance."""

import json
import subprocess
import sys


def engine(*args: str) -> str:
    return subprocess.run(
        ["docker", *args], check=True, capture_output=True, text=True, timeout=8
    ).stdout


def main() -> None:
    action, target = sys.argv[1:]
    raw = json.loads(engine("container", "inspect", target))[0]
    status = raw["State"]["Status"]
    if raw["Id"] != target or not (raw["Config"]["Labels"] or {}).get("swarm.operator.acceptance"):
        print("unsupported")
    elif action == "observe":
        print(
            "running"
            if status == "running"
            else "stopped"
            if status in ("created", "exited")
            else "unsupported"
        )
    elif action == "start" and status in ("created", "exited"):
        engine("container", "start", target)
    else:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
