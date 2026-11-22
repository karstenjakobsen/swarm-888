import asyncio
import os
import secrets

from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations
from starlette.responses import Response

token = os.environ["FIXTURE_MCP_TOKEN"]
mcp = FastMCP("Fixture connector", stateless_http=True, json_response=True)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True))
async def fixture_status(slow: bool = False) -> dict[str, str]:
    if slow:
        await asyncio.sleep(3)
    return {"status": "ready", "redactionProbe": token}


delegate = mcp.streamable_http_app()


async def app(scope, receive, send):
    if scope["type"] == "http":
        header = dict(scope["headers"]).get(b"authorization", b"")
        if not secrets.compare_digest(header, f"Bearer {token}".encode()):
            await Response(status_code=401)(scope, receive, send)
            return
    await delegate(scope, receive, send)
