"""Error types for the Blok Python SDK.

Two classes coexist:

- :class:`BlokError` — the canonical structured error per master plan §17.
  Mirrors the proto ``blok.runtime.v1.NodeError`` contract; 12 categories
  with idiomatic factory methods (``BlokError.dependency(...)`` etc.).
  **Use this for new code.**

- :class:`NodeError` — legacy (5 categories). Kept for back-compat with
  existing example nodes + middleware that imports from
  ``blok.errors.node_error`` directly. New code should prefer
  :class:`BlokError`.

The two enums share the name ``ErrorCategory`` internally; this package
re-exports the legacy 5-value enum as ``ErrorCategory`` (preserving the
existing public API) and the new 12-value enum as ``BlokErrorCategory``.
Direct file-path imports (``from blok.errors.blok_error import
ErrorCategory``) get the new one — that's the recommended path going
forward.
"""

from blok.errors.blok_error import (
    BlokError,
    CONTEXT_SNAPSHOT_MAX_BYTES,
    DEFAULT_HTTP_STATUS,
    DEFAULT_RETRYABLE,
    DEFAULT_RUNTIME_KIND,
    DEFAULT_SDK_NAME,
    ErrorCategory as BlokErrorCategory,
    ErrorSeverity as BlokErrorSeverity,
    build_context_snapshot,
)
from blok.errors.node_error import ErrorCategory, NodeError

__all__ = [
    # New structured error API (preferred).
    "BlokError",
    "BlokErrorCategory",
    "BlokErrorSeverity",
    "DEFAULT_HTTP_STATUS",
    "DEFAULT_RETRYABLE",
    "DEFAULT_SDK_NAME",
    "DEFAULT_RUNTIME_KIND",
    "CONTEXT_SNAPSHOT_MAX_BYTES",
    "build_context_snapshot",
    # Legacy (back-compat).
    "NodeError",
    "ErrorCategory",
]
