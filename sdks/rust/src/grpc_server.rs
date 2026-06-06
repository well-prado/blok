//! gRPC server implementing the canonical Blok `NodeRuntime` v1 service.
//!
//! Wire contract: `proto/blok/runtime/v1/runtime.proto`. Generated stubs are
//! produced by `tonic-build` at compile time (see `build.rs`).
//!
//! Architecture
//! ------------
//! - `BlokNodeRuntime` is the tonic service implementation. It owns an `Arc`
//!   to the `NodeRegistry` shared with the HTTP server (so a single registry
//!   serves both transports).
//! - `serve_grpc()` builds the tonic transport and blocks until shutdown.
//! - The codec helpers (`encode_*` / `decode_*`) sit at the boundary between
//!   proto and the SDK's internal types; everything else in the SDK keeps
//!   working unchanged.
//!
//! The proto sends `inputs`, `previous_output`, `vars`, and the request
//! `body` as raw JSON-encoded `bytes`. The SDK JSON-decodes them lazily.

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::Mutex;
use tonic::{Request, Response, Status};
use tracing::info;

use crate::blok_error::{BlokError, BlokErrorCategory, BlokErrorSeverity, Origin};
use crate::registry::NodeRegistry;
use crate::types::{Context, ExecutionRequest, ExecutionResult, NodeConfig, Request as SdkRequest, Response as SdkResponse};

/// tonic-generated module from `proto/blok/runtime/v1/runtime.proto`.
pub mod proto {
    tonic::include_proto!("blok.runtime.v1");
}

use proto::node_runtime_server::{NodeRuntime, NodeRuntimeServer};
use proto::{
    ExecuteRequest as ProtoExecuteRequest, ExecuteResponse as ProtoExecuteResponse,
    ExecuteEvent as ProtoExecuteEvent, HealthRequest as ProtoHealthRequest,
    HealthResponse as ProtoHealthResponse, ListNodesRequest as ProtoListNodesRequest,
    ListNodesResponse as ProtoListNodesResponse, NodeDescriptor as ProtoNodeDescriptor,
    NodeError as ProtoNodeError, ErrorCategory as ProtoErrorCategory,
    ErrorSeverity as ProtoErrorSeverity, Metrics as ProtoMetrics,
    health_response::Status as HealthStatusEnum,
};

/// gRPC implementation of the Blok `NodeRuntime` v1 service.
///
/// Single Responsibility: translate proto messages into the SDK's internal
/// `ExecutionRequest`/`ExecutionResult` and dispatch to `NodeRegistry`.
/// All node-level error handling lives in `NodeRegistry::execute`.
pub struct BlokNodeRuntime {
    registry: Arc<Mutex<NodeRegistry>>,
    sdk_version: String,
}

impl BlokNodeRuntime {
    /// Create a new service instance bound to a shared registry.
    pub fn new(registry: Arc<Mutex<NodeRegistry>>, sdk_version: impl Into<String>) -> Self {
        Self {
            registry,
            sdk_version: sdk_version.into(),
        }
    }
}

#[tonic::async_trait]
impl NodeRuntime for BlokNodeRuntime {
    /// Unary `Execute`: decode → dispatch → encode.
    async fn execute(
        &self,
        request: Request<ProtoExecuteRequest>,
    ) -> Result<Response<ProtoExecuteResponse>, Status> {
        let req = request.into_inner();
        let mut exec_req = decode_execute_request(req)?;

        let registry = self.registry.lock().await;
        let result = registry.execute(&mut exec_req).await;

        let proto_response = encode_execute_response(result, &exec_req.node.name, &self.sdk_version);
        Ok(Response::new(proto_response))
    }

