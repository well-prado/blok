use async_trait::async_trait;
use std::collections::HashMap;

use crate::node::NodeHandler;
use crate::types::Context;

/// ApiCallNode makes HTTP requests to external APIs.
///
/// Config:
///   - `url` (string, required): The URL to call
///   - `method` (string, optional): HTTP method (default: GET)
///   - `timeout` (number, optional): Timeout in seconds (default: 10)
pub struct ApiCallNode;

type BoxError = Box<dyn std::error::Error + Send + Sync>;

#[async_trait]
impl NodeHandler for ApiCallNode {
    async fn execute(
        &self,
        ctx: &mut Context,
        config: &HashMap<String, serde_json::Value>,
    ) -> Result<serde_json::Value, BoxError> {
        let url = config
            .get("url")
            .and_then(|v| v.as_str())
            .ok_or_else(|| -> BoxError {
                "'url' is required in node config".into()
            })?;

        let method = config
            .get("method")
            .and_then(|v| v.as_str())
            .unwrap_or("GET")
            .to_uppercase();

        let timeout = config
            .get("timeout")
            .and_then(|v| v.as_u64())
            .unwrap_or(10);

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(timeout))
            .build()?;

        let mut req_builder = match method.as_str() {
            "POST" => client.post(url),
            "PUT" => client.put(url),
            "PATCH" => client.patch(url),
            "DELETE" => client.delete(url),
            "HEAD" => client.head(url),
            _ => client.get(url),
        };

        // Add request body for POST/PUT/PATCH
        if matches!(method.as_str(), "POST" | "PUT" | "PATCH") {
            if let Some(body) = ctx.request.body.get("body") {
                req_builder = req_builder.json(body);
            }
        }

        // Add headers from config
        if let Some(headers) = config.get("headers").and_then(|v| v.as_object()) {
            for (k, v) in headers {
                if let Some(val) = v.as_str() {
                    req_builder = req_builder.header(k.as_str(), val);
                }
            }
        }

        let response: reqwest::Response = req_builder.send().await?;

        let status = response.status().as_u16();
        let resp_headers: HashMap<String, String> = response
            .headers()
            .iter()
            .map(|(k, v): (&reqwest::header::HeaderName, &reqwest::header::HeaderValue)| {
                (k.to_string(), v.to_str().unwrap_or("").to_string())
            })
            .collect();

        let body_text: String = response.text().await?;

        let data: serde_json::Value =
            serde_json::from_str(&body_text).unwrap_or(serde_json::Value::String(body_text));

        Ok(serde_json::json!({
            "status": status,
            "data": data,
            "headers": resp_headers,
        }))
    }
}
