import asyncio
import json

from .config import Settings
from .model import connect_skills


async def main() -> None:
    async with connect_skills(Settings.load(), None) as session:
        installed = await session.call_tool("skill_discover", {"query": ""})
        docker = await session.call_tool("skill_discover", {"query": "docker"})
        if installed.isError or docker.isError:
            raise SystemExit("Catalog discovery failed")
        print(
            json.dumps(
                {"installed": installed.structuredContent, "docker": docker.structuredContent}
            )
        )


if __name__ == "__main__":
    asyncio.run(main())
