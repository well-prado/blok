use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use crate::node::NodeHandler;
use crate::types::{ExecutionMetrics, ExecutionRequest, ExecutionResult, HealthStatus};

/// NodeRegistry manages registered node handlers and dispatches execution requests.
///
/// Thread-safe via `Arc<dyn NodeHandler>` — multiple requests can execute
/// concurrently against the same registry.
pub struct NodeRegistry {
    nodes: HashMap<String, Arc<dyn NodeHandler>>,
    version: String,
}

impl NodeRegistry {
    /// Create a new registry with the given runtime version string.
    pub fn new(version: &str) -> Self {
        Self {
            nodes: HashMap::new(),
            version: version.to_string(),
        }
    }

    /// Register a node handler under the given name.
    pub fn register<H: NodeHandler + 'static>(&mut self, name: &str, handler: H) {
        self.nodes.insert(name.to_string(), Arc::new(handler));
    }

    /// Look up a node handler by name.
    pub fn get(&self, name: &str) -> Option<Arc<dyn NodeHandler>> {
        self.nodes.get(name).cloned()
    }

    /// Execute a node by dispatching through the registry.
    ///
    /// Automatically measures execution duration and returns it in metrics.
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

        let start = Instant::now();

        match handler.execute(&mut req.context, &req.node.config).await {
            Ok(data) => {
                let duration_ms = start.elapsed().as_secs_f64() * 1000.0;
                ExecutionResult::success_with_metrics(
                    data,
                    ExecutionMetrics {
                        duration_ms: Some(duration_ms),
                        ..Default::default()
                    },
                )
            }
            Err(err) => {
                let duration_ms = start.elapsed().as_secs_f64() * 1000.0;
                let mut result = ExecutionResult::error(&err.to_string());
                result.metrics = Some(ExecutionMetrics {
                    duration_ms: Some(duration_ms),
                    ..Default::default()
                });
                result
            }
        }
    }

    /// Return the health status of this runtime, including loaded node names.
    pub fn health(&self) -> HealthStatus {
        HealthStatus {
            status: "healthy".to_string(),
            version: self.version.clone(),
            nodes_loaded: self.nodes.keys().cloned().collect(),
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
