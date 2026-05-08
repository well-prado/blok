//! # NATS JetStream Worker
//!
//! Standalone background job processing for Blok workflows using NATS JetStream.
//!
//! ## Quick Start
//!
//! ```rust,no_run
//! use blok::worker::{Worker, WorkerConfig};
//! use blok::registry::NodeRegistry;
//!
//! #[tokio::main]
//! async fn main() -> Result<(), Box<dyn std::error::Error>> {
//!     let config = WorkerConfig::from_env();
//!     let registry = NodeRegistry::new(&config.version);
//!     let mut worker = Worker::new(registry, config);
//!     worker.handle_node("emails", "send-email");
//!     worker.start().await
//! }
//! ```

use std::collections::HashMap;
use std::env;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_nats::jetstream;
use async_nats::jetstream::consumer::PullConsumer;
use async_nats::jetstream::stream::RetentionPolicy;
use async_nats::jetstream::AckKind;
use tokio::sync::{Mutex, Semaphore};
use tracing::{error, info};

use crate::registry::NodeRegistry;
use crate::types::{Context, ExecutionRequest, NodeConfig, Request};

/// Worker configuration loaded from environment variables.
#[derive(Debug, Clone)]
pub struct WorkerConfig {
    /// NATS server URLs.
    pub servers: Vec<String>,

    /// JetStream stream name (default: "blok-worker").
    pub stream_name: String,

    /// Runtime version for health checks.
    pub version: String,

    /// Authentication token (optional).
    pub token: Option<String>,

    /// Username (optional).
    pub user: Option<String>,

    /// Password (optional).
    pub pass: Option<String>,

    /// Max concurrent job handlers (default: 1).
    pub concurrency: usize,

    /// Max delivery attempts (default: 3).
    pub max_retries: u32,

    /// Job timeout before NATS redelivers (default: 30s).
    pub ack_wait: Duration,

    /// Queue names to subscribe to.
    pub queues: Vec<String>,

    /// HTTP health server port (default: 8080).
    pub health_port: u16,
}

impl Default for WorkerConfig {
    fn default() -> Self {
        Self {
            servers: vec!["localhost:4222".into()],
            stream_name: "blok-worker".into(),
            version: "1.0.0".into(),
            token: None,
            user: None,
            pass: None,
            concurrency: 1,
            max_retries: 3,
            ack_wait: Duration::from_secs(30),
            queues: Vec::new(),
            health_port: 8080,
        }
    }
}

impl WorkerConfig {
    /// Load configuration from environment variables.
    ///
    /// - `NATS_SERVERS`: Comma-separated NATS server URLs (default: localhost:4222)
    /// - `NATS_TOKEN`: Authentication token
    /// - `NATS_USER`: Username
    /// - `NATS_PASS`: Password
    /// - `NATS_STREAM_NAME`: JetStream stream name (default: blok-worker)
    /// - `VERSION`: Runtime version (default: 1.0.0)
    /// - `WORKER_CONCURRENCY`: Max concurrent jobs (default: 1)
    /// - `WORKER_MAX_RETRIES`: Max delivery attempts (default: 3)
    /// - `WORKER_ACK_WAIT_SECS`: Job timeout in seconds (default: 30)
    /// - `WORKER_QUEUES`: Comma-separated queue names
    /// - `PORT`: HTTP health server port (default: 8080)
    pub fn from_env() -> Self {
        Self {
            servers: env::var("NATS_SERVERS")
                .map(|v| v.split(',').map(|s| s.trim().to_string()).collect())
                .unwrap_or_else(|_| vec!["localhost:4222".into()]),
            stream_name: env::var("NATS_STREAM_NAME").unwrap_or_else(|_| "blok-worker".into()),
            version: env::var("VERSION").unwrap_or_else(|_| "1.0.0".into()),
            token: env::var("NATS_TOKEN").ok(),
            user: env::var("NATS_USER").ok(),
            pass: env::var("NATS_PASS").ok(),
            concurrency: env::var("WORKER_CONCURRENCY")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(1),
            max_retries: env::var("WORKER_MAX_RETRIES")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(3),
            ack_wait: Duration::from_secs(
                env::var("WORKER_ACK_WAIT_SECS")
                    .ok()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(30),
            ),
            queues: env::var("WORKER_QUEUES")
                .map(|v| v.split(',').map(|s| s.trim().to_string()).collect())
                .unwrap_or_default(),
            health_port: env::var("PORT")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(8080),
        }
    }
}

/// A job received from a NATS worker queue.
#[derive(Debug, Clone)]
pub struct JobMessage {
    /// Unique job identifier.
    pub id: String,

    /// Queue name this job came from.
    pub queue: String,

    /// Raw JSON job payload.
    pub data: serde_json::Value,

    /// Message headers.
    pub headers: HashMap<String, String>,

    /// Current delivery attempt (0-based).
    pub attempt: u32,

    /// Maximum retries configured.
    pub max_retries: u32,
}

