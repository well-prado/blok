"""Structured `BlokError` matching the canonical `NodeError` proto contract.

This is the Python implementation of the master plan §17 builder API. Mirrors
the TypeScript ``BlokError`` in ``core/shared/src/BlokError.ts`` so node
authors writing in Python see the same idiomatic shape:

>>> raise BlokError.dependency(
...     code="POSTGRES_CONNECT_TIMEOUT",
...     message="Could not connect to Postgres within 5s",
...     description=f"Tried host={host} port={port}; timeout={dur}ms",
...     remediation="Check DATABASE_URL env var and network reachability",
...     cause=exc,
...     retryable=True,
...     retry_after_ms=5000,
... )

The runner-side ``BlokError`` (TS) decodes the proto ``NodeError`` into the
same field shape, so traces in Studio carry every field end-to-end.

The legacy ``blok.errors.NodeError`` class predates the proto contract and
covers only 5 of the 12 categories. It stays available for back-compat but
new code should prefer ``BlokError``.
"""

from __future__ import annotations

import json
import traceback
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Union


# =============================================================================
# Enums — mirrors of the proto `blok.runtime.v1.{ErrorCategory,ErrorSeverity}`
# =============================================================================


class ErrorCategory(str, Enum):
    """The 12 canonical error categories every Blok node error falls into."""

    VALIDATION = "VALIDATION"
    CONFIGURATION = "CONFIGURATION"
    DEPENDENCY = "DEPENDENCY"
    TIMEOUT = "TIMEOUT"
    PERMISSION = "PERMISSION"
    RATE_LIMIT = "RATE_LIMIT"
    NOT_FOUND = "NOT_FOUND"
    CONFLICT = "CONFLICT"
    CANCELLED = "CANCELLED"
    INTERNAL = "INTERNAL"
    PROTOCOL = "PROTOCOL"
    DATA = "DATA"


class ErrorSeverity(str, Enum):
    """How severe an error is. Default is ``ERROR``."""

    INFO = "INFO"
    WARN = "WARN"
    ERROR = "ERROR"
    FATAL = "FATAL"


#: Default HTTP status per category — single source of truth.
DEFAULT_HTTP_STATUS: Dict[ErrorCategory, int] = {
    ErrorCategory.VALIDATION: 400,
    ErrorCategory.CONFIGURATION: 500,
    ErrorCategory.DEPENDENCY: 502,
    ErrorCategory.TIMEOUT: 504,
    ErrorCategory.PERMISSION: 403,
    ErrorCategory.RATE_LIMIT: 429,
    ErrorCategory.NOT_FOUND: 404,
    ErrorCategory.CONFLICT: 409,
    ErrorCategory.CANCELLED: 499,
    ErrorCategory.INTERNAL: 500,
    ErrorCategory.PROTOCOL: 502,
    ErrorCategory.DATA: 422,
}

#: Default retryable hint per category.
DEFAULT_RETRYABLE: Dict[ErrorCategory, bool] = {
    ErrorCategory.VALIDATION: False,
    ErrorCategory.CONFIGURATION: False,
    ErrorCategory.DEPENDENCY: True,
    ErrorCategory.TIMEOUT: True,
    ErrorCategory.PERMISSION: False,
    ErrorCategory.RATE_LIMIT: True,
    ErrorCategory.NOT_FOUND: False,
    ErrorCategory.CONFLICT: False,
    ErrorCategory.CANCELLED: False,
    ErrorCategory.INTERNAL: False,
    ErrorCategory.PROTOCOL: False,
    ErrorCategory.DATA: False,
}

#: Default SDK identifier — auto-enrichment uses this when not overridden.
DEFAULT_SDK_NAME = "blok-python3"
DEFAULT_RUNTIME_KIND = "runtime.python3"

