use std::env;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::info;
use tracing_subscriber::EnvFilter;

use blok::nodes::hello_world::HelloWorldNode;
use blok::registry::NodeRegistry;

const VERSION: &str = "1.0.0";

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Initialize tracing
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    // Build the node registry
    let mut registry = NodeRegistry::new(VERSION);

    // Register nodes
    registry.register("hello-world", HelloWorldNode);
    // Add more nodes here:
    // registry.register("another-node", AnotherNode);

    info!(
        "Blok Rust Runtime v{} — {} node(s) registered",
        VERSION,
        registry.len()
    );

    // Read port configuration
    let http_port: u16 = env::var("PORT")
        .unwrap_or_else(|_| "8080".to_string())
        .parse()?;
    let grpc_port: u16 = env::var("GRPC_PORT")
        .unwrap_or_else(|_| "50051".to_string())
        .parse()?;
    let enable_grpc = env::var("ENABLE_GRPC")
        .unwrap_or_else(|_| "false".to_string())
        .parse::<bool>()
        .unwrap_or(false);

    if enable_grpc {
        // Run both HTTP and gRPC servers concurrently
        let shared = Arc::new(Mutex::new(registry));

        let http_registry = {
            let locked = shared.lock().await;
            // Rebuild a separate registry for the HTTP server
            // (since serve() takes ownership)
            drop(locked);
            // For simplicity, share the Arc between both servers
            let mut http_reg = NodeRegistry::new(VERSION);
            http_reg.register("hello-world", HelloWorldNode);
            http_reg
        };

        let grpc_shared = shared.clone();

        tokio::select! {
            result = blok::server::serve(http_registry, http_port) => {
                result?;
            }
            result = blok::grpc_server::serve_grpc(grpc_shared, grpc_port) => {
                result?;
            }
        }
    } else {
        // HTTP-only mode (default — used by DockerRuntimeAdapter)
        blok::server::serve(registry, http_port).await?;
    }

    Ok(())
}
