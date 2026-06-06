//! End-to-end gRPC test for the Rust SDK.
//!
//! Spins up the `BlokNodeRuntime` server on a random port, connects with a
//! tonic-generated client, and exercises every RPC the v1 contract defines:
//!
//! - `Execute` — happy path with a registered node + the unwrapped-inputs
//!   contract verified.
//! - `Execute` — failure path (node not found) returns success=false with a
//!   structured `NodeError` on the response body.
//! - `Health` — returns SERVING with the SDK version + registered nodes.
//! - `ListNodes` — returns the registered node names.
//! - `ExecuteStream` — Phase 5 minimum (NodeStarted + final).

#![cfg(feature = "grpc")]

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use blok::grpc_server::proto;
use blok::grpc_server::proto::node_runtime_client::NodeRuntimeClient;
use blok::grpc_server::proto::{
    health_response::Status as HealthStatus, ExecuteOptions, ExecuteRequest as ProtoExecuteRequest,
    HealthRequest, ListNodesRequest, NodeRef, RuntimeState, StepInfo, TriggerInfo, WorkflowInfo,
};
use blok::grpc_server::serve_grpc;
use blok::registry::NodeRegistry;
use blok::types::Context;
use blok::NodeHandler;
use serde_json::json;
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tonic::transport::{Channel, Endpoint};

/// Trivial node that echoes its config back as data.
struct EchoNode;

#[async_trait]
impl NodeHandler for EchoNode {
    async fn execute(
        &self,
        _ctx: &mut Context,
        config: &HashMap<String, serde_json::Value>,
    ) -> Result<serde_json::Value, Box<dyn std::error::Error + Send + Sync>> {
        Ok(json!(config))
    }
}

/// Start a server on an OS-chosen port; return the bound port and a handle
/// to abort the server when the test ends.
async fn start_server() -> (u16, tokio::task::JoinHandle<()>) {
    // Reserve a free port via TcpListener, then close so the server can bind.
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind ephemeral");
    let port = listener.local_addr().unwrap().port();
    drop(listener);

    let mut registry = NodeRegistry::new("1.0.0-test");
    registry.register("echo", EchoNode);
    let shared = Arc::new(Mutex::new(registry));

    let handle = tokio::spawn(async move {
        // serve_grpc binds on 0.0.0.0:<port>; we connect via 127.0.0.1.
        let _ = serve_grpc(shared, port, "1.0.0-test", 16 * 1024 * 1024).await;
    });

    // Give the server a brief moment to bind.
    tokio::time::sleep(Duration::from_millis(150)).await;

    (port, handle)
}

async fn make_client(port: u16) -> NodeRuntimeClient<Channel> {
    let endpoint = Endpoint::from_shared(format!("http://127.0.0.1:{}", port))
        .expect("valid endpoint")
        .connect_timeout(Duration::from_secs(2));
    NodeRuntimeClient::connect(endpoint).await.expect("connect to server")
}

fn empty_request(node_name: &str, inputs: serde_json::Value) -> ProtoExecuteRequest {
    ProtoExecuteRequest {
        node: Some(NodeRef {
            name: node_name.to_string(),
            r#type: "runtime.rust".to_string(),
            version: String::new(),
        }),
        inputs: serde_json::to_vec(&inputs).unwrap(),
        step: Some(StepInfo {
            name: node_name.to_string(),
            index: 0,
            total: 1,
            depth: 0,
        }),
        trigger: Some(TriggerInfo {
            body: vec![],
            headers: HashMap::new(),
            params: HashMap::new(),
            query: HashMap::new(),
            cookies: HashMap::new(),
            method: String::new(),
            url: String::new(),
            base_url: String::new(),
            trigger_kind: "http".to_string(),
        }),
        state: Some(RuntimeState {
            previous_output: vec![],
            vars: vec![],
            env: HashMap::new(),
        }),
        workflow: Some(WorkflowInfo {
            run_id: "test-run".to_string(),
            name: "test-workflow".to_string(),
            path: "/test".to_string(),
            version: "1.0.0".to_string(),
            started_at: None,
        }),
        options: Some(ExecuteOptions {
            deadline_ms: 5000,
            stream_logs: false,
            capture_metrics: true,
            hints: HashMap::new(),
        }),
    }
}

