"""End-to-end gRPC test for the Python SDK.

Spins up the ``BlokNodeRuntimeServicer`` on a random port, connects with a
grpc-python client, and exercises every RPC the v1 contract defines.

Mirrors ``sdks/rust/tests/grpc_integration.rs``.
"""
from __future__ import annotations

import json
import socket
from typing import Any, Dict

import grpc
import pytest

from blok.node.node_registry import NodeRegistry
from blok.runtime.v1 import runtime_pb2 as pb
from blok.runtime.v1 import runtime_pb2_grpc as pb_grpc
from blok.server.grpc_server import _encode_json_bytes, serve_grpc
from blok.types.context import Context


def _reserve_free_port() -> int:
    """Reserve an OS-chosen TCP port and immediately release it."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class _EchoNode:
    """Minimal handler that echoes its config back as data."""

    def execute(self, ctx: Context, config: Dict[str, Any]) -> Any:
        return dict(config)


class _GreetNode:
    """Handler mirroring ``examples/hello_world_node.py`` for cross-runtime parity."""

    def execute(self, ctx: Context, config: Dict[str, Any]) -> Any:
        prefix = config.get("prefix", "Hello")
        name = ctx.request.body_str("name") or "World"
        ctx.set_var("greeting", f"{prefix}, {name}!")
        return {
            "message": f"{prefix}, {name}!",
            "language": "python3",
        }


@pytest.fixture(scope="module")
def grpc_server_fixture():
    """Start a real gRPC server with two registered nodes; tear down after."""
    port = _reserve_free_port()
    registry = NodeRegistry(version="1.0.0-test")
    registry.register("echo", _EchoNode())
    registry.register("greet", _GreetNode())

    server = serve_grpc(registry, port=port, host="127.0.0.1", sdk_version="1.0.0-test")
    try:
        yield port
    finally:
        server.stop(grace=1.0)


@pytest.fixture
def client(grpc_server_fixture):
    """Connect a NodeRuntimeStub to the server fixture."""
    port = grpc_server_fixture
    channel = grpc.insecure_channel(f"127.0.0.1:{port}")
    yield pb_grpc.NodeRuntimeStub(channel)
    channel.close()


def _make_request(node_name: str, inputs: Dict[str, Any], body: Any = None) -> pb.ExecuteRequest:
    return pb.ExecuteRequest(
        node=pb.NodeRef(name=node_name, type="runtime.python3", version=""),
        inputs=_encode_json_bytes(inputs),
        step=pb.StepInfo(name=node_name, index=0, total=1, depth=0),
        trigger=pb.TriggerInfo(
            body=_encode_json_bytes(body) if body is not None else b"",
            headers={"content-type": "application/json"} if body is not None else {},
            params={},
            query={},
            cookies={},
            method="POST",
            url="/",
            base_url="",
            trigger_kind="http",
        ),
        state=pb.RuntimeState(previous_output=b"", vars=b"", env={}),
        workflow=pb.WorkflowInfo(
            run_id="test-run",
            name="test-wf",
            path="/test",
            version="1.0.0",
            started_at=None,
        ),
        options=pb.ExecuteOptions(deadline_ms=5000, stream_logs=False, capture_metrics=True, hints={}),
    )


# =============================================================================
# Tests
# =============================================================================


def test_execute_returns_success_with_unwrapped_inputs(client):
    """Closes FIXES.md #3 at the wire layer for Python: inputs arrive UNWRAPPED."""
    inputs = {"msg": "hello", "n": 42}
    response = client.Execute(_make_request("echo", inputs))

    assert response.success is True
    assert response.error.code == ""  # default empty proto value
    assert json.loads(response.data) == inputs


def test_execute_greet_node_uses_inputs_and_body(client):
    """Cross-runtime parity: same inputs/body produce the same shape Rust does."""
    response = client.Execute(_make_request("greet", {"prefix": "Hi"}, {"name": "Blok"}))

    assert response.success is True
    data = json.loads(response.data)
    assert data["message"] == "Hi, Blok!"
    assert data["language"] == "python3"


def test_execute_returns_structured_error_for_missing_node(client):
    response = client.Execute(_make_request("does-not-exist", {}))

    assert response.success is False
    err = response.error
    assert err.code == "PYTHON_NODE_ERROR"
    assert err.category == pb.ErrorCategory.INTERNAL
    assert err.runtime_kind == "runtime.python3"
    assert err.sdk == "blok-python3"
    assert "not found" in err.message.lower()


def test_health_reports_serving_with_registered_nodes(client):
    response = client.Health(pb.HealthRequest(service="blok.runtime.v1.NodeRuntime"))

    assert response.status == pb.HealthResponse.Status.SERVING
    assert response.sdk_version == "1.0.0-test"
    assert "echo" in response.registered_nodes
    assert "greet" in response.registered_nodes


def test_list_nodes_returns_registered_descriptors(client):
    response = client.ListNodes(pb.ListNodesRequest())

    assert response.sdk_name == "blok-python3"
    assert response.sdk_version == "1.0.0-test"
    assert response.proto_version == "1.0.0"
    names = {n.name for n in response.nodes}
    assert {"echo", "greet"}.issubset(names)


def test_execute_stream_is_unimplemented(client):
    with pytest.raises(grpc.RpcError) as excinfo:
        list(client.ExecuteStream(_make_request("echo", {})))

    assert excinfo.value.code() == grpc.StatusCode.UNIMPLEMENTED
