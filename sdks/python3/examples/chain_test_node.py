from __future__ import annotations
from datetime import datetime, timezone
from typing import Any, Dict

from blok.node.node_handler import NodeHandler
from blok.types.context import Context


class ChainTestNode(NodeHandler):
    """Cross-runtime chain test node for integration testing.

    Reads a chain array from the request body, appends a python3 entry,
    and returns the updated chain -- proving data flows between languages.
    """

    def execute(self, ctx: Context, config: Dict[str, Any]) -> Any:
        body = ctx.request.body_map()

        # Read existing chain — gRPC inputs first (carried on `node.config`),
        # HTTP body fallback (legacy wire shape where the runner mapped
        # resolvedInputs → request.body). Dual-read keeps the
        # cross-runtime-chain demo working over both transports during
        # the §11 deprecation window.
        chain: list = []
        if isinstance(config.get("chain"), list):
            chain = list(config["chain"])
        elif body and isinstance(body.get("chain"), list):
            chain = list(body["chain"])

        # Read origin — same dual-read.
        origin = "unknown"
        if isinstance(config.get("origin"), str) and config["origin"]:
            origin = config["origin"]
        elif body and isinstance(body.get("origin"), str):
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
