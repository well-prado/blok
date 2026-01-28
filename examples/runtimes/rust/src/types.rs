use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Context represents the workflow execution context passed between nodes
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Context {
    pub id: String,
    #[serde(default)]
    pub workflow_name: String,
    #[serde(default)]
    pub workflow_path: String,
    pub request: Request,
    #[serde(default)]
    pub response: Response,
    #[serde(default)]
    pub vars: HashMap<String, serde_json::Value>,
    #[serde(default)]
    pub env: HashMap<String, String>,
}

/// Request represents the incoming HTTP request data
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Request {
    #[serde(default)]
    pub body: serde_json::Value,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub params: HashMap<String, String>,
    #[serde(default)]
    pub query: HashMap<String, String>,
    #[serde(default)]
    pub method: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub cookies: HashMap<String, String>,
    #[serde(default, rename = "baseUrl")]
    pub base_url: String,
}

/// Response represents the workflow response
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Response {
    #[serde(default)]
    pub data: serde_json::Value,
    #[serde(default, rename = "contentType")]
    pub content_type: String,
    #[serde(default)]
    pub success: bool,
    #[serde(default)]
    pub error: serde_json::Value,
}

/// NodeConfig represents node-specific configuration from the runner
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeConfig {
    pub name: String,
    #[serde(default)]
    pub path: String,
    #[serde(default, rename = "type")]
    pub node_type: String,
    #[serde(default)]
    pub config: HashMap<String, serde_json::Value>,
}

/// ExecutionRequest is the request received from the Blok runner
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionRequest {
    pub node: NodeConfig,
    pub context: Context,
}

/// ExecutionResult is the response returned to the Blok runner
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionResult {
    pub success: bool,
    pub data: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub errors: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logs: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metrics: Option<ExecutionMetrics>,
}

/// ExecutionMetrics captures performance metrics for a node execution
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ExecutionMetrics {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_bytes: Option<u64>,
}

/// HealthStatus represents the health status of the runtime
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthStatus {
    pub status: String,
    pub version: String,
    pub nodes_loaded: Vec<String>,
}

impl ExecutionResult {
    /// Create a successful result
    pub fn success(data: serde_json::Value) -> Self {
        Self {
            success: true,
            data,
            errors: None,
            logs: None,
            metrics: None,
        }
    }

    /// Create a successful result with metrics
    pub fn success_with_metrics(data: serde_json::Value, metrics: ExecutionMetrics) -> Self {
        Self {
            success: true,
            data,
            errors: None,
            logs: None,
            metrics: Some(metrics),
        }
    }

    /// Create an error result
    pub fn error(message: &str) -> Self {
        Self {
            success: false,
            data: serde_json::Value::Null,
            errors: Some(serde_json::json!({ "message": message })),
            logs: None,
            metrics: None,
        }
    }

    /// Create an error result with details
    pub fn error_with_details(message: &str, details: serde_json::Value) -> Self {
        Self {
            success: false,
            data: serde_json::Value::Null,
            errors: Some(serde_json::json!({
                "message": message,
                "details": details
            })),
            logs: None,
            metrics: None,
        }
    }
}
