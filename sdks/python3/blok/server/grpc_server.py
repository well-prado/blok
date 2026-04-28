"""gRPC server implementing the canonical Blok ``NodeRuntime`` v1 service.

Wire contract: ``proto/blok/runtime/v1/runtime.proto``. Generated stubs live
in :mod:`blok.runtime.v1`.

Architecture
------------
* :class:`BlokNodeRuntimeServicer` is the grpc-python service implementation.
  It owns a reference to a shared :class:`blok.node.node_registry.NodeRegistry`
  so a single registry can serve both HTTP and gRPC.
* :func:`serve_grpc` builds the grpc server, binds the port, and blocks until
  shutdown.
* The codec helpers (``_decode_*`` / ``_encode_*``) sit at the boundary between
  proto and the SDK's internal :class:`ExecutionRequest` / :class:`ExecutionResult`
  types so :class:`NodeRegistry` runs unchanged regardless of which transport
  delivered the request.

The proto sends ``inputs``, ``previous_output``, ``vars``, and the request
``body`` as raw JSON-encoded ``bytes``. The SDK JSON-decodes them lazily.

This module imports ``grpcio`` lazily — callers should import it only when the
``grpc`` optional extra is installed. ``__init__.py`` does NOT import this
module to keep the base SDK installable without grpcio.
"""
from __future__ import annotations

import json
import logging
import queue
import time
from concurrent import futures
from typing import Any, Dict, Iterator, List, Optional, Tuple

import grpc
from google.protobuf import timestamp_pb2

from blok.node.node_registry import NodeRegistry
from blok.types.context import Context, Request, Response
from blok.types.execution_request import ExecutionRequest, NodeConfig
from blok.types.execution_result import ExecutionResult

from blok.runtime.v1 import runtime_pb2 as pb
from blok.runtime.v1 import runtime_pb2_grpc as pb_grpc

logger = logging.getLogger("blok.grpc")

# Logger that node handlers should emit to in order to have their messages
# streamed back to the runner via ``ExecuteStream``. This is a deliberate
# convention: only events on this named logger are captured, so the handler
# doesn't have to filter out unrelated noise from third-party libraries.
NODE_LOGGER_NAME = "blok.node"

# =============================================================================
# Servicer
# =============================================================================


