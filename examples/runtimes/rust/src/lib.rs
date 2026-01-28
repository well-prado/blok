//! # Blok Rust Runtime SDK
//!
//! The Blok SDK for Rust provides everything needed to implement workflow nodes
//! in Rust and serve them via HTTP and gRPC to the Blok orchestrator.
//!
//! ## Quick Start
//!
//! ```rust,no_run
//! use async_trait::async_trait;
//! use blok::{NodeHandler, NodeRegistry, Context};
//! use std::collections::HashMap;
//!
//! struct MyNode;
//!
//! #[async_trait]
//! impl NodeHandler for MyNode {
//!     async fn execute(
//!         &self,
//!         ctx: &mut Context,
//!         config: &HashMap<String, serde_json::Value>,
//!     ) -> Result<serde_json::Value, Box<dyn std::error::Error + Send + Sync>> {
//!         Ok(serde_json::json!({ "result": "success" }))
//!     }
//! }
//!
//! #[tokio::main]
//! async fn main() {
//!     let mut registry = NodeRegistry::new("1.0.0");
//!     registry.register("my-node", MyNode);
//!     blok::server::serve(registry, 8080).await.unwrap();
//! }
//! ```

pub mod grpc_server;
pub mod node;
pub mod nodes;
pub mod registry;
pub mod server;
pub mod types;

// Re-export core types for convenience
pub use node::NodeHandler;
pub use registry::NodeRegistry;
pub use types::{
    Context, ExecutionMetrics, ExecutionRequest, ExecutionResult, HealthStatus, NodeConfig,
    Request, Response,
};
