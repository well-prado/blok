from __future__ import annotations
from typing import Any, Dict, List, Optional


class ExecutionMetrics:
    """Captures performance metrics for a node execution."""

    __slots__ = ("duration_ms", "cpu_ms", "memory_bytes")

    def __init__(
        self,
        duration_ms: Optional[float] = None,
        cpu_ms: Optional[float] = None,
        memory_bytes: Optional[int] = None,
    ):
        self.duration_ms = duration_ms
        self.cpu_ms = cpu_ms
        self.memory_bytes = memory_bytes

    def to_dict(self) -> Dict[str, Any]:
        result: Dict[str, Any] = {}
        if self.duration_ms is not None:
            result["duration_ms"] = self.duration_ms
        if self.cpu_ms is not None:
            result["cpu_ms"] = self.cpu_ms
        if self.memory_bytes is not None:
            result["memory_bytes"] = self.memory_bytes
        return result


class ExecutionResult:
    """The response returned to the Blok runner."""

    __slots__ = ("success", "data", "errors", "logs", "metrics", "vars")

    def __init__(
        self,
        success: bool = True,
        data: Any = None,
        errors: Any = None,
        logs: Optional[List[str]] = None,
        metrics: Optional[ExecutionMetrics] = None,
        vars: Optional[Dict[str, Any]] = None,
    ):
        self.success = success
        self.data = data
        self.errors = errors
        self.logs = logs
        self.metrics = metrics
        self.vars = vars

    def with_vars(self, vars: Dict[str, Any]) -> ExecutionResult:
        """Attach context variables to the result."""
        self.vars = vars
        return self

    def with_logs(self, logs: List[str]) -> ExecutionResult:
        """Add log entries to the result."""
        self.logs = logs
        return self

    def with_metrics(self, metrics: ExecutionMetrics) -> ExecutionResult:
        """Add execution metrics to the result."""
        self.metrics = metrics
        return self

    def to_dict(self) -> Dict[str, Any]:
        result: Dict[str, Any] = {
            "success": self.success,
            "data": self.data,
            "errors": self.errors,
        }
        if self.logs is not None:
            result["logs"] = self.logs
        if self.metrics is not None:
            result["metrics"] = self.metrics.to_dict()
        if self.vars is not None:
            result["vars"] = self.vars
        return result

    @classmethod
    def success_result(cls, data: Any) -> ExecutionResult:
        """Create a successful execution result."""
        return cls(success=True, data=data)

    @classmethod
    def error_result(cls, message: str) -> ExecutionResult:
        """Create a failed execution result."""
        return cls(success=False, data=None, errors={"message": message})

    @classmethod
    def success_with_metrics(cls, data: Any, metrics: ExecutionMetrics) -> ExecutionResult:
        """Create a successful result with metrics."""
        return cls(success=True, data=data, metrics=metrics)

    @classmethod
    def error_with_details(cls, message: str, details: Dict[str, Any]) -> ExecutionResult:
        """Create a failed result with additional details."""
        return cls(
            success=False,
            data=None,
            errors={"message": message, "details": details},
        )
