---
title: "Observability"
description: "Architecture documentation for distributed tracing, logging, metrics, and monitoring in Blok"
---

# Observability

Blok provides a comprehensive observability stack built on OpenTelemetry, Prometheus, and structured logging. Every workflow execution, node invocation, and trigger event is instrumented with metrics, traces, and logs.

## Architecture Overview

```
                   Blok Application
         +-----------------------------+
         |  TriggerBase                 |
         |  +-- OpenTelemetry Metrics   |
         |  +-- Prometheus Bridge       |
         |  +-- TriggerMetricsCollector |
         |  +-- Structured Logger       |
         |                              |
         |  NanoService (Nodes)         |
         |  +-- Node-level OTel meters  |
         |  +-- Execution tracing       |
         |                              |
         |  Integrations                |
         |  +-- SentryIntegration       |
         |  +-- APM Bridge             |
         +-----------------------------+
                    |
         +----------+----------+
         |          |          |
    Prometheus   Sentry    CloudWatch/
    /metrics    (errors)   Azure Monitor
         |          |          |
    Grafana    Sentry UI   AWS/Azure
    Dashboards             Console
```

## Distributed Tracing (OpenTelemetry)

Blok uses the OpenTelemetry SDK for distributed tracing. Every workflow execution creates a trace that spans across all node executions.

### Setup

```typescript
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

const provider = new NodeTracerProvider({
  resource: new Resource({
    [ATTR_SERVICE_NAME]: "blok-api",
  }),
});

provider.addSpanProcessor(
  new SimpleSpanProcessor(
    new OTLPTraceExporter({
      url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318/v1/traces",
    })
  )
);

provider.register();
```

### Trace Structure

```
Trace: workflow-execution (root span)
  |
  +-- node: validate-input
  |     duration: 2ms
  |     attributes: { node_name, workflow_name, node_type }
  |
  +-- node: fetch-user (python3 runtime)
  |     duration: 45ms
  |     attributes: { node_name, runtime: "python3", grpc_host }
  |
  +-- node: transform-response
        duration: 1ms
        attributes: { node_name, workflow_name }
```

### Environment Variables

| Variable | Description |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP collector endpoint |
| `OTEL_SERVICE_NAME` | Service name in traces |
| `OTEL_TRACES_SAMPLER` | Sampling strategy (`always_on`, `parentbased_traceidratio`) |
| `OTEL_TRACES_SAMPLER_ARG` | Sampling rate (e.g., `0.1` for 10%) |
| `OTEL_RESOURCE_ATTRIBUTES` | Additional resource attributes |

## Structured Logging

Blok uses structured JSON logging via the `DefaultLogger` class. Every log entry includes workflow context for correlation.

### Log Format

```json
{
  "timestamp": "2024-01-15T10:30:00.000Z",
  "level": "info",
  "message": "Running node: fetch-user",
  "workflow_name": "get-users",
  "workflow_path": "/api/users",
  "request_id": "550e8400-e29b-41d4-a716-446655440000",
  "node_name": "fetch-user",
  "duration_ms": 42.5,
  "env": "production"
}
```

### Logger Context

The `DefaultLogger` is initialized per-request with workflow metadata:

```typescript
const logger = new DefaultLogger(
  "get-users",           // workflow name
  "/api/users",          // workflow path
  "550e8400-e29b..."     // request ID
);

logger.log("Processing request");
logger.log("Node completed in 42ms");
```

### Log Levels

| Level | Use Case |
|---|---|
| `log` | General execution information |
| `error` | Errors and failures |
| `warn` | Warnings and degraded conditions |
| `debug` | Detailed diagnostic information |

## Prometheus Metrics

### Built-in Metrics

Blok automatically records these metrics via OpenTelemetry and the Prometheus bridge.

#### Workflow Metrics

| Metric | Type | Labels | Description |
|---|---|---|---|
| `workflow` | Counter | env, workflow_version, workflow_name, workflow_path | Total workflow executions |
| `workflow_time` | Gauge | env, workflow_version, workflow_name, workflow_path | Execution time (ms) |
| `workflow_memory` | Gauge | env, workflow_version, workflow_name, workflow_path | Peak memory (MB) |
| `workflow_memory_average` | Gauge | env, workflow_version, workflow_name, workflow_path | Average memory (MB) |
| `workflow_memory_usage_min` | Gauge | env, workflow_version, workflow_name, workflow_path | Minimum memory (MB) |
| `workflow_memory_total` | Gauge | env, workflow_version, workflow_name, workflow_path | Total system memory (MB) |
| `workflow_memory_free` | Gauge | env, workflow_version, workflow_name, workflow_path | Free system memory (MB) |
| `workflow_cpu` | Gauge | env, workflow_version, workflow_name, workflow_path | CPU usage (%) |
| `workflow_cpu_average` | Gauge | env, workflow_version, workflow_name, workflow_path | Average CPU (%) |
| `workflow_cpu_total` | Gauge | env, workflow_version, workflow_name, workflow_path | Total CPU time |

