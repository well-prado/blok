from __future__ import annotations
from datetime import datetime, timezone
from typing import Any, Dict

from blok.node.node_handler import NodeHandler
from blok.types.context import Context


class HelloWorldNode(NodeHandler):
    """Greets the user with a configurable prefix.

    Config:
        prefix (str, optional): Greeting prefix (default: "Hello")

    Request body:
        name (str, optional): Name to greet (default: "World")

    Output:
        {"message": "Hello, World!", "timestamp": "...", "language": "python3"}
    """

    def execute(self, ctx: Context, config: Dict[str, Any]) -> Any:
        name = ctx.request.body_str("name") or "World"
        prefix = config.get("prefix", "Hello")
        message = f"{prefix}, {name}!"

        ctx.set_var("greeting", message)

        return {
            "message": message,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "language": "python3",
        }
