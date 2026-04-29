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
import threading
import time
from concurrent import futures
from typing import Any, Dict, Iterator, List, Optional, Tuple

import grpc
from google.protobuf import timestamp_pb2

from blok.errors.blok_error import (
    BlokError,
    DEFAULT_RUNTIME_KIND,
    DEFAULT_SDK_NAME,
    ErrorCategory,
    ErrorSeverity,
)
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
             :data:`NODE_LOGGER_NAME` logger **as they happen** while the
             node executes (real-time, not buffered — Phase 5 follow-up)
          3. one terminal :class:`pb.ExecuteResponse` carrying the same payload
             as a unary :meth:`Execute` would return

        # Real-time streaming model

        The handler runs on a worker thread (via
        :class:`threading.Thread`) so the generator's main loop can
        block on the log queue with a short timeout. Every time a log
        record is enqueued the loop wakes, yields a ``LogLine`` proto,
        and goes back to polling. When the worker thread completes the
        loop drains any remaining records (preserving causal order
        with respect to the final response) and yields the
        ``ExecuteResponse``.

        # Why a thread (not asyncio)

        The :class:`NodeRegistry` interface is sync (
        ``execute(request) -> result``) and node handlers may call
        blocking I/O (``requests.post``, DB drivers, etc.) without
        wrapping each call in ``run_in_executor``. A thread keeps the
        contract simple and matches the gRPC server's existing
        thread-pool model — the gRPC ThreadPoolExecutor already
        dispatches concurrent calls onto threads, and our worker
        thread is just one more worker for the duration of one call.

        # Log capture isolation

        Logs are captured via a per-call handler attached to the
        :data:`NODE_LOGGER_NAME` logger. Concurrent ``ExecuteStream``
        calls running on the gRPC pool each install their own
        handler; ``logging`` itself serializes ``emit()`` so
        ``queue.SimpleQueue`` is the right primitive (no extra lock
        needed). The handler is removed in ``finally`` so a crashed
        worker thread doesn't leave dangling handlers on the
        process-wide root logger.
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

        # Run the handler on a worker thread so we can stream logs as
        # they happen. ``result_box`` carries the success result (one
        # entry on success, none on exception); ``error_box`` carries a
        # surfaced exception so we can re-raise on the main thread for
        # gRPC to translate into a status. The worker is daemon=True
        # so a stuck handler can't block process shutdown.
        result_box: list = []
        error_box: list = []

        def run_handler() -> None:
            try:
                result_box.append(self._registry.execute(execution_request))
            except BaseException as exc:  # noqa: BLE001 — surface to main thread
                error_box.append(exc)

        worker = threading.Thread(target=run_handler, daemon=True, name="blok-execute-stream-worker")

        try:
            worker.start()
            # Real-time streaming loop: wake every 50 ms to either yield
            # a buffered log frame or to check whether the worker has
            # finished. A 50 ms tick is short enough that human
            # observers see logs land "instantly" in Studio's SSE
            # stream while keeping wakeup overhead negligible (~20
            # checks/second).
            while worker.is_alive():
                try:
                    record = log_queue.get(timeout=0.05)
                except queue.Empty:
                    continue
                yield pb.ExecuteEvent(log=_log_record_to_proto(record))

            # Worker is done. Drain any logs the worker emitted between
            # our last `get(timeout=0.05)` and its final return so they
            # arrive before the final frame.
            while True:
                try:
                    record = log_queue.get_nowait()
                except queue.Empty:
                    break
                yield pb.ExecuteEvent(log=_log_record_to_proto(record))
        finally:
            node_logger.removeHandler(handler)
            node_logger.propagate = previous_propagate
            node_logger.setLevel(previous_level)

        # Surface any exception the worker thread caught.
        if error_box:
            raise error_box[0]

        # ``result_box`` always has exactly one element when the
        # worker completed without exception (registry.execute()
        # never raises — it converts handler errors into a failed
        # ExecutionResult).
        result = result_box[0]

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
    data_bytes = b""
    if result.success and result.data is not None:
        data_bytes = _encode_json_bytes(result.data)

    vars_delta_bytes = b""
    if result.vars:
        vars_delta_bytes = _encode_json_bytes(result.vars)

    # Phase 0 follow-up: populate `response_bytes` so Studio's run-detail
    # Inspector shows the gRPC wire size next to the runner-measured
    # request_bytes. We approximate via `len(data) + len(vars_delta)` —
    # matches the runner's request_bytes approximation, so the two
    # numbers in the Inspector are comparable.
    response_bytes = len(data_bytes) + len(vars_delta_bytes)

    metrics = None
    if result.metrics is not None or response_bytes > 0:
        metrics = pb.Metrics(
            duration_ms=(result.metrics.duration_ms if result.metrics else 0) or 0.0,
            cpu_ms=(result.metrics.cpu_ms if result.metrics else 0) or 0.0,
            memory_bytes=int((result.metrics.memory_bytes if result.metrics else 0) or 0),
            request_bytes=0,
            response_bytes=response_bytes,
        )

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
    """Build a proto ``NodeError`` from whatever ``ExecutionResult.errors`` carries.

    Two paths:

    * **Structured (preferred)** — ``err`` is a :class:`BlokError`. All 19
      fields serialize losslessly via :func:`_blok_error_to_proto`. Auto-fills
      ``node``/``sdk``/``sdk_version``/``runtime_kind`` if the BlokError didn't
      set them itself.
    * **Loose** — ``err`` is a dict / string / None / Exception. Wrapped via
      :meth:`BlokError.from_unknown` (always produces ``category=INTERNAL``
      with the original payload preserved in ``details_json``) and then
      serialized via the structured path.

    Both paths produce the same proto shape, so the runner's gRPC codec
    consumes them identically.
    """
    if isinstance(err, BlokError):
        return _blok_error_to_proto(
            _enrich(err, node_name=node_name, sdk_version=sdk_version),
        )

    wrapped = BlokError.from_unknown(
        err,
        node=node_name,
        sdk=DEFAULT_SDK_NAME,
        sdk_version=sdk_version,
        runtime_kind=DEFAULT_RUNTIME_KIND,
    )
    return _blok_error_to_proto(wrapped)