    /// Server-streaming variant of `Execute`.
    ///
    /// Emits, in order:
    ///   1. one `NodeStarted` event marking call acceptance
    ///   2. one terminal `ExecuteResponse` carrying the same payload as the
    ///      unary `Execute` would return
    ///
    /// Log capture (`LogLine` events) is intentionally out of scope for the
    /// Phase 5 Rust pilot — `NodeHandler::execute` has no per-call logger
    /// sink, so threading one through would change the SDK API. Real-time
    /// log streaming for Rust arrives in a follow-up.
    type ExecuteStreamStream = tokio_stream::Iter<std::vec::IntoIter<Result<ProtoExecuteEvent, Status>>>;

    async fn execute_stream(
        &self,
        request: Request<ProtoExecuteRequest>,
    ) -> Result<Response<Self::ExecuteStreamStream>, Status> {
        let req = request.into_inner();
        let mut exec_req = decode_execute_request(req)?;
        let node_name = exec_req.node.name.clone();

        let started_event = ProtoExecuteEvent {
            event: Some(proto::execute_event::Event::Started(proto::NodeStarted {
                at: Some(now_timestamp()),
            })),
        };

        let registry = self.registry.lock().await;
        let result = registry.execute(&mut exec_req).await;
        let final_response = encode_execute_response(result, &node_name, &self.sdk_version);

        let final_event = ProtoExecuteEvent {
            event: Some(proto::execute_event::Event::Final(final_response)),
        };

        let events = vec![Ok(started_event), Ok(final_event)];
        Ok(Response::new(tokio_stream::iter(events.into_iter())))
    }

    /// Health check (wire-compatible with `grpc.health.v1.Health/Check`).
    async fn health(
        &self,
        _request: Request<ProtoHealthRequest>,
    ) -> Result<Response<ProtoHealthResponse>, Status> {
        let registry = self.registry.lock().await;
        let registered = registry.node_names();
        Ok(Response::new(ProtoHealthResponse {
            status: HealthStatusEnum::Serving as i32,
            sdk_version: self.sdk_version.clone(),
            registered_nodes: registered,
        }))
    }

    /// Discover registered nodes (drives Studio + OpenAPI generation).
    async fn list_nodes(
        &self,
        _request: Request<ProtoListNodesRequest>,
    ) -> Result<Response<ProtoListNodesResponse>, Status> {
        let registry = self.registry.lock().await;
        let descriptors: Vec<ProtoNodeDescriptor> = registry
            .node_names()
            .into_iter()
            .map(|name| ProtoNodeDescriptor {
                name,
                description: String::new(),
                input_schema_json: Vec::new(),
                output_schema_json: Vec::new(),
                tags: Vec::new(),
            })
            .collect();
        Ok(Response::new(ProtoListNodesResponse {
            nodes: descriptors,
            sdk_name: "blok-rust".to_string(),
            sdk_version: self.sdk_version.clone(),
            proto_version: "1.0.0".to_string(),
        }))
    }
}

/// Start the gRPC server. Blocks until shutdown.
pub async fn serve_grpc(
    registry: Arc<Mutex<NodeRegistry>>,
    port: u16,
    sdk_version: impl Into<String>,
    max_message_bytes: usize,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let addr = format!("0.0.0.0:{}", port).parse()?;
    let service = BlokNodeRuntime::new(registry, sdk_version);

    info!(
        "Blok gRPC server (NodeRuntime v1) listening on port {} (max message size {} bytes)",
        port, max_message_bytes
    );

    // Apply the configurable max message size to BOTH decode (incoming
    // ExecuteRequest) and encode (outgoing ExecuteResponse). tonic's own
    // default is only 4 MiB, so leaving these unset would reject payloads the
    // 16 MiB+ runner client sends. Must match BLOK_GRPC_MAX_MESSAGE_BYTES.
    tonic::transport::Server::builder()
        .add_service(
            NodeRuntimeServer::new(service)
                .max_decoding_message_size(max_message_bytes)
                .max_encoding_message_size(max_message_bytes),
        )
        .serve(addr)
        .await?;

    Ok(())
}

// =============================================================================
// Codec — proto ↔ internal types
// =============================================================================

