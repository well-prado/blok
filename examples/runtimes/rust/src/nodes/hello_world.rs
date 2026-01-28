use async_trait::async_trait;
use std::collections::HashMap;

use crate::node::NodeHandler;
use crate::types::Context;

/// HelloWorldNode is an example Blok node implemented in Rust.
///
/// It reads an optional `name` from the request body, an optional `prefix`
/// from the node config, and returns a greeting message.
pub struct HelloWorldNode;

#[async_trait]
impl NodeHandler for HelloWorldNode {
    async fn execute(
        &self,
        ctx: &mut Context,
        config: &HashMap<String, serde_json::Value>,
    ) -> Result<serde_json::Value, Box<dyn std::error::Error + Send + Sync>> {
        // Get name from request body or use default
        let name = ctx
            .request
            .body
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("World");

        // Get greeting prefix from config or use default
        let prefix = config
            .get("prefix")
            .and_then(|v| v.as_str())
            .unwrap_or("Hello");

        let message = format!("{}, {}!", prefix, name);

        // Store in context vars for downstream nodes
        ctx.vars.insert(
            "greeting".to_string(),
            serde_json::Value::String(message.clone()),
        );
        ctx.vars.insert(
            "timestamp".to_string(),
            serde_json::json!(chrono::Utc::now().timestamp()),
        );

        // Return response
        Ok(serde_json::json!({
            "message": message,
            "timestamp": chrono::Utc::now().to_rfc3339(),
            "language": "Rust"
        }))
    }
}