class BlokNodeRuntimeServicer(pb_grpc.NodeRuntimeServicer):
    """gRPC implementation of the Blok ``NodeRuntime`` v1 service.

    Single Responsibility: translate proto messages into the SDK's internal
    :class:`ExecutionRequest` / :class:`ExecutionResult` and dispatch to
    :class:`NodeRegistry`. All node-level error handling lives in
    ``NodeRegistry.execute``.
    """

    def __init__(self, registry: NodeRegistry, sdk_version: str = "1.0.0") -> None:
        self._registry = registry
        self._sdk_version = sdk_version

    # -- Execute ----------------------------------------------------------

    def Execute(self, request: pb.ExecuteRequest, context: grpc.ServicerContext) -> pb.ExecuteResponse:
        try:
            execution_request = _decode_execute_request(request)
        except _DecodeError as exc:
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, str(exc))
            return pb.ExecuteResponse()  # unreachable

        result = self._registry.execute(execution_request)

        return _encode_execute_response(
            result,
            node_name=execution_request.node.name,
            sdk_version=self._sdk_version,
        )

    # -- ExecuteStream ----------------------------------------------------

    def ExecuteStream(
        self,
        request: pb.ExecuteRequest,
        context: grpc.ServicerContext,
    ) -> Iterator[pb.ExecuteEvent]:
        """Server-streaming variant of :meth:`Execute`.

        Emits, in order:
          1. one :class:`pb.NodeStarted` event marking call acceptance
          2. zero or more :class:`pb.LogLine` events captured from the
             :data:`NODE_LOGGER_NAME` logger while the node executes
          3. one terminal :class:`pb.ExecuteResponse` carrying the same payload
             as a unary :meth:`Execute` would return

        Logs are captured via a thread-local handler so concurrent calls in
        the gRPC ThreadPoolExecutor don't cross-contaminate.
        """
        try:
            execution_request = _decode_execute_request(request)
        except _DecodeError as exc:
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, str(exc))
            return  # pragma: no cover — abort raises

        # NodeStarted goes out immediately so the runner can record start time
        # before the (potentially long) execute call.
        yield pb.ExecuteEvent(started=pb.NodeStarted(at=_now_timestamp()))

        log_queue: "queue.SimpleQueue[logging.LogRecord]" = queue.SimpleQueue()
        handler = _QueueLogHandler(log_queue)
        handler.setLevel(logging.DEBUG)
        node_logger = logging.getLogger(NODE_LOGGER_NAME)
        node_logger.addHandler(handler)
        previous_propagate = node_logger.propagate
        previous_level = node_logger.level
        node_logger.propagate = False
        # Lower the logger threshold to DEBUG so INFO/DEBUG messages from
        # the node aren't filtered out before the handler sees them. Restored
        # in the `finally` block so we don't leave the logger globally chatty.
        node_logger.setLevel(logging.DEBUG)

        try:
            result = self._registry.execute(execution_request)
        finally:
            node_logger.removeHandler(handler)
            node_logger.propagate = previous_propagate
            node_logger.setLevel(previous_level)

        # Drain captured logs before the final frame so the runner sees them
        # in causal order with respect to the response.
        while True:
            try:
                record = log_queue.get_nowait()
            except queue.Empty:
                break
            yield pb.ExecuteEvent(log=_log_record_to_proto(record))

        yield pb.ExecuteEvent(
            final=_encode_execute_response(
                result,
                node_name=execution_request.node.name,
                sdk_version=self._sdk_version,
            )
        )

    # -- Health -----------------------------------------------------------

    def Health(self, request: pb.HealthRequest, context: grpc.ServicerContext) -> pb.HealthResponse:
        return pb.HealthResponse(
            status=pb.HealthResponse.Status.SERVING,
            sdk_version=self._sdk_version,
            registered_nodes=self._registry.node_names(),
        )

    # -- ListNodes --------------------------------------------------------

    def ListNodes(self, request: pb.ListNodesRequest, context: grpc.ServicerContext) -> pb.ListNodesResponse:
        descriptors = [
            pb.NodeDescriptor(
                name=name,
                description="",
                input_schema_json=b"",
                output_schema_json=b"",
                tags=[],
            )
            for name in self._registry.node_names()
        ]
        return pb.ListNodesResponse(
            nodes=descriptors,
            sdk_name="blok-python3",
            sdk_version=self._sdk_version,
            proto_version="1.0.0",
        )


# =============================================================================
# Server lifecycle
# =============================================================================


def serve_grpc(
    registry: NodeRegistry,
    port: int,
    *,
    host: str = "0.0.0.0",
    sdk_version: str = "1.0.0",
    max_workers: int = 10,
    max_message_bytes: int = 16 * 1024 * 1024,
) -> grpc.Server:
    """Build, bind, and start the gRPC server.

    Returns the started :class:`grpc.Server` so callers can stop it cleanly.
    Does NOT block — call ``server.wait_for_termination()`` for blocking
    behavior, or ``server.stop(grace)`` to shut down.
    """
    options: List[Tuple[str, Any]] = [
        ("grpc.max_send_message_length", max_message_bytes),
        ("grpc.max_receive_message_length", max_message_bytes),
    ]

    server = grpc.server(
        futures.ThreadPoolExecutor(max_workers=max_workers),
        options=options,
    )
    pb_grpc.add_NodeRuntimeServicer_to_server(
        BlokNodeRuntimeServicer(registry, sdk_version),
        server,
    )
    bind_address = f"{host}:{port}"
    server.add_insecure_port(bind_address)
    server.start()
    logger.info(
        "Blok gRPC server (NodeRuntime v1) listening on %s with %d nodes registered",
        bind_address,
        len(registry.node_names()),
    )
    return server


