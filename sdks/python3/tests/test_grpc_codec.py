"""Unit tests for the gRPC codec helpers in ``blok.server.grpc_server``.

Covers proto ↔ internal-type round-trips, edge cases (empty bytes,
malformed JSON, content-type sensitivity), and the structured-error
synthesis path.
"""
from __future__ import annotations

import json

import pytest

from blok.runtime.v1 import runtime_pb2 as pb
from blok.server.grpc_server import (
    _decode_execute_request,
    _decode_json_object,
    _decode_json_value,
    _decode_request_body,
    _DecodeError,
    _encode_execute_response,
    _encode_json_bytes,
    _internal_error_to_proto,
)
from blok.types.execution_result import ExecutionMetrics, ExecutionResult


# =============================================================================
# JSON-bytes helpers
# =============================================================================


class TestJsonBytesHelpers:
    def test_round_trip_objects_arrays_primitives(self):
        for sample in [
            {"a": 1, "b": "two", "c": [3, 4, 5]},
            [1, 2, 3],
            "plain string",
            42,
            True,
            None,
        ]:
            blob = _encode_json_bytes(sample)
            decoded = _decode_json_value(blob, "field") if sample is not None else None
            if sample is not None:
                assert decoded == sample

    def test_encode_empty_for_unencodable(self):
        # Sets aren't JSON-encodable; helper falls back to empty bytes.
        assert _encode_json_bytes({1, 2, 3}) == b""

    def test_decode_empty_bytes_returns_default(self):
        assert _decode_json_object(b"", "x") == {}
        assert _decode_json_value(b"", "x") is None

    def test_decode_object_wraps_non_object_payloads(self):
        result = _decode_json_object(b"[1,2,3]", "inputs")
        assert result == {"_value": [1, 2, 3]}

    def test_decode_object_raises_on_malformed_json(self):
        with pytest.raises(_DecodeError):
            _decode_json_object(b"not json", "inputs")


# =============================================================================
# Request body decoding
# =============================================================================


class TestRequestBodyDecoding:
    def test_returns_none_for_empty_bytes(self):
        assert _decode_request_body(b"", {}) is None

    def test_parses_json_when_content_type_says_so(self):
        body = _decode_request_body(
            b'{"hello":"world"}',
            {"content-type": "application/json"},
        )
        assert body == {"hello": "world"}

    def test_falls_back_to_raw_string_for_other_content_types(self):
        body = _decode_request_body(b"plain text", {"content-type": "text/plain"})
        assert body == "plain text"

    def test_falls_back_to_raw_string_when_json_is_malformed(self):
        body = _decode_request_body(
            b"not valid json",
            {"content-type": "application/json"},
        )
        assert body == "not valid json"

    def test_handles_capitalized_content_type_header(self):
        body = _decode_request_body(b'"x"', {"Content-Type": "application/json"})
        assert body == "x"


# =============================================================================
# Execute request decoding
# =============================================================================


def _make_proto_request(*, node_name="store-tutorial", inputs=None, body_bytes=b""):
    return pb.ExecuteRequest(
        node=pb.NodeRef(name=node_name, type="runtime.python3", version=""),
        inputs=_encode_json_bytes(inputs or {"foo": "bar"}),
        step=pb.StepInfo(name=node_name, index=0, total=1, depth=0),
        trigger=pb.TriggerInfo(
            body=body_bytes,
            headers={"content-type": "application/json"},
            params={"id": "42"},
            query={"foo": "bar"},
            cookies={},
            method="POST",
            url="/",
            base_url="",
            trigger_kind="http",
        ),
        state=pb.RuntimeState(
            previous_output=_encode_json_bytes({"prev": True}),
            vars=_encode_json_bytes({"counter": 1}),
            env={"NODE_ENV": "test"},
        ),
        workflow=pb.WorkflowInfo(
            run_id="run_xyz",
            name="wf",
            path="/wf",
            version="1.0.0",
            started_at=None,
        ),
        options=pb.ExecuteOptions(
            deadline_ms=5000,
            stream_logs=False,
            capture_metrics=True,
            hints={},
        ),
    )


