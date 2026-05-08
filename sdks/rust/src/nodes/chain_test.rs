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
        config: &HashMap<String, Value>,
    ) -> Result<Value, Box<dyn std::error::Error + Send + Sync>> {
        // Read existing chain — gRPC inputs first (carried on
        // `node.config`), HTTP body fallback (legacy wire shape where
        // the runner mapped resolvedInputs → request.body). Dual-read
        // keeps the cross-runtime-chain demo working over both
        // transports during the §11 deprecation window.
        let mut chain: Vec<Value> = config
            .get("chain")
            .and_then(|v| v.as_array().cloned())
            .or_else(|| ctx.request.body.get("chain").and_then(|v| v.as_array().cloned()))
            .unwrap_or_default();

        // Read origin — same dual-read.
        let origin = config
            .get("origin")
            .and_then(|v| v.as_str())
            .or_else(|| ctx.request.body.get("origin").and_then(|v| v.as_str()))
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
