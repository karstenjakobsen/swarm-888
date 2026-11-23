"""Execute pinned Lua skills with an owner-configured argv interface."""

import json
import os
import re
import subprocess
import sys
from collections import deque
from importlib import import_module
from pathlib import Path
from tempfile import TemporaryFile
from typing import Any

from jsonschema import Draft202012Validator
from pydantic import Field, JsonValue, ValidationError

from .skill_program import ExecutableProgram, ExecutableTest, SkillDefinition, SkillError
from .tool_types import ToolArguments

OUTPUT_LIMIT = 1024 * 1024
lua54 = import_module("lupa.lua54")


class CommandRule(ToolArguments):
    prefix: list[str] = Field(min_length=1)
    tail_pattern: str = ""
    min_tail: int = Field(default=0, ge=0, le=128)
    max_tail: int = Field(default=0, ge=0, le=128)

    def accepts(self, argv: list[str]) -> bool:
        tail = argv[len(self.prefix) :]
        return (
            argv[: len(self.prefix)] == self.prefix
            and self.min_tail <= len(tail) <= self.max_tail
            and all(re.fullmatch(self.tail_pattern, arg) for arg in tail)
        )


class Dependency(ToolArguments):
    executable: Path
    commands: list[CommandRule] = Field(min_length=1, max_length=32)


def load_dependencies(path: Path) -> dict[str, Dependency]:
    if not path.exists():
        return {}
    try:
        return {
            name: Dependency.model_validate(policy)
            for name, policy in json.loads(path.read_text()).items()
        }
    except (OSError, ValueError, AttributeError):
        raise SkillError("Invalid owner dependency policy") from None


def run_command(dependency: Dependency, argv: list[str]) -> str:
    if not dependency.executable.is_absolute() or not any(
        rule.accepts(argv) for rule in dependency.commands
    ):
        raise SkillError("Command is outside the owner-authorized dependency policy")
    try:
        with TemporaryFile() as out:
            subprocess.run(
                [str(dependency.executable), *argv],
                check=True,
                timeout=8,
                stdin=subprocess.DEVNULL,
                stdout=out,
                stderr=subprocess.DEVNULL,
                cwd="/",
                env={"PATH": os.defpath, "LANG": "C.UTF-8"},
            )
            out.seek(0)
            output = out.read(OUTPUT_LIMIT + 1)
    except (OSError, subprocess.SubprocessError):
        raise SkillError("Runtime dependency failed or timed out") from None
    if len(output) > OUTPUT_LIMIT:
        raise SkillError("Runtime dependency output exceeds the limit")
    return output.decode()


def deny_attribute(_object, _name, _writing):
    raise AttributeError("Host object access is unavailable")


def lua_result(value: Any, depth: int = 0) -> JsonValue:
    if depth > 32:
        raise SkillError("Skill result exceeds the maximum nesting depth")
    if lua54.lua_type(value) != "table":
        if value is None or isinstance(value, (str, int, float, bool)):
            return value
        raise SkillError("Skill result is not JSON data")
    keys = list(value.keys())
    if all(type(key) is int for key in keys) and sorted(keys) == list(range(1, len(keys) + 1)):
        return [lua_result(value[index], depth + 1) for index in range(1, len(keys) + 1)]
    if all(isinstance(key, str) for key in keys):
        return {key: lua_result(value[key], depth + 1) for key in keys}
    raise SkillError("Skill result must contain string-keyed objects or contiguous arrays")


