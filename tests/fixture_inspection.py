"""Deterministic authoring and permission fixtures for the Docker walkthrough."""

import json
import re
import sys
from pathlib import Path

FORMAT = '{"name":{{json .Name}},"image":{{json .Config.Image}},"state":{{json .State.Status}},"exitCode":{{json .State.ExitCode}}}'
PS = ["ps", "-aq", "--filter"]
INSPECT = ["inspect", "--type", "container", "--format", FORMAT]
SELECTOR = "swarm.test=fixture"
IDENTITY = "a" * 12

CODE = r"""return function(args)
  local ids = run("docker", "ps", "-aq", "--filter", "label=" .. args.selector)
  local inspect = {"inspect", "--type", "container", "--format", [=[FORMAT]=]}
  for id in ids:gmatch("%S+") do table.insert(inspect, id) end
  if #inspect == 5 then return {} end
  local rows = {}
  for line in run("docker", table.unpack(inspect)):gmatch("[^\n]+") do
    local raw = json_decode(line)
    local row = {name=raw.name:gsub("^/", ""), image=raw.image, state=raw.state}
    if row.state == "exited" then row.exitCode = raw.exitCode end
    table.insert(rows, row)
  end
  table.sort(rows, function(a, b) return a.name < b.name end)
  return rows
end
""".replace("FORMAT", FORMAT)


def inspection_request() -> dict:
    def mocked(argv, stdout):
        return {"dependency": "docker", "argv": argv, "stdout": stdout}

    def test(name, state, exit_code=None):
        listing = mocked([*PS, "label=" + SELECTOR], "" if state is None else IDENTITY)
        expected = []
        commands = [listing]
        if state:
            row = {"name": "fixture", "image": "alpine", "state": state}
            commands.append(
                mocked(
                    [*INSPECT, IDENTITY],
                    json.dumps({**row, "name": "/fixture", "exitCode": exit_code}),
                )
            )
            expected.append({**row, **({"exitCode": exit_code} if state == "exited" else {})})
        return {
            "name": name,
            "arguments": {"selector": SELECTOR},
            "commands": commands,
            "expected": expected,
        }

    return {
        "entrypoint": CODE,
        "definition": {
            "name": "Inspect Docker containers",
            "purpose": "Inspect Docker containers by exact label and report their state.",
            "procedure": ["Select labeled containers, inspect their metadata and sort by name."],
            "program": {
                "source": "executable",
                "entrypoint": "run.lua",
                "dependencies": ["docker"],
                "input_schema": {
                    "type": "object",
                    "properties": {"selector": {"type": "string"}},
                    "required": ["selector"],
                    "additionalProperties": False,
                },
            },
            "tests": [
                test("running", "running", 0),
                test("exited", "exited", 7),
                test("empty", None),
            ],
        },
    }


def write_policy(
    state: Path, executable: str, selector_pattern=r"swarm\.test=[A-Za-z0-9.-]+", ids=None
) -> None:
    pattern = (
        "[a-f0-9]{12,64}"
        if ids is None
        else "|".join(
            re.escape(identity[:12]) + f"({re.escape(identity[12:])})?" for identity in ids
        )
    )
    (state / "skill-dependencies.json").write_text(
        json.dumps(
            {
                "docker": {
                    "executable": executable,
                    "commands": [
                        {
                            "prefix": PS,
                            "tail_pattern": "label=" + selector_pattern,
                            "min_tail": 1,
                            "max_tail": 1,
                        },
                        {
                            "prefix": INSPECT,
                            "tail_pattern": pattern,
                            "min_tail": 1,
                            "max_tail": 128,
                        },
                    ],
                },
            }
        )
    )


if __name__ == "__main__":
    if sys.argv[1] == "request":
        print(
            json.dumps(
                {
                    "query": "docker inspect",
                    "skill": "inspect-docker",
                    "input": "selector",
                    **inspection_request(),
                }
            )
        )
    elif sys.argv[1] == "policy":
        write_policy(Path(sys.argv[2]), sys.argv[3], sys.argv[4], ids=sys.argv[5:])
