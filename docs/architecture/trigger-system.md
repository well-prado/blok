---
title: "Trigger System"
description: "Deep-dive architecture documentation for the Blok trigger system"
---

# Trigger System

Triggers are the entry points of the Blok framework. They listen for external events -- HTTP requests, gRPC calls, queue messages, cron schedules, and more -- and translate those events into workflow executions. Every Blok application has at least one trigger.

## TriggerBase Pattern

All triggers extend the abstract `TriggerBase` class (`core/runner/src/TriggerBase.ts`), which provides:

- **Workflow loading** via `Configuration`
- **Execution orchestration** via `Runner`
- **Context creation** with unique request IDs
- **OpenTelemetry metrics** (workflow counters, execution time, memory, CPU)
- **Monitoring infrastructure** (health checks, rate limiting, circuit breaker)
- **Prometheus metrics bridge** for `/metrics` endpoint
- **Hot Module Replacement (HMR)** for development

```typescript
import TriggerBase from "@blokjs/runner/TriggerBase";

export default class MyCustomTrigger extends TriggerBase {
  async listen(): Promise<number> {
    // Start listening for events
    // Return the port or channel number
    return 3000;
  }
}
```

### Core Methods

| Method | Description |
|---|---|
| `listen()` | **Abstract.** Start listening for events. Must be implemented by each trigger. |
| `run(ctx)` | Execute the workflow with the given context. Returns `TriggerResponse` with context and metrics. |
| `createContext(logger?, blueprintPath?, id?)` | Create a fresh `Context` object for a new execution. |
| `getConfiguration()` | Returns a new `Configuration` instance. |
| `getRunner()` | Returns a `Runner` wired to the current workflow steps. |
| `startCounter()` / `endCounter(start)` | High-resolution performance timing helpers. |

### Monitoring Methods

| Method | Description |
|---|---|
| `enableRateLimiting(config)` | Enable token-bucket rate limiting. |
| `checkRateLimit(key)` | Check and consume a rate limit token. |
| `enableCircuitBreaker(config)` | Enable circuit breaker pattern. |
| `registerHealthDependency(name, fn)` | Register a dependency health check. |
| `getHealth()` | Run all health checks and return aggregated status. |
| `getLiveness()` | Quick liveness probe (is the process alive?). |
| `getReadiness()` | Readiness probe (are all dependencies healthy?). |
| `getTriggerMetrics()` | Get enhanced trigger metrics snapshot. |
| `destroyMonitoring()` | Clean up monitoring resources on shutdown. |

### HMR Methods

| Method | Description |
|---|---|
| `enableHotReload(config?)` | Start file watchers for dev-time hot reload. |
| `onHmrNodeChange(event)` | Called when a node file changes. Override for custom behavior. |
| `onHmrWorkflowChange(event)` | Called when a workflow file changes. |
| `onHmrTriggerChange(event)` | Called when a trigger config changes. |
| `getHmrStats()` | Return HMR statistics (reloads, errors, watched files). |
| `destroyHmr()` | Stop HMR watchers and clean up. |

## Available Triggers

Blok ships with nine built-in trigger types:

