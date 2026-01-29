from __future__ import annotations
from datetime import datetime, timezone
from typing import Any, Dict

from nanoservice.node.node_handler import NodeHandler
from nanoservice.types.context import Context


class ChainTestNode(NodeHandler):
    """Cross-runtime chain test node for integration testing.

    Reads a chain array from the request body, appends a python3 entry,
    and returns the updated chain -- proving data flows between languages.
    """

    def execute(self, ctx: Context, config: Dict[str, Any]) -> Any:
        body = ctx.request.body_map()

        # Read existing chain (default to empty list)
        chain: list = []
        if body and isinstance(body.get("chain"), list):
            chain = list(body["chain"])

        # Read origin
        origin = "unknown"
        if body and isinstance(body.get("origin"), str):
            origin = body["origin"]

        # Append this language's entry
        entry = {
            "language": "python3",
            "order": len(chain) + 1,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
        chain.append(entry)

        # Store in context vars
        ctx.set_var("chain", chain)

        return {
            "chain": chain,
            "origin": origin,
        }
