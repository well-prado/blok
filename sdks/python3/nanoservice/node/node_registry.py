from __future__ import annotations
import time
import traceback
from typing import Any, Callable, Dict, List, Optional

from nanoservice.node.node_handler import NodeHandler
from nanoservice.types.execution_request import ExecutionRequest
from nanoservice.types.execution_result import ExecutionMetrics, ExecutionResult
from nanoservice.errors.node_error import NodeError


# Middleware type: receives a callable and returns a wrapped callable
Middleware = Callable[
    [Callable[["Context", Dict[str, Any]], Any]],
    Callable[["Context", Dict[str, Any]], Any],
]


class HealthStatus:
    """Represents the health status of the runtime."""

    __slots__ = ("status", "version", "nodes_loaded")

    def __init__(self, status: str, version: str, nodes_loaded: List[str]):
        self.status = status
        self.version = version
        self.nodes_loaded = nodes_loaded

    def to_dict(self) -> Dict[str, Any]:
        return {
            "status": self.status,
            "version": self.version,
            "nodes_loaded": self.nodes_loaded,
        }


class NodeRegistry:
    """Manages registered node handlers and dispatches execution requests.

    Holds a map of node names to handler instances, applies middleware,
    and measures execution timing.
    """

    def __init__(self, version: str = "1.0.0"):
        self._nodes: Dict[str, NodeHandler] = {}
        self._middlewares: List[Middleware] = []
        self._version = version

    def register(self, name: str, handler: NodeHandler) -> None:
        """Register a node handler under the given name."""
        self._nodes[name] = handler

    def get(self, name: str) -> Optional[NodeHandler]:
        """Look up a node handler by name."""
        return self._nodes.get(name)

    def use(self, middleware: Middleware) -> None:
        """Add a middleware to the execution pipeline."""
        self._middlewares.append(middleware)

    def node_names(self) -> List[str]:
        """Return the names of all registered nodes."""
        return sorted(self._nodes.keys())

    def execute(self, execution_request: ExecutionRequest) -> ExecutionResult:
        """Execute a node by dispatching through the registry.

        Returns an ExecutionResult with timing metrics.
        """
        node_name = execution_request.node.name
        handler = self.get(node_name)

        if handler is None:
            return ExecutionResult.error_result(
                f"node '{node_name}' not found in registry"
            )

        # Build a callable that invokes the handler
        def call_handler(ctx, config):
            return handler.execute(ctx, config)

        callable_fn = call_handler

        # Apply middleware chain (each middleware wraps the callable)
        for mw in self._middlewares:
            callable_fn = mw(callable_fn)

        start_time = time.monotonic()

        try:
            data = callable_fn(
                execution_request.context,
                execution_request.node.config,
            )
            duration_ms = (time.monotonic() - start_time) * 1000.0

            metrics = ExecutionMetrics(duration_ms=duration_ms)
            result = ExecutionResult.success_with_metrics(data, metrics)

            # Include context vars so the runner can propagate them downstream
            ctx_vars = execution_request.context.vars
            if ctx_vars:
                result.with_vars(ctx_vars)

            return result

        except NodeError as e:
            duration_ms = (time.monotonic() - start_time) * 1000.0
            result = ExecutionResult.error_with_details(e.message, e.to_dict())
            result.with_metrics(ExecutionMetrics(duration_ms=duration_ms))
            return result

        except Exception as e:
            duration_ms = (time.monotonic() - start_time) * 1000.0
            result = ExecutionResult.error_result(str(e))
            result.with_metrics(ExecutionMetrics(duration_ms=duration_ms))
            return result

    def health(self) -> HealthStatus:
        """Return the health status of the runtime."""
        return HealthStatus(
            status="healthy",
            version=self._version,
            nodes_loaded=self.node_names(),
        )
