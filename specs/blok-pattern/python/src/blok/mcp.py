"""Serves every workflow that has an mcp trigger as a tool an AI agent can call, over the Model Context
Protocol. The server is the official SDK's, so it speaks whatever transport you run it on:

    server = blok_mcp(blok, name="shop", version="1.0.0")
"""

from __future__ import annotations

import json
from typing import Any

import mcp.types as types
from mcp.server.lowlevel import Server

from .kernel import BlokError, may_work_later
from .project import App
from .workflow import ToolBinding


def blok_mcp(blok: App, *, name: str, version: str, instructions: str | None = None) -> Server[Any]:
    """`instructions` say what the whole set of tools is for. An agent reads it once, when it connects."""
    tools = {binding.tool: binding for binding in blok.bindings if isinstance(binding, ToolBinding)}

    def said(text: str, is_error: bool = False, structured: Any = None) -> types.CallToolResult:
        content = [types.TextContent(type="text", text=text)]
        if structured is None:
            return types.CallToolResult(content=content, is_error=is_error)
        return types.CallToolResult(content=content, is_error=is_error, structured_content=structured)

    async def list_tools(_ctx: Any, _params: Any) -> types.ListToolsResult:
        return types.ListToolsResult(
            tools=[
                types.Tool(
                    name=tool.tool, description=tool.description, input_schema=tool.input, output_schema=tool.output
                )
                for tool in tools.values()
            ]
        )

    async def call_tool(_ctx: Any, params: types.CallToolRequestParams) -> types.CallToolResult:
        tool = tools.get(params.name)
        if tool is None:
            return said(f'There is no tool called "{params.name}".', True)
        try:
            output = await blok.call(tool.unit, {"body": params.arguments or {}})
            text = json.dumps(output, ensure_ascii=False, separators=(",", ":"))
            # A tool that promised the shape of its answer also gives the answer as data, not only as text.
            return said(text, structured=output if tool.output else None)
        except Exception as err:
            error = err if isinstance(err, BlokError) else BlokError("unexpected", str(err), tool.unit.id)
            # A refusal is something the agent can read and act on. What broke inside is for the log.
            if not may_work_later(error.code):
                return said(f"{error.code}: {error.message}", True)
            blok.log.error(
                f'{tool.unit.id}, called as the tool "{tool.tool}", failed with "{error.code}" at {error.node}: {error.message}'
            )
            return said(f"{error.code}: The tool could not complete the call.", True)

    return Server(name, version=version, instructions=instructions, on_list_tools=list_tools, on_call_tool=call_tool)
