use std::collections::HashMap;

use crate::registry::NodeRegistry;
use crate::types::{Context, ExecutionRequest, ExecutionResult, NodeConfig, Request, Response};

/// MockContext builder for creating test contexts.
pub struct MockContext {
    ctx: Context,
}

impl MockContext {
    /// Create a new mock context with defaults.
    pub fn new() -> Self {
        Self {
            ctx: Context {
                id: "test-execution-id".into(),
                workflow_name: "test-workflow".into(),
                workflow_path: "/workflows/test".into(),
                request: Request {
                    body: serde_json::json!({}),
                    headers: HashMap::new(),
                    params: HashMap::new(),
                    query: HashMap::new(),
                    method: "POST".into(),
                    url: "/test".into(),
                    cookies: HashMap::new(),
                    base_url: "http://localhost:8080".into(),
                },
                response: Response::default(),
                vars: HashMap::new(),
                env: HashMap::new(),
            },
        }
    }

    /// Set the execution ID.
    pub fn with_id(mut self, id: &str) -> Self {
        self.ctx.id = id.into();
        self
    }

    /// Set the workflow name and path.
    pub fn with_workflow(mut self, name: &str, path: &str) -> Self {
        self.ctx.workflow_name = name.into();
        self.ctx.workflow_path = path.into();
        self
    }

    /// Set the request body.
    pub fn with_body(mut self, body: serde_json::Value) -> Self {
        self.ctx.request.body = body;
        self
    }

    /// Set the request headers.
    pub fn with_headers(mut self, headers: HashMap<String, String>) -> Self {
        self.ctx.request.headers = headers;
        self
    }

    /// Set the request method.
    pub fn with_method(mut self, method: &str) -> Self {
        self.ctx.request.method = method.into();
        self
    }

    /// Set a context variable.
    pub fn with_var(mut self, key: &str, value: serde_json::Value) -> Self {
        self.ctx.vars.insert(key.into(), value);
        self
    }

    /// Set an environment variable.
    pub fn with_env(mut self, key: &str, value: &str) -> Self {
        self.ctx.env.insert(key.into(), value.into());
        self
    }

    /// Build the context.
    pub fn build(self) -> Context {
        self.ctx
    }
}

impl Default for MockContext {
    fn default() -> Self {
        Self::new()
    }
}

/// TestNodeRunner executes nodes in-process for testing.
pub struct TestNodeRunner {
    registry: NodeRegistry,
}

impl TestNodeRunner {
    /// Create a new test runner.
    pub fn new() -> Self {
        Self {
            registry: NodeRegistry::new("test"),
        }
    }

    /// Register a node for testing.
    pub fn register<H: crate::node::NodeHandler + 'static>(
        &mut self,
        name: &str,
        handler: H,
    ) -> &mut Self {
        self.registry.register(name, handler);
        self
    }

    /// Execute a node with the given context and config.
    pub async fn execute(
        &self,
        name: &str,
        ctx: Context,
        config: HashMap<String, serde_json::Value>,
    ) -> ExecutionResult {
        let mut req = ExecutionRequest {
            node: NodeConfig {
                name: name.into(),
                path: "".into(),
                node_type: "".into(),
                config,
            },
            context: ctx,
        };
        self.registry.execute(&mut req).await
    }
}

impl Default for TestNodeRunner {
    fn default() -> Self {
        Self::new()
    }
}

/// Assert that a result is successful and return the data.
pub fn assert_success(result: &ExecutionResult) -> &serde_json::Value {
    assert!(result.success, "expected success but got error: {:?}", result.errors);
    &result.data
}

/// Assert that a result is an error and return the error value.
pub fn assert_error(result: &ExecutionResult) -> &serde_json::Value {
    assert!(!result.success, "expected error but got success: {:?}", result.data);
    result.errors.as_ref().expect("expected errors field")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mock_context_defaults() {
        let ctx = MockContext::new().build();
        assert!(!ctx.id.is_empty());
        assert_eq!(ctx.request.method, "POST");
    }

    #[test]
    fn test_mock_context_builder() {
        let ctx = MockContext::new()
            .with_id("custom")
            .with_body(serde_json::json!({"name": "test"}))
            .with_var("key", serde_json::json!("val"))
            .build();

        assert_eq!(ctx.id, "custom");
        assert_eq!(ctx.request.body["name"], "test");
        assert_eq!(ctx.vars["key"], "val");
    }
}
