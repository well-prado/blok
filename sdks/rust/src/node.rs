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
///         let name = ctx.request.body_str("name").unwrap_or("World");
///         Ok(serde_json::json!({ "message": format!("Hello, {}!", name) }))
///     }
/// }
/// ```
#[async_trait]
pub trait NodeHandler: Send + Sync {
    /// Execute the node logic with the given workflow context and node configuration.
    async fn execute(
        &self,
        ctx: &mut Context,
        config: &HashMap<String, serde_json::Value>,
    ) -> Result<serde_json::Value, Box<dyn std::error::Error + Send + Sync>>;
}

/// ValidatedNodeHandler extends NodeHandler with input/output schema support.
#[async_trait]
pub trait ValidatedNodeHandler: NodeHandler {
    /// Return the JSON Schema for validating input (request body).
    /// Return None to skip input validation.
    fn input_schema(&self) -> Option<serde_json::Value> {
        None
    }

    /// Return the JSON Schema for validating output (result data).
    /// Return None to skip output validation.
    fn output_schema(&self) -> Option<serde_json::Value> {
        None
    }
}