def _enrich(err: BlokError, *, node_name: str, sdk_version: str) -> BlokError:
    """Fill in any missing auto-enrichment fields on a handler-thrown BlokError."""
    if not err.node:
        err.node = node_name
    if not err.sdk:
        err.sdk = DEFAULT_SDK_NAME
    if not err.sdk_version:
        err.sdk_version = sdk_version
    if not err.runtime_kind:
        err.runtime_kind = DEFAULT_RUNTIME_KIND
    return err


def _blok_error_to_proto(err: BlokError) -> pb.NodeError:
    """Serialize a fully-populated :class:`BlokError` into the proto wire format.

    The cause chain is serialized as a list of ``pb.NodeError`` messages; each
    element is the chain link's payload with its own ``causes`` list emptied
    (the cause chain has already been flattened by ``BlokError`` at construction
    time, so nesting at the wire layer would double-count).
    """
    at_ts = timestamp_pb2.Timestamp()
    at_ts.FromDatetime(err.at)

    return pb.NodeError(
        code=err.code,
        category=_PROTO_CATEGORY[err.category],
        severity=_PROTO_SEVERITY[err.severity],
        node=err.node,
        sdk=err.sdk,
        sdk_version=err.sdk_version,
        runtime_kind=err.runtime_kind,
        at=at_ts,
        message=err.message,
        description=err.description,
        remediation=err.remediation,
        doc_url=err.doc_url,
        causes=[_cause_dict_to_proto(c) for c in err.causes],
        stack=err.stack,
        context_snapshot_json=_encode_json_bytes(err.context_snapshot) if err.context_snapshot is not None else b"",
        http_status=err.http_status,
        retryable=err.retryable,
        retry_after_ms=err.retry_after_ms,
        details_json=_encode_json_bytes(err.details) if err.details is not None else b"",
    )