#[tokio::test]
async fn execute_returns_success_with_unwrapped_inputs() {
    let (port, handle) = start_server().await;
    let mut client = make_client(port).await;

    let inputs = json!({ "msg": "hello", "n": 42 });
    let response = client
        .execute(empty_request("echo", inputs.clone()))
        .await
        .expect("Execute call should succeed")
        .into_inner();

    assert!(response.success);
    assert!(response.error.is_none());

    // The server echoes inputs back as data → verifies the SDK received the
    // inputs UNWRAPPED (no `{inputs:{...}}` envelope) — closes FIXES.md #3
    // at the proto wire layer for the Rust SDK.
    let data: serde_json::Value =
        serde_json::from_slice(&response.data).expect("data is JSON");
    assert_eq!(data, inputs);

    handle.abort();
}

#[tokio::test]
async fn execute_returns_structured_error_for_missing_node() {
    let (port, handle) = start_server().await;
    let mut client = make_client(port).await;

    let response = client
        .execute(empty_request("does-not-exist", json!({})))
        .await
        .expect("RPC itself should succeed; failure surfaces in the response body")
        .into_inner();

    assert!(!response.success);
    let err = response.error.expect("error populated on failure");
    assert!(!err.message.is_empty());
    assert_eq!(err.runtime_kind, "runtime.rust");
    assert_eq!(err.sdk, "blok-rust");

    handle.abort();
}

#[tokio::test]
async fn health_reports_serving_with_registered_nodes() {
    let (port, handle) = start_server().await;
    let mut client = make_client(port).await;

    let response = client
        .health(HealthRequest {
            service: "blok.runtime.v1.NodeRuntime".to_string(),
        })
        .await
        .expect("Health call should succeed")
        .into_inner();

    assert_eq!(response.status, HealthStatus::Serving as i32);
    assert_eq!(response.sdk_version, "1.0.0-test");
    assert!(response.registered_nodes.contains(&"echo".to_string()));

    handle.abort();
}

#[tokio::test]
async fn list_nodes_returns_registered_descriptors() {
    let (port, handle) = start_server().await;
    let mut client = make_client(port).await;

    let response = client
        .list_nodes(ListNodesRequest {})
        .await
        .expect("ListNodes call should succeed")
        .into_inner();

    assert_eq!(response.sdk_name, "blok-rust");
    assert_eq!(response.sdk_version, "1.0.0-test");
    assert_eq!(response.proto_version, "1.0.0");
    let names: Vec<&str> = response.nodes.iter().map(|n| n.name.as_str()).collect();
    assert!(names.contains(&"echo"));

    handle.abort();
}

#[tokio::test]
async fn execute_stream_emits_started_then_final() {
    use proto::execute_event::Event;

    let (port, handle) = start_server().await;
    let mut client = make_client(port).await;

    let response = client
        .execute_stream(empty_request("echo", json!({"shape": "round"})))
        .await
        .expect("ExecuteStream should return a streaming response");

    let mut stream = response.into_inner();
    let mut events: Vec<Event> = Vec::new();
    while let Some(item) = stream.message().await.expect("stream item should be Ok") {
        if let Some(event) = item.event {
            events.push(event);
        }
    }

    assert!(events.len() >= 2, "expected ≥ 2 events, got {}", events.len());
    assert!(matches!(events.first(), Some(Event::Started(_))), "first event should be NodeStarted");

    let final_event = events.last().expect("must have a final event");
    let Event::Final(final_response) = final_event else {
        panic!("last event should be Final, got {:?}", final_event);
    };
    assert!(final_response.success, "final.success should be true");
    let data: serde_json::Value =
        serde_json::from_slice(&final_response.data).expect("final.data is JSON");
    assert_eq!(data, json!({"shape": "round"}));

    handle.abort();
}
