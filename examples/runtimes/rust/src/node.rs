use async_trait::async_trait;
use std::collections::HashMap;

use crate::types::Context;

/// NodeHandler is the core trait that all Blok nodes must implement.
///
/// # Example
///
/// ```rust
/// use async_trait::async_trait;
/// use blok::{NodeHandler, Context};
/// use std::collections::HashMap;
///
/// struct MyNode;
///
/// #[async_trait]
/// impl NodeHandler for MyNode {
///     async fn execute(
///         &self,
///         ctx: &mut Context,
///         config: &HashMap<String, serde_json::Value>,
///     ) -> Result<serde_json::Value, Box<dyn std::error::Error + Send + Sync>> {
///         let name = ctx.request.body.get("name")
///             .and_then(|v| v.as_str())
///             .unwrap_or("World");
///
///         Ok(serde_json::json!({ "message": format!("Hello, {}!", name) }))
///     }
/// }
/// ```
#[async_trait]
pub trait NodeHandler: Send + Sync {
    /// Execute the node logic with the given workflow context and node configuration.
    ///
    /// - `ctx`: Mutable reference to the workflow context. Nodes can read from
    ///   `ctx.request`, write to `ctx.vars` for downstream nodes, etc.
    /// - `config`: Node-specific configuration from the workflow definition.
    ///
    /// Returns the output data as a JSON value on success, or an error.
    async fn execute(
        &self,
        ctx: &mut Context,
        config: &HashMap<String, serde_json::Value>,
    ) -> Result<serde_json::Value, Box<dyn std::error::Error + Send + Sync>>;
}