#### Node Metrics

| Metric | Type | Labels | Description |
|---|---|---|---|
| `node` | Counter | env, workflow_path, workflow_name, node_name, node | Total node executions |
| `node_time` | Gauge | env, workflow_path, workflow_name, node_name, node | Node execution time (ms) |
| `node_memory` | Gauge | env, workflow_path, workflow_name, node_name, node | Node peak memory (MB) |
| `node_memory_average` | Gauge | env, workflow_path, workflow_name, node_name, node | Node average memory (MB) |
| `node_cpu` | Gauge | env, workflow_path, workflow_name, node_name, node | Node CPU usage (%) |
| `node_errors` | Counter | env, workflow_path, workflow_name, node_name, node | Node error count |

#### Trigger Metrics

The `TriggerMetricsCollector` provides additional trigger-specific metrics:

| Metric | Type | Description |
|---|---|---|
| `trigger_requests_total` | Counter | Total requests received |
| `trigger_request_duration_seconds` | Histogram | Request duration distribution |
| `trigger_active_connections` | Gauge | Currently active connections |
| `trigger_errors_total` | Counter | Total trigger errors |
| `trigger_rate_limited_total` | Counter | Requests rejected by rate limiter |
| `trigger_circuit_breaker_state` | Gauge | Circuit breaker state (0=closed, 1=open, 2=half-open) |

### Prometheus Bridge

The `PrometheusMetricsBridge` translates OpenTelemetry metrics to Prometheus format:

```typescript
// Automatically initialized in TriggerBase constructor
const bridge = new PrometheusMetricsBridge(
  {
    triggerType: "HttpTrigger",
    triggerName: "api-gateway",
  },
  metricsCollector
);

bridge.initialize();

// Record execution metrics
bridge.recordExecution(durationMs, success, {
  workflow_name: "get-users",
  workflow_version: "1.0.0",
  env: "production",
});
```

### Exposing /metrics

```typescript
import express from "express";

const app = express();

app.get("/metrics", async (req, res) => {
  const metrics = trigger.getTriggerMetrics();
  res.set("Content-Type", "text/plain");
  res.send(formatPrometheus(metrics));
});
```

## Grafana Dashboards

Blok provides pre-built Grafana dashboards for monitoring:

### Workflow Overview Dashboard

Panels:
- **Workflow Execution Rate** -- Requests per second by workflow
- **Workflow Latency** -- P50, P95, P99 execution times
- **Error Rate** -- Error percentage by workflow
- **Memory Usage** -- Peak and average memory per workflow
- **CPU Usage** -- CPU utilization trends

### Node Performance Dashboard

Panels:
- **Node Execution Time** -- Per-node latency breakdown
- **Node Error Rate** -- Errors by node and workflow
- **Runtime Distribution** -- Execution count by runtime type
- **Node Memory Profile** -- Memory consumption per node

### Trigger Health Dashboard

Panels:
- **Request Volume** -- Requests per second by trigger type
- **Active Connections** -- WebSocket/SSE connection count
- **Rate Limiting** -- Rejected requests and bucket utilization
- **Circuit Breaker State** -- State transitions over time
- **Health Check Status** -- Dependency health over time

### Dashboard Import

```bash
# Import dashboards from the infra/grafana directory
nanoctl monitor dashboards import --path ./infra/grafana/dashboards/
```

## Sentry Error Tracking

The `SentryIntegration` provides error tracking with full workflow context:

```typescript
import { SentryIntegration } from "@nanoservice-ts/runner";

const sentry = new SentryIntegration({
  dsn: process.env.SENTRY_DSN!,
  environment: process.env.NODE_ENV || "development",
  release: "blok@1.0.0",
  tracesSampleRate: 0.1,   // Sample 10% of transactions
  sampleRate: 1.0,          // Capture 100% of errors
  tags: {
    service: "blok-api",
    team: "backend",
  },
});

await sentry.init();
```

### Capturing Errors

```typescript
// Workflow execution errors
sentry.captureWorkflowError(error, {
  workflowName: "get-users",
  workflowPath: "/api/users",
  workflowVersion: "1.0.0",
  requestId: ctx.id,
  nodeName: "fetch-user",
  nodeType: "module",
  triggerType: "http",
  durationMs: 42.5,
});

// Node-specific errors
sentry.captureNodeError(error, "fetch-user", "module", {
  workflowName: "get-users",
  requestId: ctx.id,
});

// Trigger errors
sentry.captureTriggerError(error, "http", {
  endpoint: "/api/users",
  method: "GET",
});

// Warnings
sentry.captureWarning("High memory usage detected", {
  memoryMB: 512,
  threshold: 256,
});
```

### Sentry Context

All Sentry events include:
- `framework: "blok"` tag
- Workflow name, path, and version
- Request ID for correlation with logs
- Node name and type (for node errors)
- Environment and release version

## APM Integration

### DataDog

