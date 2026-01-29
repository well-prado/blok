from core.nanoservice import NanoService
from core.types.context import Context
from core.types.nanoservice_response import NanoServiceResponse
from core.types.global_error import GlobalError
from typing import Any, Dict
from datetime import datetime, timezone
import traceback


class ChainTest(NanoService):
    """Cross-runtime chain test node for integration testing.

    Reads a chain array from inputs, appends a Python3 entry,
    and returns the updated chain — proving data flows between languages.
    """

    def __init__(self):
        super().__init__()
        self.input_schema = {
            "$schema": "http://json-schema.org/draft-07/schema#",
            "title": "Chain Test Input",
            "type": "object",
            "properties": {
                "chain": {"type": "array"},
                "origin": {"type": "string"},
            },
        }
        self.output_schema = {
            "$schema": "http://json-schema.org/draft-07/schema#",
            "title": "Chain Test Output",
            "type": "object",
            "properties": {
                "chain": {"type": "array"},
                "origin": {"type": "string"},
            },
        }

    async def handle(self, ctx: Context, inputs: Dict[str, Any]) -> NanoServiceResponse:
        response = NanoServiceResponse()

        try:
            # Read existing chain (default to empty list)
            chain = inputs.get("chain", [])
            if not isinstance(chain, list):
                chain = []

            # Read origin
            origin = inputs.get("origin", "unknown")
            if not isinstance(origin, str):
                origin = "unknown"

            # Append this language's entry
            entry = {
                "language": "python3",
                "order": len(chain) + 1,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }
            chain.append(entry)

            # Store in context vars
            ctx.vars["chain"] = chain

            response.setSuccess({"chain": chain, "origin": origin})

        except Exception as error:
            err = GlobalError(error)
            err.setCode(500)
            err.setName(self.name)
            err.setStack(traceback.format_exc())
            response.success = False
            response.setError(err)

        return response
