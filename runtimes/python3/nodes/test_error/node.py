from core.nanoservice import NanoService
from core.types.context import Context
from core.types.nanoservice_response import NanoServiceResponse
from core.types.global_error import GlobalError
from typing import Any, Dict
import traceback


class TestError(NanoService):
    """Test node that throws errors for testing error handling"""

    def __init__(self):
        super().__init__()
        self.input_schema = {
            "$schema": "http://json-schema.org/draft-07/schema#",
            "title": "Test Error Input",
            "type": "object",
            "properties": {
                "should_fail": {"type": "boolean"},
                "error_message": {"type": "string"},
            },
            "required": [],
        }
        self.output_schema = {
            "$schema": "http://json-schema.org/draft-07/schema#",
            "title": "Test Error Output",
            "type": "object",
            "properties": {
                "result": {"type": "string"},
            },
        }

    async def handle(self, ctx: Context, inputs: Dict[str, Any]) -> NanoServiceResponse:
        response = NanoServiceResponse()

        try:
            should_fail = inputs.get("should_fail", False)
            error_message = inputs.get("error_message", "Test error")

            if should_fail:
                raise ValueError(error_message)

            response.setSuccess({"result": "Success - no error thrown"})

        except Exception as error:
            err = GlobalError(error)
            err.setCode(500)
            err.setName(self.name)
            err.setStack(traceback.format_exc())
            response.success = False
            response.setError(err)

        return response