/// Handler type for processing jobs.
pub type JobHandlerFn =
    Arc<dyn Fn(JobMessage) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), Box<dyn std::error::Error + Send + Sync>>> + Send>> + Send + Sync>;

/// Worker processes background jobs from NATS JetStream queues.
pub struct Worker {
    config: WorkerConfig,
    registry: Arc<Mutex<NodeRegistry>>,
    handlers: HashMap<String, JobHandlerFn>,
}

impl Worker {
    /// Create a new NATS JetStream worker.
    pub fn new(registry: NodeRegistry, config: WorkerConfig) -> Self {
        Self {
            config,
            registry: Arc::new(Mutex::new(registry)),
            handlers: HashMap::new(),
        }
    }

    /// Register a custom async handler for a queue.
    pub fn handle<F, Fut>(&mut self, queue: &str, handler: F)
    where
        F: Fn(JobMessage) -> Fut + Send + Sync + 'static,
        Fut: std::future::Future<Output = Result<(), Box<dyn std::error::Error + Send + Sync>>>
            + Send
            + 'static,
    {
        let handler = Arc::new(move |job: JobMessage| {
            let fut = handler(job);
            Box::pin(fut)
                as std::pin::Pin<
                    Box<
                        dyn std::future::Future<
                                Output = Result<(), Box<dyn std::error::Error + Send + Sync>>,
                            > + Send,
                    >,
                >
        });
        self.handlers.insert(queue.to_string(), handler);
    }

