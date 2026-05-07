use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Context represents the workflow execution context passed between nodes.
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

impl Context {
    /// Store a variable in context for downstream nodes.
    pub fn set_var(&mut self, key: &str, value: serde_json::Value) {
        self.vars.insert(key.to_string(), value);
    }

    /// Retrieve a variable from context.
    pub fn get_var(&self, key: &str) -> Option<&serde_json::Value> {
        self.vars.get(key)
    }

    /// Retrieve a string variable from context.
    pub fn get_var_str(&self, key: &str) -> Option<&str> {
        self.vars.get(key).and_then(|v| v.as_str())
    }
}

/// Request represents the incoming HTTP request data.
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

impl Request {
    /// Get a field from the body as a string.
    pub fn body_str(&self, key: &str) -> Option<&str> {
        self.body.get(key).and_then(|v| v.as_str())
    }

    /// Get a field from the body as a typed value.
    pub fn body_as<T: serde::de::DeserializeOwned>(&self) -> Result<T, serde_json::Error> {
        serde_json::from_value(self.body.clone())
    }
}

/// Response represents the workflow response.
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

/// NodeConfig represents node-specific configuration from the runner.
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

impl NodeConfig {
    /// Get a string config value with a default.
    pub fn config_str(&self, key: &str, default: &str) -> String {
        self.config
            .get(key)
            .and_then(|v| v.as_str())
            .unwrap_or(default)
            .to_string()
    }

    /// Get an integer config value with a default.
    pub fn config_i64(&self, key: &str, default: i64) -> i64 {
        self.config
            .get(key)
            .and_then(|v| v.as_i64())
            .unwrap_or(default)
    }

    /// Get a boolean config value with a default.
    pub fn config_bool(&self, key: &str, default: bool) -> bool {
        self.config
            .get(key)
            .and_then(|v| v.as_bool())
            .unwrap_or(default)
    }
}

/// ExecutionRequest is the request received from the Blok runner.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionRequest {
    pub node: NodeConfig,
    pub context: Context,
}

/// ExecutionResult is the response returned to the Blok runner.
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vars: Option<HashMap<String, serde_json::Value>>,

    /// Structured error per master plan §17. When the handler returned a
    /// typed `BlokError`, the registry stashes the instance here verbatim so
    /// the gRPC servicer can serialize every field (category, severity,
    /// remediation, retry hints, cause chain, context snapshot) into the
    /// proto `NodeError`. The `errors` field above mirrors the message for
    /// HTTP / loose-JSON consumers.
    #[serde(skip)]
    pub blok_error: Option<crate::blok_error::BlokError>,
}

impl ExecutionResult {
    /// Create a successful result.
    pub fn success(data: serde_json::Value) -> Self {
        Self {
            success: true,
            data,
            errors: None,
            logs: None,
            metrics: None,
            vars: None,
            blok_error: None,
        }
    }

    /// Create a successful result with metrics.
    pub fn success_with_metrics(data: serde_json::Value, metrics: ExecutionMetrics) -> Self {
        Self {
            success: true,
            data,
            errors: None,
            logs: None,
            metrics: Some(metrics),
            vars: None,
            blok_error: None,
        }
    }

    /// Create an error result.
    pub fn error(message: &str) -> Self {
        Self {
            success: false,
            data: serde_json::Value::Null,
            errors: Some(serde_json::json!({ "message": message })),
            logs: None,
            metrics: None,
            vars: None,
            blok_error: None,
        }
    }

    /// Create an error result with details.
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
            vars: None,
            blok_error: None,
        }
    }

    /// Create an error result from a structured `BlokError`. The instance is
    /// preserved verbatim on `blok_error` (for the gRPC servicer) and a
    /// best-effort JSON projection is mirrored into `errors` (for HTTP /
    /// loose-JSON consumers).
    pub fn from_blok_error(err: crate::blok_error::BlokError) -> Self {
        let json = err.to_json_value();
        Self {
            success: false,
            data: serde_json::Value::Null,
            errors: Some(json),
            logs: None,
            metrics: None,
            vars: None,
            blok_error: Some(err),
        }
    }

    /// Attach log entries to the result.
    pub fn with_logs(mut self, logs: Vec<String>) -> Self {
        self.logs = Some(logs);
        self
    }

    /// Attach metrics to the result.
    pub fn with_metrics(mut self, metrics: ExecutionMetrics) -> Self {
        self.metrics = Some(metrics);
        self
    }

    /// Attach context variables to the result.
    pub fn with_vars(mut self, vars: HashMap<String, serde_json::Value>) -> Self {
        self.vars = Some(vars);
        self
    }
}

/// ExecutionMetrics captures performance metrics for a node execution.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ExecutionMetrics {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_bytes: Option<u64>,
}

/// HealthStatus represents the health status of the runtime.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthStatus {
    pub status: String,
    pub version: String,
    pub nodes_loaded: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_context_vars() {
        let mut ctx = Context {
            id: "test".into(),
            workflow_name: "wf".into(),
            workflow_path: "/wf".into(),
            request: Request::default(),
            response: Response::default(),
            vars: HashMap::new(),
            env: HashMap::new(),
        };

        ctx.set_var("key", serde_json::json!("value"));
        assert_eq!(ctx.get_var_str("key"), Some("value"));
        assert_eq!(ctx.get_var("missing"), None);
    }

    #[test]
    fn test_execution_result_json_roundtrip() {
        let result = ExecutionResult::success(serde_json::json!({"msg": "hi"}))
            .with_metrics(ExecutionMetrics {
                duration_ms: Some(12.5),
                ..Default::default()
            });

        let json = serde_json::to_string(&result).unwrap();
        let restored: ExecutionResult = serde_json::from_str(&json).unwrap();

        assert!(restored.success);
        assert_eq!(restored.data["msg"], "hi");
        assert!(restored.metrics.unwrap().duration_ms.unwrap() > 12.0);
    }

    #[test]
    fn test_error_result() {
        let result = ExecutionResult::error("something broke");
        assert!(!result.success);
        assert!(result.errors.is_some());
    }

    #[test]
    fn test_node_config_helpers() {
        let config = NodeConfig {
            name: "test".into(),
            path: "".into(),
            node_type: "".into(),
            config: HashMap::from([
                ("prefix".into(), serde_json::json!("Hi")),
                ("count".into(), serde_json::json!(5)),
                ("enabled".into(), serde_json::json!(true)),
            ]),
        };

        assert_eq!(config.config_str("prefix", "Hello"), "Hi");
        assert_eq!(config.config_str("missing", "default"), "default");
        assert_eq!(config.config_i64("count", 0), 5);
        assert_eq!(config.config_bool("enabled", false), true);
    }

    #[test]
    fn test_health_status() {
        let health = HealthStatus {
            status: "healthy".into(),
            version: "1.0.0".into(),
            nodes_loaded: vec!["hello-world".into()],
        };
        let json = serde_json::to_string(&health).unwrap();
        assert!(json.contains("healthy"));
    }
}
