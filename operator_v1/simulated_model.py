import json
import os
import re
from pathlib import Path
from typing import Any
from uuid import uuid4

from mcp import ClientSession

from .model import ModelError, Turn


class SimulatedModel:
    """Drive the acceptance scenarios deterministically through the public MCP tools."""

    def __init__(self, session: ClientSession):
        self.session = session
        self.messages: dict[Turn, str] = {}

    async def call(self, name: str, **arguments: Any) -> dict:
        response = await self.session.call_tool(name, arguments)
        if response.isError or response.structuredContent is None:
            raise ModelError(f"Simulated model could not call {name}: {response.content}")
        return response.structuredContent

    async def start(self, text: str) -> Turn:
        return await self.resume(uuid4().hex, text)

    async def resume(self, thread_id: str, text: str) -> Turn:
        turn = Turn(thread_id, uuid4().hex)
        self.messages[turn] = text
        return turn

    async def steer(self, turn: Turn, text: str) -> None:
        self.messages[turn] = text

    async def interrupt(self, turn: Turn) -> None:
        self.messages.pop(turn, None)

    async def result(self, turn: Turn) -> str:
        text = self.messages.pop(turn, "")
        if project := re.fullmatch(r"Read project ([a-z][a-z0-9-]*)", text):
            result = await self.call("project_read", project=project[1])
            return result["description"]
        if goal := re.fullmatch(r"Maintain fixture ([a-zA-Z0-9_.-]+) at mode ([0-7]{3})", text):
            skill = "fixture-mode"
            listing = await self.call("skill_discover", query=skill)
            if not listing["skills"]:
                mode = goal[2]
                candidate = await self.call(
                    "skill_scaffold",
                    skill=skill,
                    definition={
                        "name": "Maintain fixture mode",
                        "purpose": "Check and repair the mode of a test-owned file.",
                        "procedure": ["Read the mode.", "Apply the authorized mode and verify it."],
                        "program": {"source": "file.mode"},
                        "tests": [
                            {
                                "name": "requested fixture mode",
                                "rows": [{"expectedMode": mode}],
                                "expected": [{"mode": mode}],
                            }
                        ],
                    },
                )
                await self.call("skill_test", **candidate)
                await self.call("skill_activate", **candidate)
            result = await self.call(
                "goal_create", filename=goal[1], mode=goal[2], skill=skill, interval=2
            )
            return f"Created standing goal {result['goal']}."
        if connection := re.fullmatch(r"Read connector ([a-z][a-z0-9-]*)( slowly)?", text):
            result = await self.call(
                "connector_read", connector=connection[1], arguments={"slow": bool(connection[2])}
            )
            return json.dumps(result["result"])
        if text.startswith("Remember fixture port: "):
            value = text.removeprefix("Remember fixture port: ")
            await self.call(
                "memory_write", title="Fixture port", kind="fact", scope="fixture", text=value
            )
            return value
        if correction := re.fullmatch(r'Correct memory ".*" \(([a-f0-9]{32})\): (.+)', text):
            memory = await self.call(
                "memory_read", memory=correction[1], reason="Owner asked for a correction."
            )
            await self.call(
                "memory_revise",
                memory=correction[1],
                expected_revision=memory["revision"],
                text=correction[2],
            )
            return correction[2]
        if text == "What is the fixture port you remember?":
            matches = await self.call("memory_search", scope="fixture", query="fixture port")
            memory = await self.call(
                "memory_read",
                memory=matches["matches"][0]["memory"],
                reason="Owner asked for a reminder.",
            )
            return memory["text"]
        selectors = re.findall(r"`([a-zA-Z][a-zA-Z0-9_.-]+=[a-zA-Z0-9_.-]+)`", text)
        if not selectors:
            raise ModelError("The simulated authoring task needs an input selector")
        path = os.environ.get("OPERATOR_SIMULATED_SKILL")
        if not path:
            raise ModelError("Configure a simulated authoring fixture")
        fixture = json.loads(Path(path).read_text())
        query, skill, parameter = (fixture.pop(key) for key in ("query", "skill", "input"))
        discovery = await self.call("skill_discover", query=query)
        if discovery["skills"]:
            skill = discovery["skills"][0]["skill"]
        else:
            await self.call("skill_authoring_guide")
            candidate = await self.call("skill_scaffold", skill=skill, **fixture)
            await self.call("skill_test", **candidate)
            await self.call("skill_activate", **candidate)
        name = "run_" + skill
        if name not in {tool.name for tool in (await self.session.list_tools()).tools}:
            raise ModelError("The newly activated named tool was not discoverable")
        results = {}
        for selector in dict.fromkeys(selectors):
            results[selector] = (await self.call(name, **{parameter: selector}))["result"]
        return json.dumps(results, indent=2)
