use axum::{
    extract::State,
    http::StatusCode,
    response::Json,
    routing::{get, post},
    Router,
};
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::info;

use crate::registry::NodeRegistry;
use crate::types::{ExecutionRequest, ExecutionResult, HealthStatus};

/// Shared application state for the Axum server.
pub type AppState = Arc<Mutex<NodeRegistry>>;

/// Build the Axum router with `/execute` and `/health` endpoints.
pub fn create_router(registry: NodeRegistry) -> Router {
    let state: AppState = Arc::new(Mutex::new(registry));

    Router::new()
        .route("/execute", post(execute_handler))
        .route("/health", get(health_handler))
        .with_state(state)
}

/// Start the HTTP server on the given port.
pub async fn serve(registry: NodeRegistry, port: u16) -> Result<(), Box<dyn std::error::Error>> {
    let app = create_router(registry);

    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{}", port)).await?;
    info!("Blok Rust Runtime listening on port {}", port);

    axum::serve(listener, app).await?;

    Ok(())
}

/// POST /execute — Run a node with the provided context.
async fn execute_handler(
    State(state): State<AppState>,
    Json(mut req): Json<ExecutionRequest>,
) -> (StatusCode, Json<ExecutionResult>) {
    let registry = state.lock().await;
    let result = registry.execute(&mut req).await;

    let status = if result.success {
        StatusCode::OK
    } else {
        StatusCode::OK // Runner expects 200 even on node errors
    };

    (status, Json(result))
}

/// GET /health — Return runtime health status.
async fn health_handler(State(state): State<AppState>) -> Json<HealthStatus> {
    let registry = state.lock().await;
    Json(registry.health())
}
