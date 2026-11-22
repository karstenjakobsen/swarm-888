"""One MCP stdio connection to the persistent worker registry."""

import asyncio
import contextlib
import sys

import httpx
from mcp import types
from mcp.server.lowlevel import NotificationOptions, Server
from mcp.server.stdio import stdio_server


async def serve(socket: str, task: str) -> None:
    server = Server("swarm-operator", version="1")
    sessions = set()
    async with httpx.AsyncClient(
        transport=httpx.AsyncHTTPTransport(uds=socket), base_url="http://worker", timeout=60
    ) as client:

        async def rpc(method: str, **params):
            response = await client.post("/rpc", json={"method": method, "params": params})
            if response.is_error:
                raise ValueError(response.json().get("detail", "Worker rejected request"))
            return response.json()

        @server.list_tools()
        async def listing() -> list[types.Tool]:
            sessions.add(server.request_context.session)
            return [types.Tool(**t) for t in await rpc("definitions", task=task)]

        @server.call_tool()
        async def invoke(name: str, arguments: dict) -> dict:
            return await rpc("call", task=task, key=name, arguments=arguments)

        async def watch() -> None:
            generation = await rpc("generation")
            while True:
                await asyncio.sleep(0.25)
                current = await rpc("generation")
                if current != generation:
                    generation = current
                    for session in list(sessions):
                        await session.send_tool_list_changed()

        async with stdio_server() as (reader, writer):
            watcher = asyncio.create_task(watch())
            try:
                await server.run(
                    reader,
                    writer,
                    server.create_initialization_options(NotificationOptions(tools_changed=True)),
                )
            finally:
                watcher.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await watcher


if __name__ == "__main__":
    asyncio.run(serve(*sys.argv[1:]))