#: Cap on the bytes serialized into ``context_snapshot``. Keeps Studio + LLM
#: traces small enough to inspect at a glance while still carrying enough
#: state to debug. Configurable per-error via ``BlokError.dependency(...,
#: context_snapshot=...)`` if a node wants a smaller / larger slice.
CONTEXT_SNAPSHOT_MAX_BYTES = 4096


# =============================================================================
# BlokError — the structured error class
# =============================================================================


class BlokError(Exception):
    """Structured node error with category, severity, origin, and remediation.

    Use the classmethod factories (``BlokError.validation``,
    ``BlokError.dependency``, etc.) — direct construction is supported but the
    factories are the idiomatic entry point because they pin the category at
    the call site.

    Auto-fills ``at`` (current UTC), ``stack`` (formatted traceback),
    ``http_status`` and ``retryable`` (from category defaults). The gRPC
    servicer in :mod:`blok.server.grpc_server` enriches ``node``, ``sdk``,
    ``sdk_version``, and ``runtime_kind`` if they're not already set.

    Inherits from :class:`Exception` so node handlers can ``raise`` it
    directly; the servicer's catch path serializes it to the proto wire
    format losslessly.
    """

    def __init__(
        self,
        category: ErrorCategory,
        *,
        code: str,
        message: str,
        description: str = "",
        remediation: str = "",
        doc_url: str = "",
        cause: Optional[BaseException] = None,
        retryable: Optional[bool] = None,
        retry_after_ms: int = 0,
        details: Any = None,
        context_snapshot: Any = None,
        http_status: Optional[int] = None,
        severity: ErrorSeverity = ErrorSeverity.ERROR,
        node: str = "",
        sdk: str = "",
        sdk_version: str = "",
        runtime_kind: str = "",
        at: Optional[datetime] = None,
        stack: Optional[str] = None,
    ) -> None:
        super().__init__(message)
        self.category: ErrorCategory = category
        self.severity: ErrorSeverity = severity
        self.code: str = code
        self.message: str = message
        self.description: str = description
        self.remediation: str = remediation
        self.doc_url: str = doc_url
        self.retryable: bool = retryable if retryable is not None else DEFAULT_RETRYABLE[category]
        self.retry_after_ms: int = retry_after_ms
        self.details: Any = details
        self.context_snapshot: Any = context_snapshot
        self.http_status: int = http_status if http_status is not None else DEFAULT_HTTP_STATUS[category]
        self.node: str = node
        self.sdk: str = sdk
        self.sdk_version: str = sdk_version
        self.runtime_kind: str = runtime_kind
        self.at: datetime = at if at is not None else datetime.now(timezone.utc)
        self.stack: str = stack if stack is not None else _format_traceback()
        self.causes: List[Dict[str, Any]] = _flatten_causes(cause) if cause is not None else []

    # ===== Factory methods (one per category) ===============================

    @classmethod
    def validation(cls, **opts: Any) -> "BlokError":
        return cls(ErrorCategory.VALIDATION, **opts)

    @classmethod
    def configuration(cls, **opts: Any) -> "BlokError":
        return cls(ErrorCategory.CONFIGURATION, **opts)

    @classmethod
    def dependency(cls, **opts: Any) -> "BlokError":
        return cls(ErrorCategory.DEPENDENCY, **opts)

    @classmethod
    def timeout(cls, **opts: Any) -> "BlokError":
        return cls(ErrorCategory.TIMEOUT, **opts)

    @classmethod
    def permission(cls, **opts: Any) -> "BlokError":
        return cls(ErrorCategory.PERMISSION, **opts)

    @classmethod
    def rate_limit(cls, **opts: Any) -> "BlokError":
        return cls(ErrorCategory.RATE_LIMIT, **opts)

    @classmethod
    def not_found(cls, **opts: Any) -> "BlokError":
        return cls(ErrorCategory.NOT_FOUND, **opts)

    @classmethod
    def conflict(cls, **opts: Any) -> "BlokError":
        return cls(ErrorCategory.CONFLICT, **opts)

    @classmethod
    def cancelled(cls, **opts: Any) -> "BlokError":
        return cls(ErrorCategory.CANCELLED, **opts)

    @classmethod
    def internal(cls, **opts: Any) -> "BlokError":
        return cls(ErrorCategory.INTERNAL, **opts)

    @classmethod
    def protocol(cls, **opts: Any) -> "BlokError":
        return cls(ErrorCategory.PROTOCOL, **opts)

    @classmethod
    def data(cls, **opts: Any) -> "BlokError":
        return cls(ErrorCategory.DATA, **opts)

    # ===== Conversion =======================================================

    @classmethod
    def from_unknown(
        cls,
        err: Any,
        *,
        node: str = "",
        sdk: str = "",
        sdk_version: str = "",
        runtime_kind: str = "",
    ) -> "BlokError":
        """Wrap any thrown value as a ``BlokError``.

        Lets the runner's auto-wrap layer treat legacy ``raise
        ValueError("oops")`` consistently. Categorization heuristic:

        * :class:`BlokError` passes through, missing auto-fields filled in.
        * :class:`Exception` becomes ``INTERNAL`` with
          ``code=UNCAUGHT_<TYPE>`` and the exception preserved as cause.
        * ``dict`` (legacy ``ExecutionResult.errors`` shape) extracts the
          ``"message"`` key as the message and preserves the full payload
          in ``details``.
        * ``str`` becomes the message; details mirrors ``{"message": ...}``.
        * ``None`` → ``"node error"`` placeholder; no details.
        * Anything else stringifies, payload preserved in details.
        """
        ctx = dict(node=node, sdk=sdk, sdk_version=sdk_version, runtime_kind=runtime_kind)

        if isinstance(err, BlokError):
            # Passthrough but enrich auto-fields if missing.
            if not err.node and node:
                err.node = node
            if not err.sdk and sdk:
                err.sdk = sdk
            if not err.sdk_version and sdk_version:
                err.sdk_version = sdk_version
            if not err.runtime_kind and runtime_kind:
                err.runtime_kind = runtime_kind
            return err

        if isinstance(err, BaseException):
            type_name = type(err).__name__.upper()
            return cls(
                ErrorCategory.INTERNAL,
                code=f"UNCAUGHT_{type_name}",
                message=str(err) or "Uncaught error",
                cause=err,
                **ctx,
            )

        if isinstance(err, dict):
            message_val = err.get("message")
            message = str(message_val) if isinstance(message_val, str) and message_val else "node error"
            return cls(
                ErrorCategory.INTERNAL,
                code="UNCAUGHT_ERROR",
                message=message,
                details=err,
                **ctx,
            )

        if isinstance(err, str):
            return cls(
                ErrorCategory.INTERNAL,
                code="UNCAUGHT_ERROR",
                message=err,
                details={"message": err},
                **ctx,
            )

        if err is None:
            return cls(
                ErrorCategory.INTERNAL,
                code="UNCAUGHT_ERROR",
                message="node error",
                **ctx,
            )

        message = json.dumps(err, default=str)
        return cls(
            ErrorCategory.INTERNAL,
            code="UNCAUGHT_ERROR",
            message=message,
            details={"message": message},
            **ctx,
        )

    @classmethod
    def from_dict(cls, payload: Mapping[str, Any]) -> "BlokError":
        """Reconstruct a ``BlokError`` from a JSON-serialized payload.

        Inverse of :meth:`to_dict`. Used by tests + cross-language fixtures.
        """
        category = _parse_category(payload.get("category"))
        severity = _parse_severity(payload.get("severity"))
        at_str = payload.get("at")
        at = _parse_at(at_str) if isinstance(at_str, str) else None
        err = cls(
            category,
            code=str(payload.get("code", "")),
            message=str(payload.get("message", "")),
            description=str(payload.get("description", "")),
            remediation=str(payload.get("remediation", "")),
            doc_url=str(payload.get("doc_url", payload.get("docUrl", ""))),
            retryable=payload.get("retryable"),
            retry_after_ms=int(payload.get("retry_after_ms", payload.get("retryAfterMs", 0))),
            details=payload.get("details"),
            context_snapshot=payload.get("context_snapshot", payload.get("contextSnapshot")),
            http_status=payload.get("http_status", payload.get("httpStatus")),
            severity=severity,
            node=str(payload.get("node", "")),
            sdk=str(payload.get("sdk", "")),
            sdk_version=str(payload.get("sdk_version", payload.get("sdkVersion", ""))),
            runtime_kind=str(payload.get("runtime_kind", payload.get("runtimeKind", ""))),
            at=at,
            stack=str(payload.get("stack", "")),
        )
        causes = payload.get("causes")
        if isinstance(causes, list):
            err.causes = [dict(c) for c in causes if isinstance(c, dict)]
        return err

    def to_dict(self) -> Dict[str, Any]:
        """Serialize to a plain dict matching the proto wire format.

        The runner's gRPC codec consumes either this shape (via JSON) or the
        proto representation (via :meth:`to_proto`); both are losslessly
        round-trippable via :meth:`from_dict` / :meth:`from_proto`.
        """
        return {
            "code": self.code,
            "category": self.category.value,
            "severity": self.severity.value,
            "node": self.node,
            "sdk": self.sdk,
            "sdk_version": self.sdk_version,
            "runtime_kind": self.runtime_kind,
            "at": self.at.isoformat(),
            "message": self.message,
            "description": self.description,
            "remediation": self.remediation,
            "doc_url": self.doc_url,
            "causes": list(self.causes),
            "stack": self.stack,
            "context_snapshot": self.context_snapshot,
            "http_status": self.http_status,
            "retryable": self.retryable,
            "retry_after_ms": self.retry_after_ms,
            "details": self.details,
        }

    def __repr__(self) -> str:  # pragma: no cover — diagnostic only
        return (
            f"BlokError(category={self.category.value}, code={self.code!r}, "
            f"message={self.message!r}, node={self.node!r})"
        )