| Trigger | Directory | Protocol | Use Case |
|---|---|---|---|
| **HTTP** | `triggers/http` | HTTP/HTTPS (Express) | REST APIs, webhooks, web applications |
| **gRPC** | `triggers/grpc` | gRPC (protobuf) | Service-to-service communication |
| **Queue** | `triggers/queue` | AMQP / SQS / Redis | Background job processing |
| **PubSub** | `triggers/pubsub` | Pub/Sub (GCP, Kafka, Redis) | Event-driven architectures |
| **Cron** | `triggers/cron` | Cron expressions | Scheduled tasks |
| **Webhook** | `triggers/webhook` | HTTP callbacks | Third-party integrations |
| **WebSocket** | `triggers/websocket` | WebSocket (ws://) | Real-time bidirectional communication |
| **SSE** | `triggers/sse` | Server-Sent Events | Real-time unidirectional streaming |
| **Worker** | `triggers/worker` | In-process worker threads | CPU-intensive background work |

### HTTP Trigger

The most common trigger. Starts an Express server and routes requests to workflows based on URL path matching.

```typescript
import HttpTrigger from "@blokjs/trigger-http";

const trigger = new HttpTrigger();
const port = await trigger.listen();
console.log(`HTTP trigger listening on port ${port}`);
```

Workflow configuration for HTTP:

```json
{
  "name": "get-users",
  "version": "1.0.0",
  "trigger": {
    "http": {
      "method": "GET",
      "path": "/api/users",
      "cors": true
    }
  },
  "steps": [...]
}
```

### gRPC Trigger

Exposes workflows as gRPC services using protobuf definitions.

```json
{
  "trigger": {
    "grpc": {
      "port": 50051,
      "proto": "./proto/service.proto",
      "service": "UserService"
    }
  }
}
```

### Queue Trigger

Listens to message queues (AMQP, SQS, Redis) and processes messages as workflow executions.

```json
{
  "trigger": {
    "queue": {
      "provider": "amqp",
      "url": "${secret:AMQP_URL}",
      "queue": "tasks",
      "prefetch": 10,
      "ack": true
    }
  }
}
```

### PubSub Trigger

Subscribes to topics in event streaming platforms.

```json
{
  "trigger": {
    "pubsub": {
      "provider": "kafka",
      "brokers": ["localhost:9092"],
      "topic": "user-events",
      "groupId": "blok-consumer"
    }
  }
}
```

### Cron Trigger

Executes workflows on a schedule using cron expressions.

```json
{
  "trigger": {
    "cron": {
      "expression": "0 */5 * * * *",
      "timezone": "UTC"
    }
  }
}
```

### Webhook Trigger

Receives and validates incoming webhook payloads from third-party services.

```json
{
  "trigger": {
    "webhook": {
      "path": "/webhooks/stripe",
      "secret": "${secret:STRIPE_WEBHOOK_SECRET}",
      "signatureHeader": "stripe-signature"
    }
  }
}
```

### WebSocket Trigger

Maintains persistent WebSocket connections for real-time bidirectional communication.

```json
{
  "trigger": {
    "websocket": {
      "port": 8080,
      "path": "/ws",
      "heartbeatInterval": 30000
    }
  }
}
```

### SSE Trigger

Streams events to clients using Server-Sent Events.

```json
{
  "trigger": {
    "sse": {
      "path": "/events",
      "keepAliveInterval": 15000
    }
  }
}
```

### Worker Trigger

Runs workflows in a background worker thread, useful for CPU-intensive tasks that should not block the main event loop.

```json
{
  "trigger": {
    "worker": {
      "concurrency": 4,
      "pollInterval": 1000
    }
  }
}
```

## How Triggers Load Workflows

The workflow loading process follows these steps:

```
1. Trigger.listen() is called
          |
2. Configuration reads workflow JSON files
   from WORKFLOWS_PATH environment variable
          |
3. For each workflow:
   a. Parse trigger config (match trigger type)
   b. Load node definitions from NODES_PATH
   c. Resolve node modules from NodeMap
   d. Determine runtime for each step
   e. Wrap non-NodeJS steps in RuntimeAdapterNode
          |
4. Configuration.steps[] = resolved node list
          |
5. Trigger routes events to matching workflows
          |
6. Trigger.run(ctx) orchestrates execution
```

### Workflow Discovery

Workflows are discovered from the `WORKFLOWS_PATH` environment variable, which supports multiple comma-separated paths:

```bash
WORKFLOWS_PATH=./workflows/json,./workflows/custom
NODES_PATH=./nodes
```

## Context Creation from Trigger Events

Each trigger creates a `Context` object that flows through the entire workflow execution. The context contains:

```typescript
const ctx: Context = {
  id: requestId,              // Unique UUID per execution
  workflow_name: "get-users",  // From workflow JSON
  workflow_path: "/api/users", // Blueprint path
  config: nodeConfigurations,  // Node input configurations
  request: {
    body: {},                  // Trigger-specific payload
    headers: {},               // HTTP headers (if applicable)
    params: {},                // URL path parameters
    query: {},                 // Query string parameters
    method: "GET",             // HTTP method
    url: "/api/users",         // Request URL
    cookies: {},               // Cookies
    baseUrl: "",               // Base URL
  },
  response: {
    data: "",                  // Output data
    contentType: "",           // Response content type
    success: true,             // Execution status
    error: null,               // Error information
  },
  error: { message: [] },     // Error accumulator
  logger: logger,             // Logger instance
  env: process.env,           // Environment variables
};
```

Each trigger type populates the context differently:

| Trigger | `request.body` | `request.headers` | `request.params` |
|---|---|---|---|
| HTTP | Request body | HTTP headers | URL params |
| gRPC | Protobuf message | gRPC metadata | Service/method |
| Queue | Message payload | Message attributes | Queue name |
| PubSub | Event data | Event attributes | Topic/subscription |
| Cron | `{}` | `{}` | Schedule expression |
| WebSocket | Frame data | Connection headers | Connection ID |

## Monitoring and Metrics

### OpenTelemetry Metrics

Every `TriggerBase.run()` call automatically records:

| Metric | Type | Description |
|---|---|---|
| `workflow` | Counter | Total workflow executions |
| `workflow_time` | Gauge | Execution time in ms |
| `workflow_memory` | Gauge | Peak memory usage (MB) |
| `workflow_memory_average` | Gauge | Average memory usage (MB) |
| `workflow_memory_usage_min` | Gauge | Minimum memory usage (MB) |
| `workflow_memory_total` | Gauge | Total system memory (MB) |
| `workflow_memory_free` | Gauge | Free system memory (MB) |
| `workflow_cpu` | Gauge | CPU usage percentage |
| `workflow_cpu_average` | Gauge | Average CPU usage |
| `workflow_cpu_total` | Gauge | Total CPU time |

All metrics include labels: `env`, `workflow_version`, `workflow_name`, `workflow_path`.

### Prometheus Bridge

The `PrometheusMetricsBridge` translates OpenTelemetry metrics into Prometheus format, exposable via a `/metrics` HTTP endpoint:

```typescript
// Automatically initialized in TriggerBase constructor
this.metricsBridge = new PrometheusMetricsBridge(
  { triggerType: "HttpTrigger", triggerName: "api" },
  this.metricsCollector
);
```

### Health Checks

Register dependency health checks for Kubernetes probes:

```typescript
trigger.registerHealthDependency("database", async () => {
  const start = performance.now();
  await db.ping();
  return {
    status: "healthy",
    latency_ms: performance.now() - start,
    lastChecked: Date.now(),
  };
});

// Endpoints
// GET /health     -> trigger.getHealth()
// GET /liveness   -> trigger.getLiveness()
// GET /readiness  -> trigger.getReadiness()
```

### Rate Limiting

Enable token-bucket rate limiting:

```typescript
trigger.enableRateLimiting({
  maxTokens: 100,        // Bucket size
  refillRate: 10,        // Tokens per second
  keyStrategy: "client", // Per-client rate limiting
});

// In request handler
const result = trigger.checkRateLimit(clientIp);
if (!result.allowed) {
  // Return 429 with Retry-After header
  res.setHeader("Retry-After", Math.ceil(result.retryAfterMs / 1000));
  return res.status(429).json({ error: "Rate limit exceeded" });
}
```

### Circuit Breaker

Protect against cascading failures:

```typescript
trigger.enableCircuitBreaker({
  failureThreshold: 5,       // Open after 5 failures
  resetTimeoutMs: 30000,     // Try recovery after 30s
  halfOpenMaxAttempts: 3,    // 3 successful calls to close
  failureWindowMs: 60000,    // Rolling 60s failure window
});
```

## Custom Trigger Development

To create a custom trigger:

1. Extend `TriggerBase`
2. Implement `listen()`
3. Call `this.run(ctx)` for each event

```typescript
import TriggerBase from "@blokjs/runner/TriggerBase";
import type { Context } from "@blokjs/shared";

export default class MQTTTrigger extends TriggerBase {
  private client: MQTTClient;

  async listen(): Promise<number> {
    this.client = await mqtt.connect(process.env.MQTT_URL);

    this.client.subscribe(this.configuration.trigger.mqtt.topic);

    this.client.on("message", async (topic, payload) => {
      const ctx = this.createContext();

      // Populate context from MQTT message
      ctx.request.body = JSON.parse(payload.toString());
      ctx.request.headers = { "x-mqtt-topic": topic };

      try {
        const { ctx: resultCtx } = await this.run(ctx);
        // Handle result if needed
      } catch (error) {
        ctx.logger.log(`MQTT handler error: ${error.message}`);
      }
    });

    return 1883; // MQTT default port
  }
}
```

Register and use the custom trigger:

```json
{
  "trigger": {
    "mqtt": {
      "topic": "sensors/temperature",
      "qos": 1
    }
  }
}
```

## See Also

- [Runtime Adapter System](/architecture/runtime-adapters) -- how different runtimes execute nodes
- [Observability](/architecture/observability) -- distributed tracing and metrics
- [Security Model](/architecture/security-model) -- authentication middleware for triggers