/// Build a `prost_types::Timestamp` from the current wall clock. Returns
/// epoch-zero on systems where the clock is set before 1970 (impossible in
/// practice; defensive programming).
fn now_timestamp() -> prost_types::Timestamp {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    prost_types::Timestamp {
        seconds: now.as_secs() as i64,
        nanos: now.subsec_nanos() as i32,
    }
}

/// Decode a proto `ExecuteRequest` into the SDK's internal `ExecutionRequest`.
///
/// The opaque JSON-shaped fields (`inputs`, `previous_output`, `vars`, request
/// `body`) arrive as raw `Vec<u8>` and are JSON-decoded here. This matches the
/// SDK's existing internal `ExecutionRequest` shape so `NodeRegistry::execute`
/// runs unchanged regardless of which transport delivered the request.
fn decode_execute_request(req: ProtoExecuteRequest) -> Result<ExecutionRequest, Status> {
    let node_ref = req
        .node
        .ok_or_else(|| Status::invalid_argument("ExecuteRequest.node is required"))?;
    let trigger = req.trigger.unwrap_or_default();
    let state = req.state.unwrap_or_default();
    let workflow = req.workflow.unwrap_or_default();

    let inputs_map: HashMap<String, serde_json::Value> = decode_json_object(&req.inputs)
        .map_err(|e| Status::invalid_argument(format!("invalid `inputs` JSON: {}", e)))?;

    let previous_output: serde_json::Value = decode_json_value(&state.previous_output)
        .map_err(|e| Status::invalid_argument(format!("invalid `previous_output` JSON: {}", e)))?;

    let vars: HashMap<String, serde_json::Value> = decode_json_object(&state.vars)
        .map_err(|e| Status::invalid_argument(format!("invalid `vars` JSON: {}", e)))?;

    let body: serde_json::Value = decode_request_body(&trigger.body, &trigger.headers);

    let context = Context {
        id: workflow.run_id,
        workflow_name: workflow.name,
        workflow_path: workflow.path,
        request: SdkRequest {
            body,
            headers: trigger.headers,
            params: trigger.params,
            query: trigger.query,
            method: trigger.method,
            url: trigger.url,
            cookies: trigger.cookies,
            base_url: trigger.base_url,
        },
        response: SdkResponse {
            data: previous_output,
            content_type: "application/json".to_string(),
            success: true,
            error: serde_json::Value::Null,
        },
        vars,
        env: state.env,
    };

    Ok(ExecutionRequest {
        node: NodeConfig {
            name: node_ref.name,
            path: String::new(),
            node_type: node_ref.r#type,
            config: inputs_map,
        },
        context,
    })
}

/// Encode the SDK's internal `ExecutionResult` into a proto `ExecuteResponse`.
fn encode_execute_response(
    mut result: ExecutionResult,
    node_name: &str,
    sdk_version: &str,
) -> ProtoExecuteResponse {
    let data_bytes = if result.success {
        encode_json_bytes(&result.data)
    } else {
        Vec::new()
    };

    let vars_delta_bytes = match &result.vars {
        Some(vars) if !vars.is_empty() => encode_json_bytes(&serde_json::json!(vars)),
        _ => Vec::new(),
    };

    // Phase 0 follow-up: populate `response_bytes` so Studio's
    // run-detail Inspector shows the gRPC wire size next to the
    // runner-measured request_bytes. Approximated via JSON-payload
    // length (data + vars_delta) — matches the runner's own
    // request_bytes approximation, so the two numbers shown side-by-
    // side in the Inspector are comparable.
    let response_bytes = (data_bytes.len() + vars_delta_bytes.len()) as i64;

    let metrics = if result.metrics.is_some() || response_bytes > 0 {
        let m = result.metrics.as_ref();
        Some(ProtoMetrics {
            duration_ms: m.and_then(|m| m.duration_ms).unwrap_or(0.0),
            cpu_ms: m.and_then(|m| m.cpu_ms).unwrap_or(0.0),
            memory_bytes: m.and_then(|m| m.memory_bytes).unwrap_or(0) as i64,
            request_bytes: 0,
            response_bytes,
        })
    } else {
        None
    };

    let error = if result.success {
        None
    } else {
        Some(internal_error_to_proto(
            result.blok_error.take(),
            result.errors.as_ref(),
            node_name,
            sdk_version,
        ))
    };

    ProtoExecuteResponse {
        success: result.success,
        data: data_bytes,
        content_type: "application/json".to_string(),
        error,
        vars_delta: vars_delta_bytes,
        logs: Vec::new(),
        metrics,
    }
}