```typescript
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

// DataDog uses OTLP-compatible endpoints
const provider = new NodeTracerProvider();
provider.addSpanProcessor(
  new SimpleSpanProcessor(
    new OTLPTraceExporter({
      url: "http://localhost:4318/v1/traces",  // DD Agent OTLP endpoint
    })
  )
);
```

Environment variables for DataDog:

```bash
DD_AGENT_HOST=localhost
DD_TRACE_AGENT_PORT=8126
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
DD_SERVICE=blok-api
DD_ENV=production
DD_VERSION=1.0.0
```

### New Relic

```typescript
// New Relic uses OTLP-compatible endpoints
const exporter = new OTLPTraceExporter({
  url: "https://otlp.nr-data.net:4318/v1/traces",
  headers: {
    "api-key": process.env.NEW_RELIC_LICENSE_KEY!,
  },
});
```

## CloudWatch and Azure Monitor

### AWS CloudWatch

```typescript
// CloudWatch integration via OpenTelemetry Collector
// otel-collector-config.yaml
exporters:
  awscloudwatchlogs:
    log_group_name: "/blok/workflows"
    log_stream_name: "api-gateway"
    region: "us-east-1"
  awsemf:
    namespace: "Blok"
    region: "us-east-1"
    dimension_rollup_option: "NoDimensionRollup"
```

Environment variables:

```bash
AWS_REGION=us-east-1
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
```

### Azure Monitor

```typescript
// Azure Monitor via Application Insights exporter
import { AzureMonitorTraceExporter } from "@azure/monitor-opentelemetry-exporter";

const exporter = new AzureMonitorTraceExporter({
  connectionString: process.env.APPLICATIONINSIGHTS_CONNECTION_STRING!,
});
```

## Health Checks

The `HealthCheck` class provides Kubernetes-compatible health probes:

```typescript
// Register dependency checks
trigger.registerHealthDependency("database", async () => {
  const start = performance.now();
  try {
    await db.query("SELECT 1");
    return {
      status: "healthy",
      latency_ms: performance.now() - start,
      lastChecked: Date.now(),
    };
  } catch (err) {
    return {
      status: "unhealthy",
      message: err.message,
      latency_ms: performance.now() - start,
      lastChecked: Date.now(),
    };
  }
});

trigger.registerHealthDependency("redis", async () => {
  const start = performance.now();
  await redis.ping();
  return {
    status: "healthy",
    latency_ms: performance.now() - start,
    lastChecked: Date.now(),
  };
});
```

### Health Response

```json
{
  "status": "healthy",
  "timestamp": 1705312200000,
  "uptime": 3600000,
  "checks": {
    "database": {
      "status": "healthy",
      "latency_ms": 2.5,
      "lastChecked": 1705312200000
    },
    "redis": {
      "status": "healthy",
      "latency_ms": 0.8,
      "lastChecked": 1705312200000
    }
  }
}
```

### Kubernetes Probes

```yaml
# kubernetes deployment
livenessProbe:
  httpGet:
    path: /liveness
    port: 3000
  initialDelaySeconds: 5
  periodSeconds: 10

readinessProbe:
  httpGet:
    path: /readiness
    port: 3000
  initialDelaySeconds: 10
  periodSeconds: 5
```

### Health Status Aggregation

| Aggregate Status | Condition |
|---|---|
| `healthy` | All dependencies healthy |
| `degraded` | At least one dependency degraded, none unhealthy |
| `unhealthy` | At least one dependency unhealthy |

## Rate Limiting

Token-bucket rate limiting protects triggers from overload:

```typescript
trigger.enableRateLimiting({
  maxTokens: 100,         // Burst capacity
  refillRate: 10,          // 10 requests/second sustained
  keyStrategy: "client",   // Per-client limiting
});

// In request handler
const result = trigger.checkRateLimit(clientIP);

if (!result.allowed) {
  res.status(429).json({
    error: "Rate limit exceeded",
    retryAfterMs: result.retryAfterMs,
    limit: result.limit,
    remaining: result.remaining,
  });
}
```

## Circuit Breakers

Prevent cascading failures with the circuit breaker pattern:

```typescript
trigger.enableCircuitBreaker({
  failureThreshold: 5,        // Open after 5 failures
  resetTimeoutMs: 30000,      // Try half-open after 30s
  halfOpenMaxAttempts: 3,     // 3 successes to close
  failureWindowMs: 60000,     // Rolling 60s window
});
```

### Circuit States

```
  CLOSED ----[failures >= threshold]----> OPEN
     ^                                       |
     |                              [resetTimeoutMs]
     |                                       |
     +----[successes >= halfOpenMax]---- HALF_OPEN
```

| State | Behavior |
|---|---|
| `CLOSED` | Normal operation, requests flow through |
| `OPEN` | All requests rejected with `CircuitOpenError` |
| `HALF_OPEN` | Limited requests allowed to test recovery |

## See Also

- [Trigger System](/docs/architecture/trigger-system) -- monitoring infrastructure in triggers
- [Security Model](/docs/architecture/security-model) -- audit logging for security events
- [Runtime Adapters](/docs/architecture/runtime-adapters) -- per-runtime metrics
