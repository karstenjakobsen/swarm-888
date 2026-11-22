#!/usr/bin/python3
"""Record only executions of the deliberately harmless acceptance command."""

import sys
from pathlib import Path

if len(sys.argv) != 2:
    raise SystemExit(2)
with Path("/var/lib/swarm-operator/state/acceptance-dispatches.txt").open("a") as log:
    log.write(sys.argv[1] + "\n")
print(sys.argv[1], end="")
