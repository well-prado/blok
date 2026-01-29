use async_trait::async_trait;
use std::collections::HashMap;

use crate::node::NodeHandler;
use crate::types::Context;

/// HelloWorldNode greets the user with a configurable prefix.
pub struct HelloWorldNode;

#[async_trait]
impl NodeHandler for HelloWorldNode {
    async fn execute(
        &self,
        ctx: &mut Context,
        config: &HashMap<String, serde_json::Value>,
    ) -> Result<serde_json::Value, Box<dyn std::error::Error + Send + Sync>> {
        let name = ctx
            .request
            .body
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("World");

        let prefix = config
            .get("prefix")
            .and_then(|v| v.as_str())
            .unwrap_or("Hello");

        let message = format!("{}, {}!", prefix, name);

        ctx.set_var("greeting", serde_json::Value::String(message.clone()));

        Ok(serde_json::json!({
            "message": message,
            "timestamp": chrono::Utc::now().to_rfc3339(),
            "language": "rust"
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::MockContext;

    #[tokio::test]
    async fn test_hello_world_default() {
        let node = HelloWorldNode;
        let mut ctx = MockContext::new().build();
        let result = node.execute(&mut ctx, &HashMap::new()).await.unwrap();
        assert_eq!(result["message"], "Hello, World!");
        assert_eq!(result["language"], "rust");
    }

    #[tokio::test]
    async fn test_hello_world_with_name() {
        let node = HelloWorldNode;
        let mut ctx = MockContext::new()
            .with_body(serde_json::json!({"name": "Blok"}))
            .build();
        let result = node.execute(&mut ctx, &HashMap::new()).await.unwrap();
        assert_eq!(result["message"], "Hello, Blok!");
    }

    #[tokio::test]
    async fn test_hello_world_with_prefix() {
        let node = HelloWorldNode;
        let mut ctx = MockContext::new()
            .with_body(serde_json::json!({"name": "World"}))
            .build();
        let config = HashMap::from([("prefix".into(), serde_json::json!("Hi"))]);
        let result = node.execute(&mut ctx, &config).await.unwrap();
        assert_eq!(result["message"], "Hi, World!");
    }

    #[tokio::test]
    async fn test_hello_world_sets_var() {
        let node = HelloWorldNode;
        let mut ctx = MockContext::new().build();
        node.execute(&mut ctx, &HashMap::new()).await.unwrap();
        assert!(ctx.get_var_str("greeting").is_some());
    }
}
