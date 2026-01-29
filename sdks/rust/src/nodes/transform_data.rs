use async_trait::async_trait;
use std::collections::HashMap;

use crate::errors::NodeError;
use crate::node::NodeHandler;
use crate::types::Context;

/// TransformDataNode transforms JSON data based on field mappings.
///
/// Config:
///   - `mappings` (object): Map of target field name → source field path (dot-notation)
///   - `include_only` (array, optional): Only include these fields
///   - `exclude` (array, optional): Exclude these fields
///   - `defaults` (object, optional): Default values for missing fields
pub struct TransformDataNode;

#[async_trait]
impl NodeHandler for TransformDataNode {
    async fn execute(
        &self,
        ctx: &mut Context,
        config: &HashMap<String, serde_json::Value>,
    ) -> Result<serde_json::Value, Box<dyn std::error::Error + Send + Sync>> {
        let body = ctx
            .request
            .body
            .as_object()
            .ok_or_else(|| NodeError::validation("request body must be a JSON object"))?;

        let mut result = serde_json::Map::new();

        // Apply field mappings if configured
        if let Some(mappings) = config.get("mappings").and_then(|v| v.as_object()) {
            for (target, source_path) in mappings {
                if let Some(source) = source_path.as_str() {
                    if let Some(value) = get_nested_value(&ctx.request.body, source) {
                        result.insert(target.clone(), value.clone());
                    }
                }
            }
        } else {
            // No mappings — copy all fields
            for (k, v) in body {
                result.insert(k.clone(), v.clone());
            }
        }

        // Apply include_only filter
        if let Some(include_only) = config.get("include_only").and_then(|v| v.as_array()) {
            let allowed: Vec<&str> = include_only.iter().filter_map(|v| v.as_str()).collect();
            result.retain(|k, _| allowed.contains(&k.as_str()));
        }

        // Apply exclude filter
        if let Some(exclude) = config.get("exclude").and_then(|v| v.as_array()) {
            for field in exclude.iter().filter_map(|v| v.as_str()) {
                result.remove(field);
            }
        }

        // Apply defaults
        if let Some(defaults) = config.get("defaults").and_then(|v| v.as_object()) {
            for (k, v) in defaults {
                if !result.contains_key(k) {
                    result.insert(k.clone(), v.clone());
                }
            }
        }

        let output = serde_json::Value::Object(result);
        ctx.set_var("transformed_data", output.clone());

        Ok(output)
    }
}

fn get_nested_value<'a>(data: &'a serde_json::Value, path: &str) -> Option<&'a serde_json::Value> {
    let mut current = data;
    for part in path.split('.') {
        current = current.get(part)?;
    }
    Some(current)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::MockContext;

    #[tokio::test]
    async fn test_transform_copy_all() {
        let node = TransformDataNode;
        let mut ctx = MockContext::new()
            .with_body(serde_json::json!({"name": "John", "age": 30}))
            .build();
        let result = node.execute(&mut ctx, &HashMap::new()).await.unwrap();
        assert_eq!(result["name"], "John");
        assert_eq!(result["age"], 30);
    }

    #[tokio::test]
    async fn test_transform_with_mappings() {
        let node = TransformDataNode;
        let mut ctx = MockContext::new()
            .with_body(serde_json::json!({"first_name": "John", "last_name": "Doe"}))
            .build();
        let config = HashMap::from([(
            "mappings".into(),
            serde_json::json!({"full_name": "first_name", "surname": "last_name"}),
        )]);
        let result = node.execute(&mut ctx, &config).await.unwrap();
        assert_eq!(result["full_name"], "John");
        assert_eq!(result["surname"], "Doe");
    }

    #[tokio::test]
    async fn test_transform_with_exclude() {
        let node = TransformDataNode;
        let mut ctx = MockContext::new()
            .with_body(serde_json::json!({"name": "John", "secret": "hidden", "age": 30}))
            .build();
        let config = HashMap::from([("exclude".into(), serde_json::json!(["secret"]))]);
        let result = node.execute(&mut ctx, &config).await.unwrap();
        assert!(result.get("secret").is_none());
        assert_eq!(result["name"], "John");
    }

    #[tokio::test]
    async fn test_transform_with_defaults() {
        let node = TransformDataNode;
        let mut ctx = MockContext::new()
            .with_body(serde_json::json!({"name": "John"}))
            .build();
        let config = HashMap::from([(
            "defaults".into(),
            serde_json::json!({"role": "user", "active": true}),
        )]);
        let result = node.execute(&mut ctx, &config).await.unwrap();
        assert_eq!(result["role"], "user");
        assert_eq!(result["active"], true);
    }
}
