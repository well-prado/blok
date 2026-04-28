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

    /// Streaming variant — Phase 5. Returns UNIMPLEMENTED for now.
    type ExecuteStreamStream = tokio_stream::Iter<std::vec::IntoIter<Result<ProtoExecuteEvent, Status>>>;

    async fn execute_stream(
        &self,
        _request: Request<ProtoExecuteRequest>,
    ) -> Result<Response<Self::ExecuteStreamStream>, Status> {
        Err(Status::unimplemented(
            "ExecuteStream is not implemented yet — opt out via stream_logs=false",
        ))
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
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let addr = format!("0.0.0.0:{}", port).parse()?;
    let service = BlokNodeRuntime::new(registry, sdk_version);

    info!(
        "Blok gRPC server (NodeRuntime v1) listening on port {}",
        port
    );

    tonic::transport::Server::builder()
        .add_service(NodeRuntimeServer::new(service))
        .serve(addr)
        .await?;

    Ok(())
}

// =============================================================================
// Codec — proto ↔ internal types
// =============================================================================

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
    result: ExecutionResult,
    node_name: &str,
    sdk_version: &str,
) -> ProtoExecuteResponse {
    let metrics = result.metrics.as_ref().map(|m| ProtoMetrics {
        duration_ms: m.duration_ms.unwrap_or(0.0),
        cpu_ms: m.cpu_ms.unwrap_or(0.0),
        memory_bytes: m.memory_bytes.unwrap_or(0) as i64,
        request_bytes: 0,
        response_bytes: 0,
    });

    let data_bytes = if result.success {
        encode_json_bytes(&result.data)
    } else {
        Vec::new()
    };

    let vars_delta_bytes = match &result.vars {
        Some(vars) if !vars.is_empty() => encode_json_bytes(&serde_json::json!(vars)),
        _ => Vec::new(),
    };

    let error = if result.success {
        None
    } else {
        Some(internal_error_to_proto(
            &result.errors.unwrap_or_else(|| serde_json::json!({"message": "unknown error"})),
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

/// Build a proto `NodeError` from the SDK's loose JSON error shape.
///
/// The SDK's current `ExecutionResult.errors` is `serde_json::Value` (loose).
/// Until SDK code is migrated to produce structured `NodeError`s natively,
/// we synthesize one with category=INTERNAL and the original message.
fn internal_error_to_proto(
    err: &serde_json::Value,
    node_name: &str,
    sdk_version: &str,
) -> ProtoNodeError {
    let message = err
        .get("message")
        .and_then(|v| v.as_str())
        .unwrap_or_else(|| "node error")
        .to_string();
    let details_json = encode_json_bytes(err);

    ProtoNodeError {
        code: "RUST_NODE_ERROR".to_string(),
        category: ProtoErrorCategory::Internal as i32,
        severity: ProtoErrorSeverity::Error as i32,
        node: node_name.to_string(),
        sdk: "blok-rust".to_string(),
        sdk_version: sdk_version.to_string(),
        runtime_kind: "runtime.rust".to_string(),
        at: None,
        message,
        description: String::new(),
        remediation: String::new(),
        doc_url: String::new(),
        causes: Vec::new(),
        stack: String::new(),
        context_snapshot_json: Vec::new(),
        http_status: 500,
        retryable: false,
        retry_after_ms: 0,
        details_json,
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
