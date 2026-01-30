use std::sync::Arc;
use tokio::sync::Mutex;
use tonic::{Request, Response, Status};
use tracing::info;

use crate::registry::NodeRegistry;
use crate::types::ExecutionRequest;

/// Generated proto types from tonic-build
pub mod proto {
    tonic::include_proto!("blok.workflow.v1");
}

use proto::node_service_server::{NodeService, NodeServiceServer};
use proto::{NodeRequest, NodeResponse};

/// gRPC implementation of the Blok NodeService
pub struct BlokNodeService {
    registry: Arc<Mutex<NodeRegistry>>,
}

impl BlokNodeService {
    pub fn new(registry: Arc<Mutex<NodeRegistry>>) -> Self {
        Self { registry }
    }
}

#[tonic::async_trait]
impl NodeService for BlokNodeService {
    async fn execute_node(
        &self,
        request: Request<NodeRequest>,
    ) -> Result<Response<NodeResponse>, Status> {
        let req = request.into_inner();

        // Decode the message payload (base64 JSON or plain JSON)
        let payload = if req.encoding == "BASE64" || req.encoding == "0" {
            use base64::Engine;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(&req.message)
                .map_err(|e| Status::invalid_argument(format!("invalid base64: {}", e)))?;
            String::from_utf8(bytes)
                .map_err(|e| Status::invalid_argument(format!("invalid utf8: {}", e)))?
        } else {
            req.message
        };

        // Parse the JSON payload into an ExecutionRequest
        let mut exec_req: ExecutionRequest = serde_json::from_str(&payload)
            .map_err(|e| Status::invalid_argument(format!("invalid JSON payload: {}", e)))?;

        // Override node name from the gRPC request if provided
        if !req.name.is_empty() {
            exec_req.node.name = req.name;
        }

        // Execute the node
        let registry = self.registry.lock().await;
        let result = registry.execute(&mut exec_req).await;

        // Serialize result to JSON
        let result_json = serde_json::to_string(&result)
            .map_err(|e| Status::internal(format!("failed to serialize result: {}", e)))?;

        Ok(Response::new(NodeResponse {
            message: result_json,
            encoding: "STRING".to_string(),
            r#type: "JSON".to_string(),
        }))
    }
}

/// Start the gRPC server on the given port.
pub async fn serve_grpc(
    registry: Arc<Mutex<NodeRegistry>>,
    port: u16,
) -> Result<(), Box<dyn std::error::Error>> {
    let addr = format!("0.0.0.0:{}", port).parse()?;
    let service = BlokNodeService::new(registry);

    info!("Blok Rust gRPC server listening on port {}", port);

    tonic::transport::Server::builder()
        .add_service(NodeServiceServer::new(service))
        .serve(addr)
        .await?;

    Ok(())
}
