# Module Reference: Trigger System

> **Path:** `triggers/`
> **Base class:** `core/runner/src/TriggerBase.ts`
> **Purpose:** Event sources that start workflow execution

## What It Does

Triggers are the entry points to Blok workflows. Each trigger type listens for a specific kind of event (HTTP request, queue message, cron tick, etc.) and maps it to a workflow for execution.

All triggers extend `TriggerBase`, which provides shared infrastructure for loading nodes, loading workflows, creating execution contexts, and running the workflow engine.

## Trigger Types at a Glance

| Trigger | Package | Port | Event Source |
|---------|---------|------|-------------|
| **HTTP** | `@blokjs/trigger-http` | 4000 | HTTP requests (GET, POST, PUT, DELETE, etc.) |
| **gRPC** | `@blokjs/trigger-grpc` | 50051 | gRPC/Connect RPC calls |
| **Cron** | `triggers/cron` | - | Scheduled tasks (cron expressions) |
| **Queue** | `triggers/queue` | - | Kafka, RabbitMQ, SQS, Redis message queues |
| **Pub/Sub** | `triggers/pubsub` | - | GCP Pub/Sub, AWS SNS, Azure Service Bus |
| **Webhook** | `triggers/webhook` | 4000 | External webhooks (GitHub, Stripe, Shopify) |
| **WebSocket** | `triggers/websocket` | 4000 | WebSocket connections |
| **SSE** | `triggers/sse` | 4000 | Server-Sent Events |
| **Worker** | `triggers/worker` | - | Background job queues (BullMQ) |

## TriggerBase Architecture

Every trigger extends `TriggerBase` and follows this pattern:

```typescript
class MyTrigger extends TriggerBase {
  constructor() {
    super();
    this.loadNodes();       // Load all registered node implementations
    this.loadWorkflows();   // Load all workflow JSON definitions
  }

  async start() {
    // 1. Start listening for events
    // 2. When event received:
    //    a. Find matching workflow by trigger config
    //    b. Create context: this.createContext(req, workflowPath)
    //    c. Execute: await this.executeWorkflow(ctx, workflowModel)
    //    d. Return response
  }
}
```

### Key TriggerBase Methods

| Method | Purpose |
|--------|---------|
| `loadNodes()` | Scans node directory, loads all node implementations into NodeMap |
| `loadWorkflows()` | Scans workflow directory, parses all JSON workflow definitions |
| `createContext(req?, path?)` | Creates a new Context object for workflow execution |
| `executeWorkflow(ctx, model)` | Runs the workflow engine with the given context |
| `getNodeMap()` | Returns the registered node map |
| `getWorkflows()` | Returns all loaded workflow models |

## Directory Structure per Trigger

Each trigger follows a consistent structure:

```
triggers/{type}/
├── src/
│   ├── index.ts              # Entry point (bootstrap + server start)
│   ├── {Type}Trigger.ts      # Main trigger class extending TriggerBase
│   └── adapters/             # Provider-specific adapters (for queue/pubsub/worker)
│       ├── KafkaAdapter.ts
│       ├── RabbitMQAdapter.ts
│       └── ...
├── __tests__/ or test/       # Unit tests
├── package.json
└── tsconfig.json
```

## Detailed Trigger Breakdown

### HTTP Trigger (`triggers/http/`)
- **Server:** Express.js
- **Features:** Route-based workflow matching, body parsing, CORS, metrics endpoint (`:9091`)
- **Config:**
  ```json
  { "type": "http", "method": "POST", "path": "/api/users" }
  ```
- **Files:** `HttpTrigger.ts`, `AppRoutes.ts`, `Nodes.ts`, `Workflows.ts`, `MessageDecode.ts`
- **Docker support:** `Dockerfile`, `Dockerfile.dev`, `docker-compose.yml`

### gRPC Trigger (`triggers/grpc/`)
- **Server:** @connectrpc/connect
- **Features:** Protocol buffer service definitions, streaming support
- **Config:**
  ```json
  { "type": "grpc", "service": "UserService", "method": "GetUser" }
  ```
- **Files:** `GRpcTrigger.ts`, `GrpcServer.ts`, `GrpcClient.ts`, `NanoSDK.ts`

### Queue Trigger (`triggers/queue/`)
- **Adapters:** Kafka, RabbitMQ, SQS, Redis
- **Features:** Consumer groups, dead letter queues, message acknowledgment
- **Config:**
  ```json
  { "type": "queue", "provider": "kafka", "topic": "user-events", "consumerGroup": "blok-app" }
  ```

### Pub/Sub Trigger (`triggers/pubsub/`)
- **Adapters:** GCP Pub/Sub, AWS SNS, Azure Service Bus
- **Features:** Pattern-based subscriptions, fanout/broadcast
- **Config:**
  ```json
  { "type": "pubsub", "provider": "gcp", "channel": "notifications" }
  ```

### Cron Trigger (`triggers/cron/`)
- **Engine:** node-cron
- **Features:** Timezone support, overlap prevention
- **Config:**
  ```json
  { "type": "cron", "schedule": "0 */6 * * *", "timezone": "America/New_York" }
  ```

### Webhook Trigger (`triggers/webhook/`)
- **Providers:** GitHub, Stripe, Shopify, generic
- **Features:** HMAC signature verification, event filtering
- **Config:**
  ```json
  { "type": "webhook", "source": "github", "events": ["push", "pull_request"] }
  ```

### WebSocket Trigger (`triggers/websocket/`)
- **Features:** Connection management, room/channel support, auth
- **Config:**
  ```json
  { "type": "websocket", "path": "/ws" }
  ```

### SSE Trigger (`triggers/sse/`)
- **Features:** Event streams, reconnection, event types
- **Config:**
  ```json
  { "type": "sse", "path": "/events" }
  ```

### Worker Trigger (`triggers/worker/`)
- **Adapters:** BullMQ (Redis-based), In-Memory
- **Features:** Concurrency control, retry with backoff, job priority, delay
- **Config:**
  ```json
  { "type": "worker", "queue": "email-jobs", "concurrency": 5, "retries": 3 }
  ```

## What to Document

1. **TriggerBase API** — Complete reference for building custom triggers
2. **Each trigger type** — Configuration, setup, examples, deployment
3. **Queue adapter configuration** — Kafka, RabbitMQ, SQS, Redis specifics
4. **Pub/Sub adapter configuration** — GCP, AWS SNS, Azure specifics
5. **Webhook verification** — HMAC, JWT, signature validation
6. **Docker Compose examples** — Running triggers with required infrastructure
7. **Metrics & monitoring** — Trigger-specific metrics and health checks
8. **Hot-reload** — HMR integration for triggers
