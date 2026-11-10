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
| `GRPC_PORT` | `10002` | gRPC port |
| `GRPC_HOST` | `127.0.0.1` | gRPC bind address; containers set `GRPC_HOST=0.0.0.0` for external access |

The gRPC server has no TLS or authentication and defaults to loopback. Set
`GRPC_HOST=0.0.0.0` only when network access is intended and protected by the host.
The supplied Docker image sets `GRPC_HOST=0.0.0.0` so published ports and runners
in other containers can reach it; override the variable when starting the container
if a different bind address is needed.

Concurrent gRPC calls run independently. For Execute and ExecuteStream, a positive
`ExecuteOptions.deadline_ms` limits execution time in milliseconds; zero or negative
values leave execution unlimited. Expiry returns a `NodeError` with code `TIMEOUT`
and category `TIMEOUT`, and drops the handler future. Nodes must yield to the async
runtime for cancellation to take effect. Nodes spawning child processes should set
`tokio::process::Command::kill_on_drop(true)` so dropping the future also kills the child.

## Cargo Features

- `http` (default) — HTTP server via axum
- `grpc` — gRPC server via tonic
- `full` — Both HTTP and gRPC

## License

MIT
