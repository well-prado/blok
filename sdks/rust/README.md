# blok-rs

Rust SDK for the Blok blok workflow orchestration framework.

Build high-performance workflow nodes in Rust with async/await support.

## Installation

```toml
[dependencies]
blok-rs = "1.0"
```

## Quick Start

```rust
use async_trait::async_trait;
use blok::{NodeHandler, NodeRegistry, Context};
use std::collections::HashMap;

struct GreetNode;

#[async_trait]
impl NodeHandler for GreetNode {
    async fn execute(
        &self,
        ctx: &mut Context,
        config: &HashMap<String, serde_json::Value>,
    ) -> Result<serde_json::Value, Box<dyn std::error::Error + Send + Sync>> {
        let name = ctx.request.body_str("name").unwrap_or("World");
        Ok(serde_json::json!({ "message": format!("Hello, {}!", name) }))
    }
}

#[tokio::main]
async fn main() {
    let mut registry = NodeRegistry::new("1.0.0");
    registry.register("greet", GreetNode);
    blok::server::serve(registry, 8080).await.unwrap();
}
```

## Features

- **Async/await** - Built on tokio for maximum performance
- **HTTP + gRPC** - Serve via axum (HTTP) or tonic (gRPC, feature-gated)
- **Middleware** - Composable middleware pipeline (logging, timeout)
- **Validation** - JSON Schema validation for inputs/outputs
- **Structured logging** - Log capture for ExecutionResult.logs
- **Testing utilities** - MockContext builder and TestNodeRunner
- **Type-safe errors** - NodeError with categories via thiserror

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `VERSION` | `1.0.0` | Runtime version |
| `RUST_LOG` | `info` | tracing log level |
| `ENABLE_CORS` | `false` | Enable CORS |
| `ENABLE_GRPC` | `false` | Enable gRPC server |
| `GRPC_PORT` | `50051` | gRPC port |

## Cargo Features

- `http` (default) — HTTP server via axum
- `grpc` — gRPC server via tonic
- `full` — Both HTTP and gRPC

## License

MIT