# =============================================================================
# Codec — proto ↔ internal types
# =============================================================================


class _DecodeError(Exception):
    """Raised when an incoming proto message can't be decoded into internal types."""


def _decode_execute_request(req: pb.ExecuteRequest) -> ExecutionRequest:
    """Decode a proto ``ExecuteRequest`` into the SDK's ``ExecutionRequest``.

    The opaque JSON-shaped fields (``inputs``, ``previous_output``, ``vars``,
    request ``body``) arrive as raw ``bytes`` and are JSON-decoded here. This
    keeps :class:`NodeRegistry.execute` transport-agnostic.
    """
    if req.node is None or not req.node.name:
        raise _DecodeError("ExecuteRequest.node is required")

    inputs_map = _decode_json_object(req.inputs, "inputs")
    previous_output = _decode_json_value(req.state.previous_output, "previous_output")
    vars_map = _decode_json_object(req.state.vars, "vars")
    body = _decode_request_body(req.trigger.body, dict(req.trigger.headers))

    request = Request(
        body=body,
        headers=dict(req.trigger.headers),
        params=dict(req.trigger.params),
        query=dict(req.trigger.query),
        method=req.trigger.method,
        url=req.trigger.url,
        cookies=dict(req.trigger.cookies),
        base_url=req.trigger.base_url,
    )
    response = Response(
        data=previous_output,
        content_type="application/json",
        success=True,
        error=None,
    )

    context = Context(
        id=req.workflow.run_id,
        workflow_name=req.workflow.name,
        workflow_path=req.workflow.path,
        request=request,
        response=response,
        vars=vars_map,
        env=dict(req.state.env),
    )

    return ExecutionRequest(
        node=NodeConfig(
            name=req.node.name,
            type=req.node.type,
            config=inputs_map,
        ),
        context=context,
    )


def _encode_execute_response(
    result: ExecutionResult,
    *,
    node_name: str,
    sdk_version: str,
) -> pb.ExecuteResponse:
    """Encode the SDK's ``ExecutionResult`` into a proto ``ExecuteResponse``."""
    metrics = None
    if result.metrics is not None:
        metrics = pb.Metrics(
            duration_ms=result.metrics.duration_ms or 0.0,
            cpu_ms=result.metrics.cpu_ms or 0.0,
            memory_bytes=int(result.metrics.memory_bytes or 0),
            request_bytes=0,
            response_bytes=0,
        )

    data_bytes = b""
    if result.success and result.data is not None:
        data_bytes = _encode_json_bytes(result.data)

    vars_delta_bytes = b""
    if result.vars:
        vars_delta_bytes = _encode_json_bytes(result.vars)

    error_proto: Optional[pb.NodeError] = None
    if not result.success:
        error_proto = _internal_error_to_proto(
            result.errors,
            node_name=node_name,
            sdk_version=sdk_version,
        )

    return pb.ExecuteResponse(
        success=result.success,
        data=data_bytes,
        content_type="application/json",
        error=error_proto,
        vars_delta=vars_delta_bytes,
        logs=[],
        metrics=metrics,
    )


def _internal_error_to_proto(
    err: Any,
    *,
    node_name: str,
    sdk_version: str,
) -> pb.NodeError:
    """Build a proto ``NodeError`` from the SDK's loose JSON error shape.

    The SDK's current ``ExecutionResult.errors`` is an arbitrary value (often a
    ``{"message": "..."}`` dict). Until SDK code is migrated to produce
    structured errors natively, we synthesize one with category=INTERNAL and
    the original payload preserved in ``details_json``.
    """
    if isinstance(err, dict):
        message = str(err.get("message") or "node error")
        details_json = _encode_json_bytes(err)
    elif isinstance(err, str):
        message = err
        details_json = _encode_json_bytes({"message": err})
    elif err is None:
        message = "node error"
        details_json = b""
    else:
        message = str(err)
        details_json = _encode_json_bytes({"message": message})

    return pb.NodeError(
        code="PYTHON_NODE_ERROR",
        category=pb.ErrorCategory.INTERNAL,
        severity=pb.ErrorSeverity.ERROR,
        node=node_name,
        sdk="blok-python3",
        sdk_version=sdk_version,
        runtime_kind="runtime.python3",
        at=None,
        message=message,
        description="",
        remediation="",
        doc_url="",
        causes=[],
        stack="",
        context_snapshot_json=b"",
        http_status=500,
        retryable=False,
        retry_after_ms=0,
        details_json=details_json,
    )


