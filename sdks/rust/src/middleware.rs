use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::logging::Logger;
use crate::node::NodeHandler;
use crate::types::Context;

/// Middleware wraps a NodeHandler to add cross-cutting behavior.
#[async_trait]
pub trait Middleware: Send + Sync {
    /// Wrap a handler and return a new handler with additional behavior.
    fn wrap(&self, handler: Arc<dyn NodeHandler>) -> Arc<dyn NodeHandler>;
}

/// LoggingMiddleware logs node execution with timing.
pub struct LoggingMiddleware {
    logger: Logger,
}

impl LoggingMiddleware {
    pub fn new(logger: Logger) -> Self {
        Self { logger }
    }
}

#[async_trait]
impl Middleware for LoggingMiddleware {
    fn wrap(&self, handler: Arc<dyn NodeHandler>) -> Arc<dyn NodeHandler> {
        Arc::new(LoggingHandler {
            inner: handler,
            logger: self.logger.clone(),
        })
    }
}

struct LoggingHandler {
    inner: Arc<dyn NodeHandler>,
    logger: Logger,
}

#[async_trait]
impl NodeHandler for LoggingHandler {
    async fn execute(
        &self,
        ctx: &mut Context,
        config: &HashMap<String, serde_json::Value>,
    ) -> Result<serde_json::Value, Box<dyn std::error::Error + Send + Sync>> {
        let start = Instant::now();
        self.logger.info_with(
            "node execution started",
            serde_json::json!({"workflow": &ctx.workflow_name}),
        );

        let result = self.inner.execute(ctx, config).await;
        let duration = start.elapsed();

        match &result {
            Ok(_) => self.logger.info_with(
                "node execution completed",
                serde_json::json!({
                    "workflow": &ctx.workflow_name,
                    "duration_ms": duration.as_secs_f64() * 1000.0,
                }),
            ),
            Err(e) => self.logger.error_with(
                "node execution failed",
                serde_json::json!({
                    "workflow": &ctx.workflow_name,
                    "duration_ms": duration.as_secs_f64() * 1000.0,
                    "error": e.to_string(),
                }),
            ),
        }

        result
    }
}

/// TimeoutMiddleware enforces a maximum execution duration.
pub struct TimeoutMiddleware {
    timeout: Duration,
}

impl TimeoutMiddleware {
    pub fn new(timeout: Duration) -> Self {
        Self { timeout }
    }
}

#[async_trait]
impl Middleware for TimeoutMiddleware {
    fn wrap(&self, handler: Arc<dyn NodeHandler>) -> Arc<dyn NodeHandler> {
        Arc::new(TimeoutHandler {
            inner: handler,
            timeout: self.timeout,
        })
    }
}

struct TimeoutHandler {
    inner: Arc<dyn NodeHandler>,
    timeout: Duration,
}

#[async_trait]
impl NodeHandler for TimeoutHandler {
    async fn execute(
        &self,
        ctx: &mut Context,
        config: &HashMap<String, serde_json::Value>,
    ) -> Result<serde_json::Value, Box<dyn std::error::Error + Send + Sync>> {
        match tokio::time::timeout(self.timeout, self.inner.execute(ctx, config)).await {
            Ok(result) => result,
            Err(_) => Err(format!(
                "execution timed out after {:?}",
                self.timeout
            )
            .into()),
        }
    }
}

/// Apply a chain of middleware to a handler.
pub fn apply_middleware(
    handler: Arc<dyn NodeHandler>,
    middlewares: &[Arc<dyn Middleware>],
) -> Arc<dyn NodeHandler> {
    let mut current = handler;
    for mw in middlewares {
        current = mw.wrap(current);
    }
    current
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logging::LogLevel;
    use crate::testing::MockContext;

    struct EchoNode;

    #[async_trait]
    impl NodeHandler for EchoNode {
        async fn execute(
            &self,
            _ctx: &mut Context,
            _config: &HashMap<String, serde_json::Value>,
        ) -> Result<serde_json::Value, Box<dyn std::error::Error + Send + Sync>> {
            Ok(serde_json::json!("echo"))
        }
    }

    #[tokio::test]
    async fn test_logging_middleware() {
        let logger = Logger::new(LogLevel::Debug);
        let mw = LoggingMiddleware::new(logger.clone());

        let handler: Arc<dyn NodeHandler> = Arc::new(EchoNode);
        let wrapped = mw.wrap(handler);

        let mut ctx = MockContext::new().build();
        let result = wrapped.execute(&mut ctx, &HashMap::new()).await;

        assert!(result.is_ok());
        assert!(logger.entries().len() >= 2);
    }

    #[tokio::test]
    async fn test_timeout_middleware_fast() {
        let mw = TimeoutMiddleware::new(Duration::from_secs(5));
        let handler: Arc<dyn NodeHandler> = Arc::new(EchoNode);
        let wrapped = mw.wrap(handler);

        let mut ctx = MockContext::new().build();
        let result = wrapped.execute(&mut ctx, &HashMap::new()).await;
        assert!(result.is_ok());
    }
}