    /// Register a handler that routes jobs to a registered node.
    pub fn handle_node(&mut self, queue: &str, node_name: &str) {
        let registry = self.registry.clone();
        let node_name = node_name.to_string();
        let max_retries = self.config.max_retries;

        self.handle(queue, move |job: JobMessage| {
            let registry = registry.clone();
            let node_name = node_name.clone();

            async move {
                let mut params = HashMap::new();
                params.insert("queue".to_string(), job.queue.clone());
                params.insert("jobId".to_string(), job.id.clone());
                params.insert("attempt".to_string(), job.attempt.to_string());

                let mut vars = HashMap::new();
                vars.insert(
                    "_worker_job".to_string(),
                    serde_json::json!({
                        "id": job.id,
                        "queue": job.queue,
                        "attempts": job.attempt.to_string(),
                        "maxRetries": max_retries.to_string(),
                    }),
                );

                let mut req = ExecutionRequest {
                    node: NodeConfig {
                        name: node_name,
                        path: String::new(),
                        node_type: String::new(),
                        config: match &job.data {
                            serde_json::Value::Object(m) => {
                                m.iter()
                                    .map(|(k, v)| (k.clone(), v.clone()))
                                    .collect()
                            }
                            _ => HashMap::new(),
                        },
                    },
                    context: Context {
                        id: job.id.clone(),
                        workflow_name: String::new(),
                        workflow_path: String::new(),
                        request: Request {
                            body: job.data,
                            headers: job.headers,
                            params,
                            query: HashMap::new(),
                            method: String::new(),
                            url: String::new(),
                            cookies: HashMap::new(),
                            base_url: String::new(),
                        },
                        response: Default::default(),
                        vars,
                        env: HashMap::new(),
                    },
                };

                let reg = registry.lock().await;
                let result = reg.execute(&mut req).await;

                if result.success {
                    Ok(())
                } else {
                    let msg = result
                        .errors
                        .as_ref()
                        .and_then(|e| e.get("message"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("node execution failed");
                    Err(msg.to_string().into())
                }
            }
        });
    }

    /// Start the worker. Connects to NATS, ensures streams, and processes jobs.
    /// Blocks until a shutdown signal is received.
    pub async fn start(self) -> Result<(), Box<dyn std::error::Error>> {
        // Build NATS connection options
        let mut opts = async_nats::ConnectOptions::new();

        if let Some(token) = &self.config.token {
            opts = opts.token(token.clone());
        }
        if let (Some(user), Some(pass)) = (&self.config.user, &self.config.pass) {
            opts = opts.user_and_password(user.clone(), pass.clone());
        }

        // Connect to NATS
        let servers = self.config.servers.join(",");
        let client = opts.connect(&servers).await.map_err(|e| {
            format!("Failed to connect to NATS at {}: {}", servers, e)
        })?;

        info!("[Worker] Connected to NATS: {}", servers);

        // Create JetStream context
        let js = jetstream::new(client.clone());

        // Ensure stream exists
        let stream = ensure_stream(&js, &self.config).await?;

        // Start processing each queue
        let mut tasks = Vec::new();
        let sem = Arc::new(Semaphore::new(self.config.concurrency));

        for (queue, handler) in &self.handlers {
            let subject = format!("worker.{}", queue);
            let durable_name = format!("blok-worker-{}", queue);

            // Create or update consumer
            let consumer: PullConsumer = stream
                .create_consumer(jetstream::consumer::pull::Config {
                    durable_name: Some(durable_name.clone()),
                    ack_policy: jetstream::consumer::AckPolicy::Explicit,
                    max_deliver: self.config.max_retries as i64 + 1,
                    ack_wait: self.config.ack_wait + Duration::from_secs(5),
                    filter_subject: subject.clone(),
                    ..Default::default()
                })
                .await
                .map_err(|e| format!("Failed to create consumer for {}: {}", queue, e))?;

            info!(
                "[Worker] Subscribed to queue: {} (stream={}, consumer={})",
                queue, self.config.stream_name, durable_name
            );

            // Spawn a task that continuously pulls messages
            let handler = handler.clone();
            let sem = sem.clone();
            let queue = queue.clone();
            let max_retries = self.config.max_retries;

            let task = tokio::spawn(async move {
                let mut messages = consumer
                    .messages()
                    .await
                    .expect("Failed to get message stream");

                use tokio_stream::StreamExt;

                while let Some(msg_result) = messages.next().await {
                    let msg = match msg_result {
                        Ok(m) => m,
                        Err(e) => {
                            error!("[Worker] Error receiving message from {}: {}", queue, e);
                            continue;
                        }
                    };

                    // Acquire semaphore permit for concurrency control
                    let permit = sem.clone().acquire_owned().await;
                    if permit.is_err() {
                        break; // Semaphore closed
                    }
                    let _permit = permit.unwrap();

                    // Extract headers
                    let mut headers = HashMap::new();
                    if let Some(hdrs) = msg.headers.as_ref() {
                        for (key, values) in hdrs.iter() {
                            if let Some(val) = values.iter().next() {
                                headers.insert(key.to_string(), val.to_string());
                            }
                        }
                    }

                    // Extract job ID
                    let job_id = headers
                        .get("x-job-id")
                        .or_else(|| headers.get("Nats-Msg-Id"))
                        .cloned()
                        .unwrap_or_else(|| format!("job-{}", chrono::Utc::now().timestamp_millis()));

                    // Get delivery count from message info
                    let info = msg.info();
                    let attempt = info
                        .as_ref()
                        .map(|i| i.delivered.saturating_sub(1) as u32)
                        .unwrap_or(0);

                    // Parse message data
                    let data: serde_json::Value =
                        serde_json::from_slice(&msg.payload).unwrap_or(serde_json::Value::Null);

                    let job = JobMessage {
                        id: job_id.clone(),
                        queue: queue.clone(),
                        data,
                        headers,
                        attempt,
                        max_retries,
                    };

                    info!(
                        "[Worker] Processing job {} from {} (attempt {}/{})",
                        job_id,
                        queue,
                        attempt + 1,
                        max_retries + 1
                    );

                    let start = Instant::now();
                    let handler = handler.clone();

                    // Execute handler
                    match handler(job).await {
                        Ok(()) => {
                            let elapsed = start.elapsed();
                            info!("[Worker] Job {} completed in {:?}", job_id, elapsed);

                            if let Err(e) = msg.ack().await {
                                error!("[Worker] Failed to ack message: {}", e);
                            }
                        }
                        Err(e) => {
                            let elapsed = start.elapsed();
                            error!(
                                "[Worker] Job {} failed after {:?}: {}",
                                job_id, elapsed, e
                            );

                            // Nak for redelivery (NATS handles max_deliver limit)
                            if let Err(nak_err) = msg.ack_with(AckKind::Nak(None)).await {
                                error!("[Worker] Failed to nak message: {}", nak_err);
                            }
                        }
                    }
                }
            });

            tasks.push(task);
        }

        info!(
            "[Worker] Processing {} queue(s), concurrency={}",
            tasks.len(),
            self.config.concurrency
        );

        // Wait for shutdown signal
        tokio::signal::ctrl_c()
            .await
            .expect("Failed to listen for ctrl-c");

        info!("[Worker] Shutting down...");

        // Abort all tasks
        for task in tasks {
            task.abort();
        }

        // Drain NATS connection
        client.flush().await?;

        info!("[Worker] Stopped");
        Ok(())
    }
}

/// Ensure the JetStream stream exists.
async fn ensure_stream(
    js: &jetstream::Context,
    config: &WorkerConfig,
) -> Result<jetstream::stream::Stream, Box<dyn std::error::Error>> {
    // Try to get existing stream
    match js.get_stream(&config.stream_name).await {
        Ok(stream) => {
            info!(
                "[Worker] Using existing JetStream stream: {}",
                config.stream_name
            );
            Ok(stream)
        }
        Err(_) => {
            // Create stream with WorkQueue retention
            let stream = js
                .create_stream(jetstream::stream::Config {
                    name: config.stream_name.clone(),
                    subjects: vec!["worker.>".into()],
                    retention: RetentionPolicy::WorkQueue,
                    storage: jetstream::stream::StorageType::File,
                    ..Default::default()
                })
                .await
                .map_err(|e| {
                    format!(
                        "Failed to create JetStream stream '{}': {}",
                        config.stream_name, e
                    )
                })?;

            info!(
                "[Worker] Created JetStream stream: {}",
                config.stream_name
            );
            Ok(stream)
        }
    }
}
