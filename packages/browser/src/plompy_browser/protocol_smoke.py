"""Opt-in real MCP/browser smoke on a neutral public page; performs no account actions."""
from __future__ import annotations

import asyncio
import json
import os
import sys

from mcp import Client
from mcp.client.stdio import StdioServerParameters


async def run() -> dict:
    parameters = StdioServerParameters(command=sys.executable, args=["-m", "plompy_browser"], env=dict(os.environ))
    async with Client(parameters, read_timeout_seconds=60) as client:
        tools = await client.list_tools()
        opened = await client.call_tool("browser_open", {"url": "https://example.com"})
        data = opened.structured_content
        if not data or data.get("ok") is False or "tab" not in data:
            raise RuntimeError("browser open failed: " + json.dumps(data))
        tab = data["tab"]
        first = (await client.call_tool("browser_snapshot", {"tab": tab})).structured_content
        second = (await client.call_tool("browser_snapshot", {"tab": tab})).structured_content
        if not first or not second or not first.get("elements") or first.get("ok") is False or second.get("ok") is False:
            raise RuntimeError("browser snapshot did not return observed elements")
        first_refs = [item["ref"] for item in first["elements"]]
        second_refs = [item["ref"] for item in second["elements"]]
        if first_refs != second_refs:
            raise RuntimeError("references changed between unchanged-page snapshots")
        screenshot = await client.call_tool("browser_screenshot", {"tab": tab})
        images = sum(item.type == "image" for item in screenshot.content)
        if images != 1:
            raise RuntimeError("MCP screenshot did not return one actual image")
        blocked = await client.call_tool("browser_open", {"url": "http://127.0.0.1"})
        if "url_blocked" not in json.dumps(blocked.model_dump(mode="json")):
            raise RuntimeError("private-address navigation was not rejected")
        await client.call_tool("browser_close_tab", {"tab": tab})
        return {"ok": True, "tools": len(tools.tools), "title": data["title"], "http_status": data["http_status"],
                "stable_refs": len(first_refs), "mcp_images": images, "private_navigation_blocked": True,
                "note": "Actual stdio protocol, neutral page, snapshot and PNG only; no owner account was tested."}


def main() -> None:
    print(json.dumps(asyncio.run(run()), indent=2))


if __name__ == "__main__":
    main()
