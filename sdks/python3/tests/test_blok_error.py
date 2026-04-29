"""Unit tests for the structured :class:`BlokError`.

Covers:
- 12 category factories return the right category + http_status + retryable
- Constructor option overrides (severity, retryable, retry_after_ms, etc.)
- ``from_unknown`` heuristics for BlokError, Exception, dict, str, None,
  and arbitrary values
- ``to_dict`` / ``from_dict`` lossless round-trip
- Cause-chain flattening (cycle-safe, BlokError-as-cause flattens not nests)
- ``build_context_snapshot`` bounded-slice behavior
"""
from __future__ import annotations

import json

import pytest

from blok.errors.blok_error import (
    BlokError,
    CONTEXT_SNAPSHOT_MAX_BYTES,
    DEFAULT_HTTP_STATUS,
    DEFAULT_RETRYABLE,
    DEFAULT_RUNTIME_KIND,
    DEFAULT_SDK_NAME,
    ErrorCategory,
    ErrorSeverity,
    build_context_snapshot,
)


# =============================================================================
# Category factories
# =============================================================================


@pytest.mark.parametrize(
    "factory,category",
    [
        (BlokError.validation, ErrorCategory.VALIDATION),
        (BlokError.configuration, ErrorCategory.CONFIGURATION),
        (BlokError.dependency, ErrorCategory.DEPENDENCY),
        (BlokError.timeout, ErrorCategory.TIMEOUT),
        (BlokError.permission, ErrorCategory.PERMISSION),
        (BlokError.rate_limit, ErrorCategory.RATE_LIMIT),
        (BlokError.not_found, ErrorCategory.NOT_FOUND),
        (BlokError.conflict, ErrorCategory.CONFLICT),
        (BlokError.cancelled, ErrorCategory.CANCELLED),
        (BlokError.internal, ErrorCategory.INTERNAL),
        (BlokError.protocol, ErrorCategory.PROTOCOL),
        (BlokError.data, ErrorCategory.DATA),
    ],
)
def test_factory_sets_correct_category_and_defaults(factory, category):
    err = factory(code="TEST", message="m")
    assert err.category == category
    assert err.code == "TEST"
    assert err.message == "m"
    assert err.http_status == DEFAULT_HTTP_STATUS[category]
    assert err.retryable == DEFAULT_RETRYABLE[category]
    assert err.severity == ErrorSeverity.ERROR


def test_factory_options_override_defaults():
    err = BlokError.dependency(
        code="POSTGRES_DOWN",
        message="db down",
        description="long story",
        remediation="restart it",
        doc_url="https://example.com/x",
        retryable=False,
        retry_after_ms=10_000,
        details={"sql_state": "08001"},
        http_status=503,
        severity=ErrorSeverity.FATAL,
    )
    assert err.retryable is False  # override the default True
    assert err.http_status == 503  # override default 502
    assert err.severity == ErrorSeverity.FATAL
    assert err.description == "long story"
    assert err.remediation == "restart it"
    assert err.doc_url == "https://example.com/x"
    assert err.retry_after_ms == 10_000
    assert err.details == {"sql_state": "08001"}


def test_blok_error_is_a_python_exception():
    err = BlokError.validation(code="X", message="bad")
    assert isinstance(err, BlokError)
    assert isinstance(err, Exception)
    assert str(err) == "bad"


def test_at_is_utc_datetime():
    err = BlokError.internal(code="X", message="m")
    assert err.at.tzinfo is not None  # timezone-aware


# =============================================================================
# from_unknown heuristics
# =============================================================================