def _decode_json_object(blob: bytes, field: str) -> Dict[str, Any]:
    """Decode a JSON-bytes field as a typed dict. Empty bytes → empty dict."""
    if not blob:
        return {}
    try:
        value = json.loads(blob)
    except json.JSONDecodeError as exc:
        raise _DecodeError(f"invalid `{field}` JSON: {exc}") from exc
    if isinstance(value, dict):
        return value
    # For non-object payloads we wrap into a single-key dict so SDK code
    # accustomed to a dict doesn't crash. Rare in practice.
    return {"_value": value}


def _decode_json_value(blob: bytes, field: str) -> Any:
    """Decode a JSON-bytes field as an arbitrary value. Empty bytes → ``None``."""
    if not blob:
        return None
    try:
        return json.loads(blob)
    except json.JSONDecodeError as exc:
        raise _DecodeError(f"invalid `{field}` JSON: {exc}") from exc


def _decode_request_body(blob: bytes, headers: Dict[str, str]) -> Any:
    """Decode the trigger body. JSON content-types parse as JSON; everything
    else arrives as a raw string for the node to interpret.
    """
    if not blob:
        return None

    content_type = headers.get("content-type") or headers.get("Content-Type") or ""
    if "application/json" in content_type:
        try:
            return json.loads(blob)
        except json.JSONDecodeError:
            pass  # fall through to raw-string handling

    try:
        return blob.decode("utf-8")
    except UnicodeDecodeError:
        return ""


def _encode_json_bytes(value: Any) -> bytes:
    """Encode a Python value as UTF-8 JSON bytes. Errors fall back to empty buffer."""
    try:
        return json.dumps(value).encode("utf-8")
    except (TypeError, ValueError):
        return b""


# =============================================================================
# Streaming helpers — used by ExecuteStream
# =============================================================================


class _QueueLogHandler(logging.Handler):
    """Logging handler that pushes records onto a :class:`queue.SimpleQueue`.

    Used by :meth:`BlokNodeRuntimeServicer.ExecuteStream` to capture log
    records emitted on the ``blok.node`` logger during a single ``execute``
    call. The queue is drained after execute completes; for fully real-time
    streaming the handler would need to coordinate with the generator (Phase 5
    follow-up).
    """

    def __init__(self, sink: "queue.SimpleQueue[logging.LogRecord]") -> None:
        super().__init__()
        self._sink = sink

    def emit(self, record: logging.LogRecord) -> None:
        self._sink.put(record)


def _now_timestamp() -> timestamp_pb2.Timestamp:
    """Build a proto Timestamp from the current wall clock."""
    ts = timestamp_pb2.Timestamp()
    ts.GetCurrentTime()
    return ts


def _log_record_to_proto(record: logging.LogRecord) -> pb.LogLine:
    """Convert a Python ``logging.LogRecord`` into a proto ``LogLine``."""
    ts = timestamp_pb2.Timestamp()
    ts.FromMilliseconds(int(record.created * 1000))

    attributes: Dict[str, str] = {}
    if record.name and record.name != NODE_LOGGER_NAME:
        attributes["logger"] = record.name
    if record.funcName:
        attributes["func"] = record.funcName

    return pb.LogLine(
        timestamp=ts,
        level=record.levelname.lower(),
        message=record.getMessage(),
        attributes=attributes,
    )
