from __future__ import annotations
import logging
from datetime import datetime, timezone
from typing import Any, Dict

from blok.node.node_handler import NodeHandler
from blok.types.context import Context

# Logger that flows into the runner's RunTracker when BLOK_STREAM_LOGS=true.
# Reusing the canonical name documented in blok.server.grpc_server.NODE_LOGGER_NAME
# so handler authors see a consistent convention across examples.
log = logging.getLogger("blok.node")


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

        # Emitted on the `blok.node` logger so the runner's streaming path
        # forwards it as a LogLine event when BLOK_STREAM_LOGS=true. Harmless
        # in HTTP/unary mode — the logger is just a normal Python logger.
        log.info("greeting %s with prefix %r", name, prefix)

        ctx.set_var("greeting", message)

        return {
            "message": message,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "language": "python3",
        }
