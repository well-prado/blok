"""Example node demonstrating the structured :class:`BlokError` API.

Used by the cross-language E2E test (`python-grpc.integration.test.ts`)
to verify that a structured Python error flows through the gRPC wire to
the runner with every field preserved (category, severity, code,
remediation, retryable hints, cause chain, context snapshot).

Triggers:
- ``mode="dependency"`` (default) — raises ``BlokError.dependency`` with a
  cause chain rooted in a ``ConnectionError``.
- ``mode="rate-limit"`` — raises ``BlokError.rate_limit`` with
  ``retry_after_ms``.
- ``mode="validation"`` — raises ``BlokError.validation`` with
  ``details`` carrying a Zod-style issue list.
- ``mode="ok"`` — returns success (sanity check the node isn't broken).
"""

from __future__ import annotations
from typing import Any, Dict

from blok.errors.blok_error import BlokError, build_context_snapshot
from blok.node.node_handler import NodeHandler
from blok.types.context import Context


class BlokErrorDemoNode(NodeHandler):
    """Raises a structured BlokError matching the requested mode."""

    def execute(self, ctx: Context, config: Dict[str, Any]) -> Any:
        mode = config.get("mode", "dependency")

        if mode == "ok":
            return {"ok": True, "language": "python3"}

        snapshot = build_context_snapshot(inputs=config, vars_map=ctx.vars)

        if mode == "rate-limit":
            raise BlokError.rate_limit(
                code="UPSTREAM_RATE_LIMITED",
                message="Upstream API returned 429",
                description="GitHub API rate limit hit (5000 req/hr).",
                remediation="Wait until the X-RateLimit-Reset header timestamp.",
                retry_after_ms=60_000,
                doc_url="https://docs.example.com/errors/rate-limit",
                details={"limit": 5000, "remaining": 0},
                context_snapshot=snapshot,
            )

        if mode == "validation":
            raise BlokError.validation(
                code="VALIDATION_FAILED",
                message="2 validation issues",
                description="Inputs didn't match the node's schema.",
                remediation="Provide both `email` and `name`.",
                details={
                    "issues": [
                        {"path": ["email"], "message": "Required"},
                        {"path": ["name"], "message": "Required"},
                    ],
                },
                context_snapshot=snapshot,
            )

        # default: dependency with a cause chain
        try:
            raise ConnectionError("[Errno 61] Connection refused")
        except ConnectionError as exc:
            raise BlokError.dependency(
                code="POSTGRES_CONNECT_TIMEOUT",
                message="Could not connect to Postgres within 5s",
                description="Tried host=db.internal port=5432; timeout=5000ms",
                remediation="Check DATABASE_URL env var and network reachability",
                cause=exc,
                retryable=True,
                retry_after_ms=5_000,
                doc_url="https://docs.example.com/errors/POSTGRES_CONNECT_TIMEOUT",
                details={"host": "db.internal", "port": 5432, "timeout_ms": 5000},
                context_snapshot=snapshot,
            ) from exc
