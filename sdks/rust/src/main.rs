use tracing::info;
use tracing_subscriber::EnvFilter;

use blok::config::ServerConfig;
use blok::logging::{LogLevel, Logger};
use blok::middleware::LoggingMiddleware;
use blok::nodes;
use blok::registry::NodeRegistry;

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
        "Blok Rust Runtime v{} — {} node(s) registered",
        config.version,
        registry.len()
    );

    #[cfg(feature = "grpc")]
    if config.enable_grpc {
        use std::sync::Arc;
        use tokio::sync::Mutex;

        // Build a separate registry per transport. `serve()` takes ownership;
        // `serve_grpc()` takes a shared `Arc<Mutex<…>>`. Both are populated
        // via `nodes::register_all` so they expose the same node set.
        let mut grpc_registry = NodeRegistry::new(&config.version);
        nodes::register_all(&mut grpc_registry);
        let grpc_shared = Arc::new(Mutex::new(grpc_registry));

        let mut http_registry = NodeRegistry::new(&config.version);
        nodes::register_all(&mut http_registry);

        let version = config.version.clone();

        tokio::select! {
            result = blok::server::serve(http_registry, config.port) => {
                result?;
            }
            result = blok::grpc_server::serve_grpc(grpc_shared, config.grpc_port, version, config.grpc_max_message_bytes) => {
                result.map_err(|e| -> Box<dyn std::error::Error> { e })?;
            }
        }

        // Suppress dead-code warning when `grpc` is built but `enable_grpc=false`.
        let _ = registry;
    } else {
        blok::server::serve(registry, config.port).await?;
    }

    #[cfg(not(feature = "grpc"))]
    {
        blok::server::serve(registry, config.port).await?;
    }

    Ok(())
}
