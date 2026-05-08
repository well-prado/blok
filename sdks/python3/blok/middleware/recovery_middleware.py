from __future__ import annotations
import traceback
from typing import Any, Callable, Dict

from blok.errors.blok_error import BlokError
from blok.errors.node_error import NodeError, ErrorCategory


def recovery_middleware(next_fn: Callable) -> Callable:
    """Middleware that catches unhandled exceptions and converts them to NodeErrors.

    ``BlokError`` instances pass through untouched — they're already
    structured per master plan §17 and would lose every field except
    ``message`` if wrapped as a legacy ``NodeError``. Same with the legacy
    ``NodeError``: pre-wrapped errors keep their shape.
    """

    def wrapper(ctx, config: Dict[str, Any]) -> Any:
        try:
            return next_fn(ctx, config)
        except BlokError:
            # Structured BlokError: pass through verbatim so the registry
            # + gRPC servicer can serialize every field losslessly.
            raise
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
