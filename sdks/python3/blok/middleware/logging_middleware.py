from __future__ import annotations
import time
import logging
from typing import Any, Callable, Dict

logger = logging.getLogger("blok")


def logging_middleware(next_fn: Callable) -> Callable:
    """Middleware that logs the execution of each node with timing."""

    def wrapper(ctx, config: Dict[str, Any]) -> Any:
        start = time.monotonic()
        logger.info("node execution started [workflow=%s]", ctx.workflow_name)

        try:
            result = next_fn(ctx, config)
            duration_ms = (time.monotonic() - start) * 1000.0
            logger.info(
                "node execution completed [workflow=%s] [duration_ms=%.2f]",
                ctx.workflow_name,
                duration_ms,
            )
            return result
        except Exception as e:
            duration_ms = (time.monotonic() - start) * 1000.0
            logger.error(
                "node execution failed [workflow=%s] [duration_ms=%.2f] [error=%s]",
                ctx.workflow_name,
                duration_ms,
                str(e),
            )
            raise

    return wrapper