# =============================================================================
# Internal helpers
# =============================================================================


def _format_traceback() -> str:
    """Capture the current traceback as a string. Empty when called outside
    an active exception (rare; returns a stack snapshot in that case).
    """
    tb = traceback.format_exc()
    if tb and tb != "NoneType: None\n":
        return tb
    return "".join(traceback.format_stack())


def _flatten_causes(cause: BaseException) -> List[Dict[str, Any]]:
    """Walk the cause chain and produce a flat list of dict payloads.

    Mirrors the TypeScript ``BlokError.flattenCauses`` shape. Cycle-safe via
    ``id()`` tracking; ``BlokError`` instances are appended with their own
    causes already-flattened (no double-counting).
    """
    causes: List[Dict[str, Any]] = []
    visited = set()
    current: Optional[BaseException] = cause
    while current is not None and id(current) not in visited:
        visited.add(id(current))
        if isinstance(current, BlokError):
            payload = current.to_dict()
            payload["causes"] = []
            causes.append(payload)
            causes.extend(current.causes)
            break
        causes.append(_exception_to_payload(current))
        next_cause = getattr(current, "__cause__", None) or getattr(current, "cause", None)
        current = next_cause if isinstance(next_cause, BaseException) else None
    return causes


def _exception_to_payload(exc: BaseException) -> Dict[str, Any]:
    type_name = type(exc).__name__.upper()
    return {
        "code": f"UNCAUGHT_{type_name}",
        "category": ErrorCategory.INTERNAL.value,
        "severity": ErrorSeverity.ERROR.value,
        "node": "",
        "sdk": "",
        "sdk_version": "",
        "runtime_kind": "",
        "at": datetime.now(timezone.utc).isoformat(),
        "message": str(exc) or "Uncaught error",
        "description": "",
        "remediation": "",
        "doc_url": "",
        "causes": [],
        "stack": "".join(traceback.format_exception(type(exc), exc, exc.__traceback__)),
        "context_snapshot": None,
        "http_status": 500,
        "retryable": False,
        "retry_after_ms": 0,
        "details": None,
    }


