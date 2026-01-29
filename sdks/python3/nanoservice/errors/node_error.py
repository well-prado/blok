from __future__ import annotations
from enum import Enum
from typing import Any, Dict, Optional


class ErrorCategory(str, Enum):
    """Classifies the type of error that occurred."""

    VALIDATION = "VALIDATION"
    EXECUTION = "EXECUTION"
    CONFIGURATION = "CONFIGURATION"
    NETWORK = "NETWORK"
    NOT_FOUND = "NOT_FOUND"


class NodeError(Exception):
    """Structured error from node execution."""

    def __init__(
        self,
        message: str,
        code: int = 500,
        category: ErrorCategory = ErrorCategory.EXECUTION,
        details: Optional[Dict[str, Any]] = None,
        cause: Optional[Exception] = None,
    ):
        super().__init__(message)
        self.message = message
        self.code = code
        self.category = category
        self.details = details
        self.cause = cause

    def to_dict(self) -> Dict[str, Any]:
        result: Dict[str, Any] = {
            "message": self.message,
            "code": self.code,
            "category": self.category.value,
        }
        if self.details:
            result["details"] = self.details
        if self.cause:
            result["cause"] = str(self.cause)
        return result

    @classmethod
    def validation(cls, message: str) -> NodeError:
        return cls(message=message, code=400, category=ErrorCategory.VALIDATION)

    @classmethod
    def execution(cls, message: str, cause: Optional[Exception] = None) -> NodeError:
        return cls(message=message, code=500, category=ErrorCategory.EXECUTION, cause=cause)

    @classmethod
    def configuration(cls, message: str) -> NodeError:
        return cls(message=message, code=500, category=ErrorCategory.CONFIGURATION)

    @classmethod
    def network(cls, message: str, cause: Optional[Exception] = None) -> NodeError:
        return cls(message=message, code=502, category=ErrorCategory.NETWORK, cause=cause)

    @classmethod
    def not_found(cls, message: str) -> NodeError:
        return cls(message=message, code=404, category=ErrorCategory.NOT_FOUND)
