//! Example node demonstrating the structured `BlokError` API per master plan §17.
//!
//! Used by the cross-language E2E test
//! (`core/runner/__tests__/integration/runtimes/rust-grpc.integration.test.ts`)
//! to verify that a Rust-side structured error flows through the gRPC wire
//! to the runner with every field preserved (category, severity, code,
//! remediation, retryable hints, cause chain, context snapshot).
//!
//! Triggered via the `mode` config:
//! - `mode="dependency"` (default) — returns `BlokError::dependency()` with a
//!   cause chain rooted in a `std::io::Error`.
//! - `mode="rate-limit"` — returns `BlokError::rate_limit()` with `retry_after_ms`.
//! - `mode="validation"` — returns `BlokError::validation()` with `details.issues`.
//! - `mode="ok"` — returns success.

use async_trait::async_trait;
use std::collections::HashMap;
use std::time::Duration;

use crate::blok_error::{build_context_snapshot, BlokError};
use crate::node::NodeHandler;
use crate::types::Context;

pub struct BlokErrorDemoNode;

#[async_trait]
impl NodeHandler for BlokErrorDemoNode {
    async fn execute(
        &self,
        ctx: &mut Context,
        config: &HashMap<String, serde_json::Value>,
    ) -> Result<serde_json::Value, Box<dyn std::error::Error + Send + Sync>> {
        let mode = config
            .get("mode")
            .and_then(|v| v.as_str())
            .unwrap_or("dependency");

        if mode == "ok" {
            return Ok(serde_json::json!({"ok": true, "language": "rust"}));
        }

        let snapshot = build_context_snapshot(config, &ctx.vars);

        if mode == "rate-limit" {
            let err = BlokError::rate_limit()
                .code("UPSTREAM_RATE_LIMITED")
                .message("Upstream API returned 429")
                .description("GitHub API rate limit hit (5000 req/hr).")
                .remediation("Wait until the X-RateLimit-Reset header timestamp.")
                .retry_after_ms(60_000)
                .doc_url("https://docs.example.com/errors/rate-limit")
                .details(serde_json::json!({"limit": 5000, "remaining": 0}))
                .context_snapshot(snapshot)
                .build();
            return Err(Box::new(err));
        }

        if mode == "validation" {
            let err = BlokError::validation()
                .code("VALIDATION_FAILED")
                .message("2 validation issues")
                .description("Inputs didn't match the node's schema.")
                .remediation("Provide both `email` and `name`.")
                .details(serde_json::json!({
                    "issues": [
                        {"path": ["email"], "message": "Required"},
                        {"path": ["name"], "message": "Required"},
                    ],
                }))
                .context_snapshot(snapshot)
                .build();
            return Err(Box::new(err));
        }

        // default: dependency with a cause chain rooted in a std::io::Error.
        let cause = std::io::Error::new(
            std::io::ErrorKind::ConnectionRefused,
            "[Errno 61] Connection refused",
        );
        let err = BlokError::dependency()
            .code("POSTGRES_CONNECT_TIMEOUT")
            .message("Could not connect to Postgres within 5s")
            .description("Tried host=db.internal port=5432; timeout=5000ms")
            .remediation("Check DATABASE_URL env var and network reachability")
            .cause(&cause)
            .retryable(true)
            .retry_after(Duration::from_secs(5))
            .doc_url("https://docs.example.com/errors/POSTGRES_CONNECT_TIMEOUT")
            .details(serde_json::json!({
                "host": "db.internal",
                "port": 5432,
                "timeout_ms": 5000,
            }))
            .context_snapshot(snapshot)
            .build();
        Err(Box::new(err))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::MockContext;

    #[tokio::test]
    async fn ok_mode_returns_success_payload() {
        let mut ctx = MockContext::new().build();
        let config = HashMap::from([("mode".into(), serde_json::json!("ok"))]);
        let result = BlokErrorDemoNode.execute(&mut ctx, &config).await.unwrap();
        assert_eq!(result["ok"], true);
        assert_eq!(result["language"], "rust");
    }

    #[tokio::test]
    async fn dependency_mode_returns_typed_blok_error() {
        let mut ctx = MockContext::new().build();
        let config = HashMap::from([("mode".into(), serde_json::json!("dependency"))]);
        let err = BlokErrorDemoNode.execute(&mut ctx, &config).await.unwrap_err();
        let blok = err.downcast::<BlokError>().expect("expected BlokError");
        assert_eq!(blok.code, "POSTGRES_CONNECT_TIMEOUT");
        assert_eq!(blok.category.as_str(), "DEPENDENCY");
        assert_eq!(blok.http_status, 502);
        assert!(blok.retryable);
        assert_eq!(blok.retry_after_ms, 5_000);
        assert!(!blok.causes.is_empty());
    }

    #[tokio::test]
    async fn rate_limit_mode_attaches_retry_after() {
        let mut ctx = MockContext::new().build();
        let config = HashMap::from([("mode".into(), serde_json::json!("rate-limit"))]);
        let err = BlokErrorDemoNode.execute(&mut ctx, &config).await.unwrap_err();
        let blok = err.downcast::<BlokError>().unwrap();
        assert_eq!(blok.code, "UPSTREAM_RATE_LIMITED");
        assert_eq!(blok.http_status, 429);
        assert_eq!(blok.retry_after_ms, 60_000);
    }

    #[tokio::test]
    async fn validation_mode_attaches_issues() {
        let mut ctx = MockContext::new().build();
        let config = HashMap::from([("mode".into(), serde_json::json!("validation"))]);
        let err = BlokErrorDemoNode.execute(&mut ctx, &config).await.unwrap_err();
        let blok = err.downcast::<BlokError>().unwrap();
        assert_eq!(blok.code, "VALIDATION_FAILED");
        assert_eq!(blok.http_status, 400);
        let issues = blok.details.as_ref().unwrap()["issues"].as_array().unwrap();
        assert_eq!(issues.len(), 2);
        assert_eq!(issues[0]["path"][0], "email");
    }
}