def execute(
    program: ExecutableProgram,
    code: str,
    arguments: dict,
    *,
    policy,
    test=None,
    task=None,
    settings=None,
) -> JsonValue:
    if not Draft202012Validator(program.input_schema).is_valid(arguments):
        raise SkillError("Skill arguments do not match this revision's schema")
    lua = lua54.LuaRuntime(
        register_eval=False,
        register_builtins=False,
        attribute_filter=deny_attribute,
        max_memory=8 * 1024 * 1024,
    )
    environment = lua.table()
    for name in (
        "assert",
        "error",
        "ipairs",
        "pairs",
        "next",
        "select",
        "tonumber",
        "tostring",
        "type",
        "math",
        "string",
        "table",
        "utf8",
    ):
        environment[name] = lua.globals()[name]
    pending = deque(test.commands) if test else deque()
    calls = 0

    def run(name, *argv):
        nonlocal calls
        calls += 1
        if (
            calls > 16
            or name not in program.dependencies
            or len(argv) > 140
            or any(not isinstance(arg, str) or len(arg) > 1024 or "\0" in arg for arg in argv)
        ):
            raise SkillError("Invalid or excessive dependency calls")
        if test:
            if not pending:
                raise SkillError("Unexpected command in self-test")
            expected = pending.popleft()
            if name != expected.dependency or list(argv) != expected.argv:
                raise SkillError("Command did not match the self-test")
            return expected.stdout
        if name in ("connector", "host-admin"):
            if not task or not settings:
                raise SkillError("A delegated call requires an owner task")
            from .admin import HostCall, invoke_host
            from .connectors import ConnectorInvoke, ConnectorService
            from .state import State

            state = State(settings)
            if state.stopped(task):
                raise SkillError("The owner stopped this task")
            if name == "host-admin" and argv:
                return json.dumps(
                    invoke_host(state, task, HostCall(operation=argv[0], argv=list(argv[1:])))
                )
            if name == "connector" and len(argv) == 3:
                call = ConnectorInvoke(
                    connector=argv[0], operation=argv[1], arguments=json.loads(argv[2])
                )
                return json.dumps(
                    ConnectorService(None, state, task).read(call, operation=call.operation)[
                        "result"
                    ]
                )
            raise SkillError("Invalid delegated operation arguments")
        if name not in policy:
            raise SkillError(f"Runtime dependency {name} is not configured")
        return run_command(policy[name], list(argv))

    environment["run"] = run
    environment["json_decode"] = lambda value: lua.table_from(json.loads(value), recursive=True)
    compile_entry = lua.eval(
        "function(code, env) return assert(load(code, '@run.lua', 't', env)) end"
    )
    entry = compile_entry(code, environment)()
    if lua54.lua_type(entry) != "function":
        raise SkillError("Entry point must return a function")
    result = lua_result(entry(lua.table_from(arguments, recursive=True)))
    if pending:
        raise SkillError("Self-test did not exercise all expected commands")
    return result


def main() -> None:
    request = json.load(sys.stdin)
    revision = Path(request["path"])
    data = json.loads((revision / "skill.json").read_text())
    tests_file = revision / "tests.json"
    if tests_file.is_file():
        data["tests"] = json.loads(tests_file.read_text())
    definition = SkillDefinition.model_validate(data)
    program = definition.program
    if isinstance(program, ExecutableProgram):
        code = (revision / program.entrypoint).read_text()
    if request["action"] == "test":
        result = []
        for test in definition.tests:
            error = None
            actual = None
            try:
                if isinstance(program, ExecutableProgram) and isinstance(test, ExecutableTest):
                    actual = execute(program, code, test.arguments, policy={}, test=test)
                elif not isinstance(program, ExecutableProgram) and not isinstance(
                    test, ExecutableTest
                ):
                    actual = program.evaluate(test.rows)
                else:
                    raise SkillError("Self-test does not match the program type")
            except (SkillError, KeyError, TypeError, ValueError, lua54.LuaError) as exc:
                error = str(exc)[:300]
            result.append(
                {
                    "name": test.name,
                    "rows": test.arguments if isinstance(test, ExecutableTest) else test.rows,
                    "passed": error is None and actual == test.expected,
                    "expected": test.expected,
                    "actual": actual,
                    "error": error,
                }
            )
    elif isinstance(program, ExecutableProgram):
        from .config import Settings

        policy_path = Path(request["policy"])
        result = execute(
            program,
            code,
            request["arguments"],
            policy=load_dependencies(policy_path),
            task=request.get("task"),
            settings=Settings(policy_path.parent),
        )
    else:
        raise SkillError("File-mode skills run through an authorized standing goal")
    json.dump({"result": result}, sys.stdout, allow_nan=False)


if __name__ == "__main__":
    try:
        main()
    except (ValidationError, OSError, ValueError, TypeError, SkillError, lua54.LuaError) as error:
        json.dump({"error": str(error)[:500]}, sys.stdout)