/// Build a proto `NodeError` from whatever `ExecutionResult` carried.
///
/// Two paths, both producing the same proto shape:
///
/// * **Structured (preferred)** — `blok_err` is `Some(BlokError)` produced by a
///   handler returning a typed [`crate::BlokError`]. All 19 fields serialize
///   losslessly via [`blok_error_to_proto`]. Auto-fills
///   `node`/`sdk`/`sdk_version`/`runtime_kind` if the BlokError didn't set
///   them itself.
/// * **Loose** — `blok_err` is `None` and `loose_err` carries the legacy
///   `{"message": ...}` JSON. Wrapped via [`BlokError::from_message`] (always
///   produces `category=INTERNAL` with the original payload preserved in
///   `details_json`) and then serialized via the structured path.
fn internal_error_to_proto(
    blok_err: Option<BlokError>,
    loose_err: Option<&serde_json::Value>,
    node_name: &str,
    sdk_version: &str,
) -> ProtoNodeError {
    let origin = Origin::defaults(node_name, sdk_version);
    if let Some(mut err) = blok_err {
        err.apply_origin_if_missing(&origin);
        return blok_error_to_proto(&err);
    }

    let fallback = loose_err.cloned().unwrap_or_else(|| serde_json::json!({"message": "node error"}));
    let message = fallback
        .get("message")
        .and_then(|v| v.as_str())
        .unwrap_or("node error")
        .to_string();

    // Preserve the original JSON payload as details_json so consumers don't
    // lose any fields the legacy path attached.
    let mut wrapped = BlokError::from_message(message, &origin);
    wrapped.details = Some(fallback);
    blok_error_to_proto(&wrapped)
}

/// Serialize a fully-populated `BlokError` into the proto wire format. The
/// cause chain is serialized as a list of proto `NodeError` messages; each
/// element's own `causes` list is left empty (the chain is already flat at
/// the BlokError layer, so nesting at the wire layer would double-count).
fn blok_error_to_proto(err: &BlokError) -> ProtoNodeError {
    let causes: Vec<ProtoNodeError> = err.causes.iter().map(cause_value_to_proto).collect();
    ProtoNodeError {
        code: err.code.clone(),
        category: category_to_proto(err.category) as i32,
        severity: severity_to_proto(err.severity) as i32,
        node: err.node.clone(),
        sdk: err.sdk.clone(),
        sdk_version: err.sdk_version.clone(),
        runtime_kind: err.runtime_kind.clone(),
        at: Some(prost_timestamp_from_chrono(&err.at)),
        message: err.message.clone(),
        description: err.description.clone(),
        remediation: err.remediation.clone(),
        doc_url: err.doc_url.clone(),
        causes,
        stack: err.stack.clone(),
        context_snapshot_json: encode_optional_json_bytes(err.context_snapshot.as_ref()),
        http_status: err.http_status,
        retryable: err.retryable,
        retry_after_ms: err.retry_after_ms,
        details_json: encode_optional_json_bytes(err.details.as_ref()),
    }
}

