use async_trait::async_trait;
use serde_json::{json, Value};
use std::collections::HashMap;

use crate::node::NodeHandler;
use crate::types::Context;

/// ChainTestNode is used in cross-runtime integration tests.
/// It reads a chain array from the request body, appends its own entry,
/// and returns the updated chain — proving data flows between languages.
pub struct ChainTestNode;

#[async_trait]
impl NodeHandler for ChainTestNode {
    async fn execute(
        &self,
        ctx: &mut Context,
        _config: &HashMap<String, Value>,
    ) -> Result<Value, Box<dyn std::error::Error + Send + Sync>> {
        // Read existing chain from request body
        let mut chain: Vec<Value> = ctx
            .request
            .body
            .get("chain")
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default();

        // Read origin
        let origin = ctx
            .request
            .body
            .get("origin")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();

        // Append this language's entry
        let order = chain.len() + 1;
        let entry = json!({
            "language": "rust",
            "order": order,
            "timestamp": chrono::Utc::now().to_rfc3339(),
        });
        chain.push(entry);

        // Store in context vars
        ctx.vars
            .insert("chain".to_string(), json!(chain));

        Ok(json!({
            "chain": chain,
            "origin": origin,
        }))
    }
}