class TestFromUnknown:
    def test_passes_through_existing_blok_error(self):
        original = BlokError.dependency(code="X", message="m")
        wrapped = BlokError.from_unknown(original)
        assert wrapped is original

    def test_enriches_missing_origin_fields_on_passthrough(self):
        original = BlokError.dependency(code="X", message="m")
        wrapped = BlokError.from_unknown(
            original,
            node="step-x",
            sdk="blok-python3",
            sdk_version="1.0.0",
            runtime_kind="runtime.python3",
        )
        assert wrapped.node == "step-x"
        assert wrapped.sdk == "blok-python3"
        assert wrapped.sdk_version == "1.0.0"
        assert wrapped.runtime_kind == "runtime.python3"

    def test_does_not_overwrite_explicit_origin_fields(self):
        original = BlokError.dependency(code="X", message="m", node="explicit")
        wrapped = BlokError.from_unknown(original, node="from-ctx")
        assert wrapped.node == "explicit"

    def test_wraps_value_error_with_uncaught_typename_code(self):
        wrapped = BlokError.from_unknown(ValueError("bad number"))
        assert wrapped.category == ErrorCategory.INTERNAL
        assert wrapped.code == "UNCAUGHT_VALUEERROR"
        assert wrapped.message == "bad number"
        # cause chain has the original exception payload
        assert len(wrapped.causes) == 1
        assert wrapped.causes[0]["code"] == "UNCAUGHT_VALUEERROR"

    def test_wraps_dict_extracting_message_and_preserving_payload(self):
        wrapped = BlokError.from_unknown({"message": "boom", "extra": 42})
        assert wrapped.code == "UNCAUGHT_ERROR"
        assert wrapped.message == "boom"
        assert wrapped.details == {"message": "boom", "extra": 42}

    def test_wraps_dict_without_message_uses_placeholder(self):
        wrapped = BlokError.from_unknown({"only": "fields"})
        assert wrapped.message == "node error"

    def test_wraps_string_with_payload_in_details(self):
        wrapped = BlokError.from_unknown("plain")
        assert wrapped.message == "plain"
        assert wrapped.details == {"message": "plain"}

    def test_wraps_none_with_placeholder(self):
        wrapped = BlokError.from_unknown(None)
        assert wrapped.code == "UNCAUGHT_ERROR"
        assert wrapped.message == "node error"

    def test_wraps_arbitrary_value_via_json_dumps(self):
        wrapped = BlokError.from_unknown(42)
        assert wrapped.code == "UNCAUGHT_ERROR"
        assert wrapped.message == "42"


# =============================================================================
# to_dict / from_dict round-trip
# =============================================================================


def test_to_dict_emits_proto_wire_shape():
    err = BlokError.dependency(
        code="POSTGRES_DOWN",
        message="db down",
        description="long story",
        remediation="restart it",
        retryable=True,
        retry_after_ms=5000,
        details={"sql_state": "08001"},
        node="step-1",
        sdk="blok-python3",
        sdk_version="1.0.0",
        runtime_kind="runtime.python3",
    )
    d = err.to_dict()
    assert d["code"] == "POSTGRES_DOWN"
    assert d["category"] == "DEPENDENCY"
    assert d["severity"] == "ERROR"
    assert d["http_status"] == 502
    assert d["retryable"] is True
    assert d["retry_after_ms"] == 5000
    assert d["details"] == {"sql_state": "08001"}
    assert d["node"] == "step-1"
    assert d["sdk"] == "blok-python3"
    # `at` is serialized as ISO 8601 string.
    assert isinstance(d["at"], str)


def test_from_dict_reconstructs_full_payload():
    original = BlokError.dependency(
        code="POSTGRES_DOWN",
        message="db down",
        description="long story",
        remediation="restart it",
        retryable=False,
        retry_after_ms=5000,
        details={"sql_state": "08001"},
        http_status=503,
        node="step-1",
    )
    payload = original.to_dict()
    reconstructed = BlokError.from_dict(payload)

    assert reconstructed.category == ErrorCategory.DEPENDENCY
    assert reconstructed.code == "POSTGRES_DOWN"
    assert reconstructed.message == "db down"
    assert reconstructed.description == "long story"
    assert reconstructed.remediation == "restart it"
    assert reconstructed.retryable is False
    assert reconstructed.retry_after_ms == 5000
    assert reconstructed.details == {"sql_state": "08001"}
    assert reconstructed.http_status == 503
    assert reconstructed.node == "step-1"


