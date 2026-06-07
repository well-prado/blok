use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use crate::blok_error::BlokError;
use crate::middleware::Middleware;
use crate::node::NodeHandler;
use crate::types::{ExecutionMetrics, ExecutionRequest, ExecutionResult, HealthStatus};

/// NodeRegistry manages registered node handlers and dispatches execution requests.
pub struct NodeRegistry {
    nodes: HashMap<String, Arc<dyn NodeHandler>>,
    middlewares: Vec<Arc<dyn Middleware>>,
    version: String,
}

impl NodeRegistry {
    /// Create a new registry with the given runtime version.
    pub fn new(version: &str) -> Self {
        Self {
            nodes: HashMap::new(),
            middlewares: Vec::new(),
            version: version.to_string(),
        }
    }

    /// Register a node handler under the given name.
    pub fn register<H: NodeHandler + 'static>(&mut self, name: &str, handler: H) {
        self.nodes.insert(name.to_string(), Arc::new(handler));
    }

    /// v0.7 — register a typed node (SPEC-B P3). Wraps the [`TypedNode`] in a
    /// [`TypedNodeHandler`] (auto-validation + schema reflection) and registers
    /// it under its own `name()`.
    ///
    /// [`TypedNode`]: crate::node::TypedNode
    /// [`TypedNodeHandler`]: crate::node::TypedNodeHandler
    pub fn register_typed<T: crate::node::TypedNode + 'static>(&mut self, node: T) {
        let name = node.name().to_string();
        self.register(&name, crate::node::TypedNodeHandler(node));
    }

    /// Add middleware to the registry.
    pub fn use_middleware<M: Middleware + 'static>(&mut self, middleware: M) {
        self.middlewares.push(Arc::new(middleware));
    }

    /// Look up a node handler by name.
    pub fn get(&self, name: &str) -> Option<Arc<dyn NodeHandler>> {
        self.nodes.get(name).cloned()
    }

    /// Return the names of all registered nodes.
    pub fn node_names(&self) -> Vec<String> {
        self.nodes.keys().cloned().collect()
    }

    /// Execute a node by dispatching through the registry.
    pub async fn execute(&self, req: &mut ExecutionRequest) -> ExecutionResult {
        let handler = match self.get(&req.node.name) {
            Some(h) => h,
            None => {
                return ExecutionResult::error(&format!(
                    "node '{}' not found in registry",
                    req.node.name
                ));
            }
        };

        // Apply middleware chain
        let mut wrapped = handler;
        for mw in &self.middlewares {
            wrapped = mw.wrap(wrapped);
        }

        let start = Instant::now();

        match wrapped.execute(&mut req.context, &req.node.config).await {
            Ok(data) => {
                let duration_ms = start.elapsed().as_secs_f64() * 1000.0;
                let mut result = ExecutionResult::success_with_metrics(
                    data,
                    ExecutionMetrics {
                        duration_ms: Some(duration_ms),
                        ..Default::default()
                    },
                );
                // Include context vars so the runner can propagate them downstream
                if !req.context.vars.is_empty() {
                    result.vars = Some(req.context.vars.clone());
                }
                result
            }
            Err(err) => {
                let duration_ms = start.elapsed().as_secs_f64() * 1000.0;
                // Structured BlokError path (master plan §17): preserve the
                // typed instance verbatim so the gRPC servicer can serialize
                // every field. Box::downcast consumes the box on success.
                let mut result = match err.downcast::<BlokError>() {
                    Ok(boxed) => ExecutionResult::from_blok_error(*boxed),
                    Err(other) => ExecutionResult::error(&other.to_string()),
                };
                result.metrics = Some(ExecutionMetrics {
                    duration_ms: Some(duration_ms),
                    ..Default::default()
                });
                result
            }
        }
    }

    /// Return the health status.
    pub fn health(&self) -> HealthStatus {
        HealthStatus {
            status: "healthy".to_string(),
            version: self.version.clone(),
            nodes_loaded: self.node_names(),
        }
    }

    /// Return the number of registered nodes.
    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    /// Return whether the registry is empty.
    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::MockContext;
    use async_trait::async_trait;

    struct TestNode {
        data: serde_json::Value,
    }

    #[async_trait]
    impl NodeHandler for TestNode {
        async fn execute(
            &self,
            _ctx: &mut crate::types::Context,
            _config: &HashMap<String, serde_json::Value>,
        ) -> Result<serde_json::Value, Box<dyn std::error::Error + Send + Sync>> {
            Ok(self.data.clone())
        }
    }

    #[tokio::test]
    async fn test_register_and_execute() {
        let mut registry = NodeRegistry::new("1.0.0");
        registry.register("test", TestNode {
            data: serde_json::json!({"msg": "hello"}),
        });

        let mut req = ExecutionRequest {
            node: crate::types::NodeConfig {
                name: "test".into(),
                path: "".into(),
                node_type: "".into(),
                config: HashMap::new(),
            },
            context: MockContext::new().build(),
        };

        let result = registry.execute(&mut req).await;
        assert!(result.success);
        assert_eq!(result.data["msg"], "hello");
        assert!(result.metrics.unwrap().duration_ms.is_some());
    }

    #[tokio::test]
    async fn test_execute_not_found() {
        let registry = NodeRegistry::new("1.0.0");
        let mut req = ExecutionRequest {
            node: crate::types::NodeConfig {
                name: "missing".into(),
                path: "".into(),
                node_type: "".into(),
                config: HashMap::new(),
            },
            context: MockContext::new().build(),
        };

        let result = registry.execute(&mut req).await;
        assert!(!result.success);
    }

    #[test]
    fn test_health() {
        let mut registry = NodeRegistry::new("2.0.0");
        registry.register("a", TestNode { data: serde_json::json!(null) });
        registry.register("b", TestNode { data: serde_json::json!(null) });

        let health = registry.health();
        assert_eq!(health.status, "healthy");
        assert_eq!(health.version, "2.0.0");
        assert_eq!(health.nodes_loaded.len(), 2);
    }
}