def _cause_dict_to_proto(cause: Dict[str, Any]) -> pb.NodeError:
    """Convert a flattened cause-chain dict (from ``BlokError.causes``) into proto.

    Each element is one link from a `BlokError` cause chain — already a flat
    list, so we don't recurse into the link's own causes.
    """
    at_str = cause.get("at")
    at_ts = timestamp_pb2.Timestamp()
    if isinstance(at_str, str):
        try:
            at_ts.FromJsonString(at_str)
        except Exception:  # pragma: no cover — defensive
            at_ts.GetCurrentTime()
    else:
        at_ts.GetCurrentTime()

    category = _parse_category_name(cause.get("category"))
    severity = _parse_severity_name(cause.get("severity"))
    return pb.NodeError(
        code=str(cause.get("code", "")),
        category=_PROTO_CATEGORY[category],
        severity=_PROTO_SEVERITY[severity],
        node=str(cause.get("node", "")),
        sdk=str(cause.get("sdk", "")),
        sdk_version=str(cause.get("sdk_version", "")),
        runtime_kind=str(cause.get("runtime_kind", "")),
        at=at_ts,
        message=str(cause.get("message", "")),
        description=str(cause.get("description", "")),
        remediation=str(cause.get("remediation", "")),
        doc_url=str(cause.get("doc_url", "")),
        causes=[],
        stack=str(cause.get("stack", "")),
        context_snapshot_json=_encode_json_bytes(cause.get("context_snapshot"))
        if cause.get("context_snapshot") is not None
        else b"",
        http_status=int(cause.get("http_status", 500)),
        retryable=bool(cause.get("retryable", False)),
        retry_after_ms=int(cause.get("retry_after_ms", 0)),
        details_json=_encode_json_bytes(cause.get("details")) if cause.get("details") is not None else b"",
    )


def _parse_category_name(value: Any) -> ErrorCategory:
    if isinstance(value, ErrorCategory):
        return value
    if isinstance(value, str):
        try:
            return ErrorCategory(value)
        except ValueError:
            pass
    return ErrorCategory.INTERNAL


def _parse_severity_name(value: Any) -> ErrorSeverity:
    if isinstance(value, ErrorSeverity):
        return value
    if isinstance(value, str):
        try:
            return ErrorSeverity(value)
        except ValueError:
            pass
    return ErrorSeverity.ERROR


# Map the SDK-side ErrorCategory enum (string values) to the proto-generated
# integer enum. Single source of truth; failures fall back to INTERNAL.
_PROTO_CATEGORY: Dict[ErrorCategory, int] = {
    ErrorCategory.VALIDATION: pb.ErrorCategory.VALIDATION,
    ErrorCategory.CONFIGURATION: pb.ErrorCategory.CONFIGURATION,
    ErrorCategory.DEPENDENCY: pb.ErrorCategory.DEPENDENCY,
    ErrorCategory.TIMEOUT: pb.ErrorCategory.TIMEOUT,
    ErrorCategory.PERMISSION: pb.ErrorCategory.PERMISSION,
    ErrorCategory.RATE_LIMIT: pb.ErrorCategory.RATE_LIMIT,
    ErrorCategory.NOT_FOUND: pb.ErrorCategory.NOT_FOUND,
    ErrorCategory.CONFLICT: pb.ErrorCategory.CONFLICT,
    ErrorCategory.CANCELLED: pb.ErrorCategory.CANCELLED,
    ErrorCategory.INTERNAL: pb.ErrorCategory.INTERNAL,
    ErrorCategory.PROTOCOL: pb.ErrorCategory.PROTOCOL,
    ErrorCategory.DATA: pb.ErrorCategory.DATA,
}

_PROTO_SEVERITY: Dict[ErrorSeverity, int] = {
    ErrorSeverity.INFO: pb.ErrorSeverity.INFO,
    ErrorSeverity.WARN: pb.ErrorSeverity.WARN,
    ErrorSeverity.ERROR: pb.ErrorSeverity.ERROR,
    ErrorSeverity.FATAL: pb.ErrorSeverity.FATAL,
}


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