/// Convert one cause-chain link (already a JSON value of the snake_case wire
/// shape) into a proto `NodeError`. Mirrors Go's `causeMapToProto`.
fn cause_value_to_proto(cause: &serde_json::Value) -> ProtoNodeError {
    let s = |key: &str| -> String {
        cause
            .get(key)
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_default()
    };
    let i32_field = |key: &str, default: i32| -> i32 {
        cause
            .get(key)
            .and_then(|v| v.as_i64())
            .map(|n| n as i32)
            .unwrap_or(default)
    };
    let i64_field = |key: &str, default: i64| -> i64 {
        cause.get(key).and_then(|v| v.as_i64()).unwrap_or(default)
    };
    let bool_field = |key: &str, default: bool| -> bool {
        cause
            .get(key)
            .and_then(|v| v.as_bool())
            .unwrap_or(default)
    };
    let category = BlokErrorCategory::parse(&s("category"));
    let severity = BlokErrorSeverity::parse(&s("severity"));
    let at = match cause.get("at").and_then(|v| v.as_str()) {
        Some(text) => parse_timestamp(text).unwrap_or_else(now_timestamp),
        None => now_timestamp(),
    };
    ProtoNodeError {
        code: s("code"),
        category: category_to_proto(category) as i32,
        severity: severity_to_proto(severity) as i32,
        node: s("node"),
        sdk: s("sdk"),
        sdk_version: s("sdk_version"),
        runtime_kind: s("runtime_kind"),
        at: Some(at),
        message: s("message"),
        description: s("description"),
        remediation: s("remediation"),
        doc_url: s("doc_url"),
        causes: Vec::new(),
        stack: s("stack"),
        context_snapshot_json: encode_optional_json_bytes(cause.get("context_snapshot")),
        http_status: i32_field("http_status", 500),
        retryable: bool_field("retryable", false),
        retry_after_ms: i64_field("retry_after_ms", 0),
        details_json: encode_optional_json_bytes(cause.get("details")),
    }
}

fn category_to_proto(c: BlokErrorCategory) -> ProtoErrorCategory {
    match c {
        BlokErrorCategory::Validation => ProtoErrorCategory::Validation,
        BlokErrorCategory::Configuration => ProtoErrorCategory::Configuration,
        BlokErrorCategory::Dependency => ProtoErrorCategory::Dependency,
        BlokErrorCategory::Timeout => ProtoErrorCategory::Timeout,
        BlokErrorCategory::Permission => ProtoErrorCategory::Permission,
        BlokErrorCategory::RateLimit => ProtoErrorCategory::RateLimit,
        BlokErrorCategory::NotFound => ProtoErrorCategory::NotFound,
        BlokErrorCategory::Conflict => ProtoErrorCategory::Conflict,
        BlokErrorCategory::Cancelled => ProtoErrorCategory::Cancelled,
        BlokErrorCategory::Internal => ProtoErrorCategory::Internal,
        BlokErrorCategory::Protocol => ProtoErrorCategory::Protocol,
        BlokErrorCategory::Data => ProtoErrorCategory::Data,
    }
}

fn severity_to_proto(s: BlokErrorSeverity) -> ProtoErrorSeverity {
    match s {
        BlokErrorSeverity::Info => ProtoErrorSeverity::Info,
        BlokErrorSeverity::Warn => ProtoErrorSeverity::Warn,
        BlokErrorSeverity::Error => ProtoErrorSeverity::Error,
        BlokErrorSeverity::Fatal => ProtoErrorSeverity::Fatal,
    }
}

fn prost_timestamp_from_chrono(at: &chrono::DateTime<chrono::Utc>) -> prost_types::Timestamp {
    prost_types::Timestamp {
        seconds: at.timestamp(),
        nanos: at.timestamp_subsec_nanos() as i32,
    }
}

fn parse_timestamp(text: &str) -> Option<prost_types::Timestamp> {
    chrono::DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|dt| prost_types::Timestamp {
            seconds: dt.timestamp(),
            nanos: dt.timestamp_subsec_nanos() as i32,
        })
}

fn encode_optional_json_bytes(value: Option<&serde_json::Value>) -> Vec<u8> {
    match value {
        Some(v) if !v.is_null() => encode_json_bytes(v),
        _ => Vec::new(),
    }
}