def _parse_category(value: Any) -> ErrorCategory:
    if isinstance(value, ErrorCategory):
        return value
    if isinstance(value, str):
        try:
            return ErrorCategory(value)
        except ValueError:
            pass
    return ErrorCategory.INTERNAL


def _parse_severity(value: Any) -> ErrorSeverity:
    if isinstance(value, ErrorSeverity):
        return value
    if isinstance(value, str):
        try:
            return ErrorSeverity(value)
        except ValueError:
            pass
    return ErrorSeverity.ERROR


def _parse_at(value: str) -> Optional[datetime]:
    try:
        # Python 3.11+ accepts trailing 'Z'; older requires offset replacement.
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


# =============================================================================
# Context snapshot helper — bounded slice for LLM-friendly error payloads
# =============================================================================


def build_context_snapshot(
    *,
    inputs: Optional[Mapping[str, Any]] = None,
    vars_map: Optional[Mapping[str, Any]] = None,
    max_bytes: int = CONTEXT_SNAPSHOT_MAX_BYTES,
    max_vars_keys: int = 16,
) -> Dict[str, Any]:
    """Build a bounded slice of inputs + recent vars for ``context_snapshot``.

    Per master plan §17.6: a 4KB-ish JSON object the runner / Studio / LLM
    can inspect to suggest a fix without paging through gigabytes of state.

    Strategy:
      * Include all ``inputs`` (resolved per-step config — usually small).
      * Include the **last** ``max_vars_keys`` ``vars`` keys (recent steps
        most likely to be relevant to the error).
      * If the JSON-serialized result exceeds ``max_bytes``, progressively
        drop ``vars`` keys until it fits. ``inputs`` is preserved as-is
        because dropping it would lose the most LLM-actionable context.
      * Falls back to ``{"_truncated": true}`` only if even an empty shell
        exceeds the cap (shouldn't happen with default ``max_bytes``).

    The returned dict is JSON-safe — values that aren't natively
    serializable get replaced with their ``repr()``.
    """
    safe_inputs = _json_safe(dict(inputs or {}))
    raw_vars = list((vars_map or {}).items())
    recent_vars = raw_vars[-max_vars_keys:] if max_vars_keys > 0 else []
    safe_vars = _json_safe(dict(recent_vars))

    snapshot: Dict[str, Any] = {"inputs": safe_inputs, "vars": safe_vars}
    encoded = json.dumps(snapshot, default=str)
    if len(encoded.encode("utf-8")) <= max_bytes:
        return snapshot

    # Trim vars from the front until the snapshot fits.
    while recent_vars:
        recent_vars = recent_vars[1:]
        snapshot["vars"] = _json_safe(dict(recent_vars))
        encoded = json.dumps(snapshot, default=str)
        if len(encoded.encode("utf-8")) <= max_bytes:
            return snapshot

    # Even bare inputs are too big — emit a placeholder so consumers know.
    return {"inputs": safe_inputs, "vars": {}, "_truncated": True}


def _json_safe(value: Any) -> Any:
    """Recursively replace non-JSON-serializable values with their repr."""
    if isinstance(value, dict):
        return {str(k): _json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(v) for v in value]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    try:
        json.dumps(value)
        return value
    except (TypeError, ValueError):
        return repr(value)


__all__ = [
    "BlokError",
    "ErrorCategory",
    "ErrorSeverity",
    "DEFAULT_HTTP_STATUS",
    "DEFAULT_RETRYABLE",
    "DEFAULT_SDK_NAME",
    "DEFAULT_RUNTIME_KIND",
    "CONTEXT_SNAPSHOT_MAX_BYTES",
    "build_context_snapshot",
]
