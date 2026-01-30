from core.blok import NanoService
from core.types.context import Context
from core.types.blok_response import NanoServiceResponse
from core.types.global_error import GlobalError
from typing import Any, Dict
import traceback


class TestContext(NanoService):
    """Test node that uses context variables"""

    def __init__(self):
        super().__init__()
        self.input_schema = {
            "$schema": "http://json-schema.org/draft-07/schema#",
            "title": "Test Context Input",
            "type": "object",
            "properties": {
                "operation": {"type": "string"},
            },
            "required": ["operation"],
        }
        self.output_schema = {
            "$schema": "http://json-schema.org/draft-07/schema#",
            "title": "Test Context Output",
            "type": "object",
            "properties": {
                "result": {"type": "string"},
                "vars": {"type": "object"},
            },
        }

    async def handle(self, ctx: Context, inputs: Dict[str, Any]) -> NanoServiceResponse:
        response = NanoServiceResponse()

        try:
            operation = inputs.get("operation", "read")

            if operation == "write":
                # Write to context variables
                ctx.vars["python_message"] = "Hello from Python3"
                ctx.vars["python_count"] = 42
                result = "Variables written to context"
            else:
                # Read from context variables
                prev_message = ctx.vars.get("previous_message", "No previous message")
                result = f"Read from context: {prev_message}"

            response.setSuccess({
                "result": result,
                "vars": dict(ctx.vars)
            })

        except Exception as error:
            err = GlobalError(error)
            err.setCode(500)
            err.setName(self.name)
            err.setStack(traceback.format_exc())
            response.success = False
            response.setError(err)

        return response