class TestDecodeExecuteRequest:
    def test_inputs_arrive_unwrapped(self):
        req = _make_proto_request(inputs={"prefix": "Hi"})
        decoded = _decode_execute_request(req)
        # Closes BLOK_FRAMEWORK_FIXES.md #3 at the wire layer for Python.
        assert decoded.node.config == {"prefix": "Hi"}

    def test_node_identification_round_trips(self):
        req = _make_proto_request(node_name="custom-node")
        decoded = _decode_execute_request(req)
        assert decoded.node.name == "custom-node"
        assert decoded.node.type == "runtime.python3"

    def test_workflow_metadata_populates_context(self):
        req = _make_proto_request()
        decoded = _decode_execute_request(req)
        assert decoded.context.id == "run_xyz"
        assert decoded.context.workflow_name == "wf"
        assert decoded.context.workflow_path == "/wf"

    def test_state_populates_response_data_and_vars(self):
        req = _make_proto_request()
        decoded = _decode_execute_request(req)
        assert decoded.context.response.data == {"prev": True}
        assert decoded.context.vars == {"counter": 1}
        assert decoded.context.env == {"NODE_ENV": "test"}

    def test_request_metadata_round_trips(self):
        req = _make_proto_request(body_bytes=_encode_json_bytes({"name": "Blok"}))
        decoded = _decode_execute_request(req)
        assert decoded.context.request.body == {"name": "Blok"}
        assert decoded.context.request.params == {"id": "42"}
        assert decoded.context.request.query == {"foo": "bar"}
        assert decoded.context.request.method == "POST"

    def test_rejects_request_without_node(self):
        bad = pb.ExecuteRequest()  # node field missing → name is empty string
        with pytest.raises(_DecodeError):
            _decode_execute_request(bad)


# =============================================================================
# Execute response encoding
# =============================================================================


class TestEncodeExecuteResponse:
    def test_success_round_trips_data(self):
        result = ExecutionResult.success_result({"message": "Hi, Blok!"})
        result.with_metrics(ExecutionMetrics(duration_ms=12.5))
        proto = _encode_execute_response(
            result,
            node_name="hello-world",
            sdk_version="1.0.0",
        )
        assert proto.success is True
        assert proto.error is None or proto.error.code == ""
        assert json.loads(proto.data) == {"message": "Hi, Blok!"}
        assert proto.metrics.duration_ms == pytest.approx(12.5)

    def test_failure_populates_structured_node_error(self):
        result = ExecutionResult.error_result("Postgres unreachable")
        proto = _encode_execute_response(
            result,
            node_name="store-tutorial",
            sdk_version="1.0.0",
        )
        assert proto.success is False
        err = proto.error
        assert err.code == "PYTHON_NODE_ERROR"
        assert err.category == pb.ErrorCategory.INTERNAL
        assert err.severity == pb.ErrorSeverity.ERROR
        assert err.node == "store-tutorial"
        assert err.sdk == "blok-python3"
        assert err.runtime_kind == "runtime.python3"
        assert err.message == "Postgres unreachable"
        # `details_json` carries the original error payload for inspection.
        details = json.loads(err.details_json)
        assert details["message"] == "Postgres unreachable"

    def test_vars_delta_serialized_when_present(self):
        result = ExecutionResult.success_result({"ok": True})
        result.with_vars({"cached": True})
        proto = _encode_execute_response(
            result,
            node_name="x",
            sdk_version="1.0.0",
        )
        assert json.loads(proto.vars_delta) == {"cached": True}

    def test_vars_delta_empty_when_no_vars(self):
        result = ExecutionResult.success_result({"ok": True})
        proto = _encode_execute_response(
            result,
            node_name="x",
            sdk_version="1.0.0",
        )
        assert proto.vars_delta == b""


class TestInternalErrorToProto:
    def test_string_error(self):
        err = _internal_error_to_proto("plain string error", node_name="n", sdk_version="v")
        assert err.message == "plain string error"
        assert json.loads(err.details_json) == {"message": "plain string error"}

    def test_none_error(self):
        err = _internal_error_to_proto(None, node_name="n", sdk_version="v")
        assert err.message == "node error"
        assert err.details_json == b""

    def test_dict_error_preserves_payload(self):
        payload = {"message": "boom", "extra": {"sql": "08001"}}
        err = _internal_error_to_proto(payload, node_name="n", sdk_version="v")
        assert err.message == "boom"
        assert json.loads(err.details_json) == payload

    def test_unknown_type_falls_back_to_str(self):
        err = _internal_error_to_proto(42, node_name="n", sdk_version="v")
        assert err.message == "42"
