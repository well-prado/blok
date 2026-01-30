//! # blok-rs
//!
//! Rust SDK for the Blok blok workflow orchestration framework.
//!
//! Build workflow nodes in Rust that integrate with the Blok runner via HTTP or gRPC.
//!
//! ## Quick Start
//!
//! ```rust,no_run
//! use async_trait::async_trait;
//! use blok::{NodeHandler, NodeRegistry, Context};
//! use std::collections::HashMap;
//!
//! struct GreetNode;
//!
//! #[async_trait]
//! impl NodeHandler for GreetNode {
//!     async fn execute(
//!         &self,
//!         ctx: &mut Context,
//!         config: &HashMap<String, serde_json::Value>,
//!     ) -> Result<serde_json::Value, Box<dyn std::error::Error + Send + Sync>> {
//!         let name = ctx.request.body.get("name")
//!             .and_then(|v| v.as_str())
//!             .unwrap_or("World");
//!         Ok(serde_json::json!({ "message": format!("Hello, {}!", name) }))
//!     }
//! }
//! ```

pub mod config;
pub mod errors;
#[cfg(feature = "grpc")]
pub mod grpc_server;
pub mod logging;
pub mod middleware;
pub mod node;
pub mod nodes;
pub mod registry;
#[cfg(feature = "http")]
pub mod server;
pub mod testing;
pub mod types;
pub mod validation;

// Re-export core types
pub use config::ServerConfig;
pub use errors::{ErrorCategory, NodeError};
pub use logging::{LogEntry, LogLevel, Logger};
pub use middleware::Middleware;
pub use node::NodeHandler;
pub use registry::NodeRegistry;
pub use types::{
    Context, ExecutionMetrics, ExecutionRequest, ExecutionResult, HealthStatus, NodeConfig,
    Request, Response,
};
pub use validation::SchemaValidator;
