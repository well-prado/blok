from typing import Any, Optional
from core.types.global_error import GlobalError

class ResponseContext:
    def __init__(self, data: Any = {}, error: Optional[GlobalError] = None, success: bool = False, contentType: str = "application/json"):
        self.data: Any = data
        self.error: Optional[GlobalError] = error
        self.success: bool = success
        self.contentType: str = contentType

    def to_dict(self):
        # Handle error - could be GlobalError object or already a dict
        error_dict = None
        if self.error:
            if hasattr(self.error, 'to_dict'):
                error_dict = self.error.to_dict()
            elif isinstance(self.error, dict):
                error_dict = self.error
            else:
                error_dict = {"message": str(self.error)}

        return {
            "data": self.data,
            "error": error_dict,
            "success": self.success,
            "contentType": self.contentType
        }