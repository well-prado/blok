use tracing::info;
use tracing_subscriber::EnvFilter;

use nanoservice::config::ServerConfig;
use nanoservice::logging::{LogLevel, Logger};
use nanoservice::middleware::LoggingMiddleware;
use nanoservice::nodes;
use nanoservice::registry::NodeRegistry;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Initialize tracing
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();

    let config = ServerConfig::from_env();

    // Create registry and register nodes
    let mut registry = NodeRegistry::new(&config.version);
    nodes::register_all(&mut registry);

    // Add middleware
    let logger = Logger::new(LogLevel::Info);
    registry.use_middleware(LoggingMiddleware::new(logger));

    info!(
        "Nanoservice Rust Runtime v{} — {} node(s) registered",
        config.version,
        registry.len()
    );

    #[cfg(feature = "grpc")]
    if config.enable_grpc {
        use std::sync::Arc;
        use tokio::sync::Mutex;

        let shared = Arc::new(Mutex::new(registry));

        // For simplicity, create a separate registry for gRPC
        let mut grpc_registry = NodeRegistry::new(&config.version);
        nodes::register_all(&mut grpc_registry);
        let grpc_shared = Arc::new(Mutex::new(grpc_registry));

        // Need another registry for HTTP since serve() takes ownership
        let mut http_registry = NodeRegistry::new(&config.version);
        nodes::register_all(&mut http_registry);

        tokio::select! {
            result = nanoservice::server::serve(http_registry, config.port) => {
                result?;
            }
            result = nanoservice::grpc_server::serve_grpc(grpc_shared, config.grpc_port) => {
                result?;
            }
        }
    } else {
        nanoservice::server::serve(registry, config.port).await?;
    }

    #[cfg(not(feature = "grpc"))]
    {
        nanoservice::server::serve(registry, config.port).await?;
    }

    Ok(())
}
