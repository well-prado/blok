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

/// Shared application state.
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

    info!("Nanoservice runtime listening on port {}", port);

    axum::serve(listener, app).await?;
    Ok(())
}

async fn execute_handler(
    State(state): State<AppState>,
    body: String,
) -> (StatusCode, Json<ExecutionResult>) {
    // Parse the JSON manually for better error handling
    let mut req: ExecutionRequest = match serde_json::from_str(&body) {
        Ok(req) => req,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(ExecutionResult::error(&format!("invalid JSON: {}", e))),
            );
        }
    };

    let registry = state.lock().await;
    let result = registry.execute(&mut req).await;

    (StatusCode::OK, Json(result))
}

async fn health_handler(State(state): State<AppState>) -> Json<HealthStatus> {
    let registry = state.lock().await;
    Json(registry.health())
}
