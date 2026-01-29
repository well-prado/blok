# Module Reference: Observability

> **Path:** `core/runner/src/monitoring/` + `core/runner/src/integrations/`
> **Purpose:** Structured logging, distributed tracing, metrics, health checks, and external monitoring

## What It Does

The observability module provides production-grade monitoring capabilities including OpenTelemetry-based distributed tracing, Prometheus metrics, structured JSON logging, circuit breakers, rate limiters, health checks, and integrations with DataDog, New Relic, Sentry, AWS CloudWatch, and Azure Monitor.

## Source Files

### Monitoring (`core/runner/src/monitoring/`)
```
├── index.ts                      # Barrel export
├── DistributedTracer.ts          # OpenTelemetry tracing (301 lines)
├── StructuredLogger.ts           # JSON structured logging (264 lines)
├── PrometheusMetricsBridge.ts    # Prometheus metrics (253 lines)
├── PrometheusBootstrap.ts        # Prometheus initialization (99 lines)
├── TracingBootstrap.ts           # OpenTelemetry setup (178 lines)
├── PerformanceProfiler.ts        # Workflow profiling (309 lines)
├── CircuitBreaker.ts             # Circuit breaker pattern (306 lines)
├── RateLimiter.ts                # Token bucket rate limiter (166 lines)
├── HealthCheck.ts                # Health check endpoints (130 lines)
└── TriggerMetricsCollector.ts    # Trigger-specific metrics (231 lines)
```

### Integrations (`core/runner/src/integrations/`)
```
├── index.ts                      # Barrel export
├── APMIntegration.ts             # DataDog / New Relic APM (278 lines)
├── SentryIntegration.ts          # Sentry error tracking (285 lines)
├── CloudWatchIntegration.ts      # AWS CloudWatch (420 lines)
└── AzureMonitorIntegration.ts    # Azure Monitor (335 lines)
```

### Infrastructure (`infra/metrics/`)
```
├── docker-compose.yml            # Prometheus + Grafana + Loki + Tempo
├── prometheus.yml                # Prometheus scrape config
├── datasources.yml               # Grafana datasource config
├── default.yaml                  # Grafana dashboard provisioning
└── dashboards/
    ├── blok-overview.json        # System overview dashboard
    ├── blok-system.json          # System metrics dashboard
    ├── blok-tracing.json         # Distributed tracing dashboard
    └── blok-triggers.json        # Trigger metrics dashboard
```

## Components

### DistributedTracer
- **Technology:** OpenTelemetry
- **Features:** Span creation, context propagation, W3C trace context, baggage
- **Exports to:** OTLP (gRPC/HTTP), Jaeger, Zipkin

### StructuredLogger
- **Format:** JSON with timestamp, level, message, trace_id, span_id
- **Targets:** stdout, Loki, CloudWatch, Azure Monitor
- **Levels:** error, warn, info, debug, trace
- **Context enrichment:** Automatic workflow/node/trigger metadata

### PrometheusMetricsBridge
- **Metrics:** Counters, gauges, histograms, summaries
- **Built-in metrics:**
  - `blok_workflow_executions_total` — Workflow execution count
  - `blok_workflow_duration_seconds` — Execution duration histogram
  - `blok_node_executions_total` — Node execution count
  - `blok_node_errors_total` — Node error count
  - `blok_trigger_events_total` — Trigger event count
  - `blok_runtime_adapter_calls_total` — Runtime adapter calls
  - `blok_cache_hits_total` / `blok_cache_misses_total`

### CircuitBreaker
- **States:** Closed (normal) → Open (failing) → Half-Open (testing)
- **Configuration:** Failure threshold, reset timeout, half-open max calls
- **Behavior:** Prevents cascade failures by stopping calls to failing nodes

### RateLimiter
- **Algorithm:** Token bucket
- **Configuration:** Max tokens, refill rate, per-identity limits
- **Targets:** Per-workflow, per-trigger, per-node rate limiting

### HealthCheck
- **Endpoint:** `/health`
- **Checks:** Database connectivity, runtime availability, queue broker, memory usage
- **Format:** Standard health check JSON response

### Grafana Dashboards (4 pre-built)
| Dashboard | Panels |
|-----------|--------|
| **Overview** | Request rate, error rate, latency percentiles, active workflows |
| **System** | CPU, memory, event loop, GC metrics |
| **Tracing** | Trace waterfall, span durations, error traces |
| **Triggers** | Per-trigger metrics, queue depths, processing rates |

## Tests

```
core/runner/src/monitoring/__tests__/
├── DistributedTracer.test.ts          (316 lines)
├── PerformanceProfiler.test.ts        (251 lines)
├── PrometheusBootstrap.test.ts        (142 lines)
├── PrometheusMetricsBridge.test.ts    (330 lines)
├── StructuredLogger.test.ts           (376 lines)
└── TracingBootstrap.test.ts           (145 lines)

core/runner/__tests__/unit/
├── CircuitBreaker.test.ts             (364 lines)
├── HealthCheck.test.ts                (170 lines)
├── MonitoringIntegration.test.ts      (670 lines)
├── RateLimiter.test.ts                (169 lines)
└── TriggerMetricsCollector.test.ts    (227 lines)

core/runner/src/__tests__/integrations/
└── SentryIntegration.test.ts          (207 lines)

core/runner/src/integrations/__tests__/
├── APMIntegration.test.ts             (248 lines)
├── AzureMonitorIntegration.test.ts    (373 lines)
└── CloudWatchIntegration.test.ts      (317 lines)
```

## What to Document

1. **Observability overview** — What's available and how pieces connect
2. **Quick start** — Setting up Prometheus + Grafana with docker-compose
3. **Structured logging** — Configuration, log levels, output targets
4. **Distributed tracing** — OpenTelemetry setup, trace propagation
5. **Prometheus metrics** — Available metrics, custom metrics, scrape config
6. **Grafana dashboards** — Importing, customizing, alerting
7. **Circuit breaker** — Configuration, behavior, monitoring
8. **Rate limiting** — Setup, strategies, monitoring
9. **Health checks** — Endpoint configuration, custom checks
10. **APM integration** — DataDog, New Relic setup
11. **Error tracking** — Sentry integration
12. **Cloud monitoring** — CloudWatch, Azure Monitor setup
