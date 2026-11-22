import asyncio
import json
import sys

from .config import Settings
from .model import connect_skills


async def main(query: str = "") -> None:
    async with connect_skills(Settings.load(), None) as session:
        installed = await session.call_tool("skill_discover", {"query": ""})
        matches = await session.call_tool("skill_discover", {"query": query})
        if installed.isError or matches.isError:
            raise SystemExit("Catalog discovery failed")
        print(
            json.dumps(
                {"installed": installed.structuredContent, "matches": matches.structuredContent}
            )
        )


if __name__ == "__main__":
    asyncio.run(main(*sys.argv[1:]))
