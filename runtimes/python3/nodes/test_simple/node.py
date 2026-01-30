from core.blok import NanoService
from core.types.context import Context
from core.types.blok_response import NanoServiceResponse
from core.types.global_error import GlobalError
from typing import Any, Dict
import traceback


class TestSimple(NanoService):
    """Simple test node for integration testing"""

    def __init__(self):
        super().__init__()
        self.input_schema = {
            "$schema": "http://json-schema.org/draft-07/schema#",
            "title": "Test Simple Input",
            "type": "object",
            "properties": {
                "message": {"type": "string"},
                "count": {"type": "number"},
            },
            "required": ["message"],
        }
        self.output_schema = {
            "$schema": "http://json-schema.org/draft-07/schema#",
            "title": "Test Simple Output",
            "type": "object",
            "properties": {
                "result": {"type": "string"},
                "count": {"type": "number"},
            },
        }

    async def handle(self, ctx: Context, inputs: Dict[str, Any]) -> NanoServiceResponse:
        response = NanoServiceResponse()

        try:
            message = inputs.get("message", "")
            count = inputs.get("count", 1)

            # Simple transformation
            result = f"Python3 processed: {message}"

            response.setSuccess({"result": result, "count": count})

        except Exception as error:
            err = GlobalError(error)
            err.setCode(500)
            err.setName(self.name)
            err.setStack(traceback.format_exc())
            response.success = False
            response.setError(err)

        return response