def test_from_dict_handles_camelcase_and_unknown_categories():
    # Mirrors the TS payload shape (camelCase) so cross-language round-trips
    # via the proto JSON form work.
    payload = {
        "code": "X",
        "category": "weird-category",  # falls back to INTERNAL
        "severity": "huh",  # falls back to ERROR
        "message": "m",
        "httpStatus": 418,
        "retryAfterMs": 1000,
        "sdkVersion": "9.9.9",
        "runtimeKind": "runtime.python3",
        "docUrl": "https://example.com",
        "contextSnapshot": {"x": 1},
    }
    err = BlokError.from_dict(payload)
    assert err.category == ErrorCategory.INTERNAL
    assert err.severity == ErrorSeverity.ERROR
    assert err.http_status == 418
    assert err.retry_after_ms == 1000
    assert err.sdk_version == "9.9.9"
    assert err.runtime_kind == "runtime.python3"
    assert err.doc_url == "https://example.com"
    assert err.context_snapshot == {"x": 1}


# =============================================================================
# Cause chain flattening
# =============================================================================


def test_cause_chain_for_plain_exception():
    err = BlokError.dependency(
        code="X",
        message="outer",
        cause=ValueError("inner"),
    )
    assert len(err.causes) == 1
    assert err.causes[0]["code"] == "UNCAUGHT_VALUEERROR"
    assert err.causes[0]["message"] == "inner"


def test_cause_chain_for_blok_error_flattens_not_nests():
    leaf = BlokError.dependency(
        code="LEAF",
        message="leaf",
        cause=RuntimeError("root"),
    )
    middle = BlokError.dependency(code="MID", message="mid", cause=leaf)

    # `middle.causes` should contain leaf's payload + leaf's flattened causes,
    # NOT a single nested cause object with cause inside cause.
    assert len(middle.causes) == 2
    assert middle.causes[0]["code"] == "LEAF"
    assert middle.causes[0]["causes"] == []
    assert middle.causes[1]["code"] == "UNCAUGHT_RUNTIMEERROR"


def test_cause_chain_is_cycle_safe():
    err1 = ValueError("a")
    err2 = RuntimeError("b")
    err1.__cause__ = err2
    err2.__cause__ = err1  # cycle
    err = BlokError.from_unknown(err1)
    # The walker stops on cycle detection; we get at most 2 entries.
    assert len(err.causes) <= 2


# =============================================================================
# Context snapshot helper
# =============================================================================


class TestBuildContextSnapshot:
    def test_empty_inputs_and_vars(self):
        snap = build_context_snapshot(inputs={}, vars_map={})
        assert snap == {"inputs": {}, "vars": {}}

    def test_includes_all_inputs_and_recent_vars(self):
        inputs = {"prefix": "Hi"}
        vars_map = {f"step{i}": {"value": i} for i in range(20)}
        snap = build_context_snapshot(inputs=inputs, vars_map=vars_map, max_vars_keys=16)
        assert snap["inputs"] == inputs
        # Last 16 keys win.
        assert len(snap["vars"]) == 16
        assert "step19" in snap["vars"]
        assert "step3" not in snap["vars"]
        assert "step4" in snap["vars"]

    def test_trims_vars_when_payload_exceeds_max_bytes(self):
        big_vars = {f"k{i}": "x" * 200 for i in range(30)}
        snap = build_context_snapshot(
            inputs={"shape": "round"},
            vars_map=big_vars,
            max_bytes=1024,
            max_vars_keys=30,
        )
        encoded = json.dumps(snap, default=str).encode("utf-8")
        assert len(encoded) <= 1024
        assert snap["inputs"] == {"shape": "round"}

    def test_handles_non_json_serializable_values_via_repr(self):
        class Foo:
            def __repr__(self):
                return "<Foo>"

        snap = build_context_snapshot(inputs={"obj": Foo()}, vars_map={})
        assert snap["inputs"]["obj"] == "<Foo>"


# =============================================================================
# Auto-enrichment defaults exposed
# =============================================================================


def test_default_sdk_constants():
    assert DEFAULT_SDK_NAME == "blok-python3"
    assert DEFAULT_RUNTIME_KIND == "runtime.python3"
    assert CONTEXT_SNAPSHOT_MAX_BYTES == 4096