/// Decode a JSON-bytes field into a typed map. Empty bytes → empty map.
fn decode_json_object(
    bytes: &[u8],
) -> Result<HashMap<String, serde_json::Value>, serde_json::Error> {
    if bytes.is_empty() {
        return Ok(HashMap::new());
    }
    let value: serde_json::Value = serde_json::from_slice(bytes)?;
    match value {
        serde_json::Value::Object(map) => Ok(map.into_iter().collect()),
        // For non-object payloads we wrap into a single-key map so SDK code
        // accustomed to a HashMap doesn't crash. Rare in practice.
        other => {
            let mut wrapped = HashMap::new();
            wrapped.insert("_value".to_string(), other);
            Ok(wrapped)
        }
    }
}

/// Decode a JSON-bytes field into an arbitrary `serde_json::Value`. Empty
/// bytes → `Value::Null`.
fn decode_json_value(bytes: &[u8]) -> Result<serde_json::Value, serde_json::Error> {
    if bytes.is_empty() {
        return Ok(serde_json::Value::Null);
    }
    serde_json::from_slice(bytes)
}

/// Decode the trigger body. JSON content-types parse as JSON; everything else
/// arrives as a raw string for the node to interpret.
fn decode_request_body(
    bytes: &[u8],
    headers: &HashMap<String, String>,
) -> serde_json::Value {
    if bytes.is_empty() {
        return serde_json::Value::Null;
    }

    let content_type = headers
        .get("content-type")
        .or_else(|| headers.get("Content-Type"))
        .map(|s| s.as_str())
        .unwrap_or("");

    if content_type.contains("application/json") {
        // Best effort: if JSON parse fails, fall through to raw string.
        if let Ok(v) = serde_json::from_slice::<serde_json::Value>(bytes) {
            return v;
        }
    }

    match std::str::from_utf8(bytes) {
        Ok(s) => serde_json::Value::String(s.to_string()),
        Err(_) => serde_json::Value::String(String::new()),
    }
}

/// Encode a JSON value as UTF-8 bytes. Errors fall back to empty buffer (the
/// proto receiver treats empty as `null`).
fn encode_json_bytes(value: &serde_json::Value) -> Vec<u8> {
    serde_json::to_vec(value).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_json_object_handles_empty_bytes() {
        let map = decode_json_object(&[]).unwrap();
        assert!(map.is_empty());
    }

    #[test]
    fn decode_json_object_parses_real_object() {
        let bytes = b"{\"a\":1,\"b\":\"x\"}";
        let map = decode_json_object(bytes).unwrap();
        assert_eq!(map.get("a"), Some(&serde_json::json!(1)));
        assert_eq!(map.get("b"), Some(&serde_json::json!("x")));
    }

    #[test]
    fn decode_json_object_wraps_non_object_payloads() {
        let bytes = b"[1,2,3]";
        let map = decode_json_object(bytes).unwrap();
        assert_eq!(map.get("_value"), Some(&serde_json::json!([1, 2, 3])));
    }

    #[test]
    fn decode_json_value_handles_empty_bytes() {
        let value = decode_json_value(&[]).unwrap();
        assert!(value.is_null());
    }

    #[test]
    fn decode_request_body_parses_json_when_content_type_says_so() {
        let mut headers = HashMap::new();
        headers.insert("content-type".to_string(), "application/json".to_string());
        let body = decode_request_body(b"{\"hello\":\"world\"}", &headers);
        assert_eq!(body, serde_json::json!({"hello": "world"}));
    }

    #[test]
    fn decode_request_body_falls_back_to_string_for_non_json_content_type() {
        let headers = HashMap::new();
        let body = decode_request_body(b"hello", &headers);
        assert_eq!(body, serde_json::Value::String("hello".to_string()));
    }

    #[test]
    fn encode_json_bytes_round_trips() {
        let value = serde_json::json!({"a": 1});
        let bytes = encode_json_bytes(&value);
        let restored: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(restored, value);
    }
}
