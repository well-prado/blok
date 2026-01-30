from __future__ import annotations
import traceback
from typing import Any, Callable, Dict

from blok.errors.node_error import NodeError, ErrorCategory


def recovery_middleware(next_fn: Callable) -> Callable:
    """Middleware that catches unhandled exceptions and converts them to NodeErrors."""

    def wrapper(ctx, config: Dict[str, Any]) -> Any:
        try:
            return next_fn(ctx, config)
        except NodeError:
            raise
        except Exception as e:
            raise NodeError(
                message=f"unhandled exception: {e}",
                code=500,
                category=ErrorCategory.EXECUTION,
                details={"traceback": traceback.format_exc()},
                cause=e,
            ) from e

    return wrapper
