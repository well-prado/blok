# Blok Observability

The operator's guide to running Blok in production with metrics, traces, logs,
and alerts. Everything below is wired in the framework today — no roadmap, no
"coming soon".

The four surfaces:

| Surface | What you get | Where |
|---|---|---|
| **Metrics** | `blok_*` Prometheus families (executions, duration, errors, concurrency, scheduling, runtime, janitor) | `/metrics` on each trigger |
| **Traces** | OTLP distributed spans → Tempo/Jaeger; durable run history in Blok Studio | OTLP endpoint + `BLOK_TRACE_STORE` |
| **Logs** | Structured JSON with `run_id` / `trace_id` / `span_id` correlation | stdout → Loki |
| **Alerts** | Prometheus alert rules for error rate, crashes, timeouts, throttling, latency | `infra/metrics/rules/blok-alerts.yml` / Helm PrometheusRule |

---

## Quickstart — local stack in 5 minutes

The dev stack (Prometheus + Grafana + Loki + Tempo + Alertmanager) lives in
[`infra/metrics/docker-compose.yml`](../infra/metrics/docker-compose.yml).

```bash
# 1. The stack uses an external network so other compose files can join it.
docker network create shared-network

# 2. Bring up the observability stack.
docker compose -f infra/metrics/docker-compose.yml up -d

# 3. Point your Blok HTTP trigger at the stack and start it.
#    Traces flow to Tempo; metrics are scraped from /metrics.
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export BLOK_TRACE_STORE=sqlite          # durable run history (the default)
bun run http:dev

# 4. Open the dashboards.
open http://localhost:3000              # Grafana  (dashboards auto-provisioned)
open http://localhost:9090              # Prometheus
open http://localhost:9093              # Alertmanager
open http://localhost:4000/__blok       # Blok Studio (run traces)
open http://localhost:4000/metrics      # raw Prometheus scrape
```

What you get out of the box:

- **Prometheus** (`:9090`) scrapes `blok-http:4000`, `blok-grpc:9091`, and
  other triggers on `:9464` (see `infra/metrics/prometheus.yml`), and loads
  the alert rules from `/etc/prometheus/rules/`.
- **Grafana** (`:3000`) is pre-provisioned with the Prometheus, Loki, and Tempo
  datasources (`infra/metrics/datasources.yml`) and the Blok dashboards under
  `infra/metrics/dashboards/`. Loki log lines link to Tempo traces via the
  `trace_id` derived field; Tempo spans link back to Loki logs
  (`tracesToLogsV2`).
- **Tempo** (`:4317` gRPC / `:4318` HTTP) receives OTLP spans.
- **Loki** (`:3100`) stores logs; ship Blok's stdout to it via the Docker Loki
  log driver (the commented `blok-http` service in the compose file shows the
  wiring).
- **Alertmanager** (`:9093`) receives firing alerts — configure your receivers
  (Slack / PagerDuty / email) in `infra/metrics/alertmanager.yml`.

> The dev compose targets (`blok-http`, `blok-grpc`, …) are container DNS names.
> Running Blok outside Docker? Either run it as the commented `blok-http`
> service in the compose file, or edit `prometheus.yml` to scrape
> `host.docker.internal:4000`.

---

## Metrics

### How metrics are exposed

Blok uses the OpenTelemetry metrics API. Every instrument lives on the `blok`
meter (a handful of legacy gauges live on the `default` meter — see below).
There are two exporter wirings depending on the trigger:

| Trigger | Exporter | Endpoint |
|---|---|---|
| **HTTP** | `triggers/http/src/runner/metrics/opentelemetry_metrics.ts` | `GET /metrics` on the main HTTP port (default **4000**) |
| **Other triggers** (worker, cron, …) | `PrometheusBootstrap` (`core/runner/src/monitoring/PrometheusBootstrap.ts`) | `/metrics` on its own port — `BLOK_METRICS_PORT`, default **9464** |
| **gRPC** | scraped at `:9091` (per `infra/metrics/prometheus.yml`) | `/metrics` |

The OpenTelemetry SDK packages (`@opentelemetry/sdk-metrics`,
`@opentelemetry/exporter-prometheus`) are optional peer deps. When they aren't
installed, instrument recordings are silently swallowed — Blok runs fine
without an exporter, you just get no metrics. Install them to light up
`/metrics`.

### Metrics reference

All current `blok_*` families, their type, labels, and meaning. Every name and
label below was read out of the source — they are emitted as written.

#### Workflow-level (`PrometheusMetricsBridge`)

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `blok_workflow_executions_total` | counter | `trigger_type`, `trigger_name`, `workflow_name`, `status` (`success`\|`error`), `env` | Total workflow runs. The denominator for error-rate. |
| `blok_workflow_duration_seconds` | histogram | `trigger_type`, `trigger_name`, `workflow_name`, `env` | End-to-end run duration. Use `_bucket` + `histogram_quantile` for p99. |
| `blok_workflow_errors_total` | counter | `trigger_type`, `trigger_name`, `error_category`, `env`, `status`? | Failed runs. `status` (when present) is the terminal run state: `failed` \| `crashed` \| `timedOut` \| `throttled` \| `cancelled` — lets you split logic failures from process crashes and SLA timeouts. |
| `blok_trigger_latency_p50_seconds` | gauge | `trigger_type`, `trigger_name` | Request latency p50 (pulled at scrape time). |
| `blok_trigger_latency_p95_seconds` | gauge | `trigger_type`, `trigger_name` | Request latency p95. |
| `blok_trigger_latency_p99_seconds` | gauge | `trigger_type`, `trigger_name` | Request latency p99. |
| `blok_trigger_throughput_rps` | gauge | `trigger_type`, `trigger_name` | Requests per second. |
| `blok_trigger_success_rate` | gauge | `trigger_type`, `trigger_name` | Success rate, 0–1. |
| `blok_trigger_active_connections` | gauge | `trigger_type`, `trigger_name` | Active connections (WebSocket/SSE). |
| `blok_process_memory_heap_bytes` | gauge | `trigger_type` | Process heap used. |
| `blok_process_memory_rss_bytes` | gauge | `trigger_type` | Process RSS. |
| `blok_circuit_breaker_state` | gauge | `trigger_type`, `trigger_name` | 0 = closed, 1 = open, 2 = half-open. |
| `blok_rate_limiter_remaining` | gauge | `trigger_type`, `trigger_name` | Remaining tokens in the global rate-limit bucket. |

#### Node-level (`Blok.ts`)

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `blok_node_executions_total` | counter | `env`, `workflow_path`, `workflow_name`, `node_name` | Total node executions. |
| `blok_node_duration_seconds` | histogram | `env`, `workflow_path`, `workflow_name`, `node_name` | Per-node duration (seconds). The basis for `blokctl profile` bottleneck detection. |
| `blok_node_errors_total` | counter | `env`, `workflow_path`, `workflow_name`, `node_name` | Per-node execution errors. |

> Legacy gauges (`node`, `node_time`, `node_memory`, `node_cpu`, `node_errors`,
> and the `*_average` / `*_min` / `*_total` / `*_free` variants) are still
> emitted on the `default` meter for backwards compatibility — they back
> `blokctl profile`, which queries `node_time` / `node_memory` / `node_cpu`.
> New dashboards should prefer the canonical `blok_node_*` families above.

#### Cross-language runtime nodes (`GrpcRuntimeAdapter`)

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `blok_runtime_node_duration_seconds` | histogram | `runtime_kind`, `node_name`, `workflow_name` | Duration of a node executed over gRPC in a non-Node runtime (`python3`, `go`, `rust`, …). |
| `blok_runtime_node_errors_total` | counter | `runtime_kind`, `node_name`, `workflow_name`, `reason`? | gRPC execution failures for a cross-language node. |

#### Concurrency + scheduling (`ConcurrencyMetrics`)

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `blok_concurrency_acquired_total` | counter | `workflow_name`, `concurrency_key`? | Concurrency slots granted. |
| `blok_concurrency_denied_total` | counter | `workflow_name`, `concurrency_key`?, `mode` (`throw`\|`queue`) | Slot denials — a tenant hit its limit. Throttle alerts key off this. |
| `blok_concurrency_released_total` | counter | `workflow_name`, `concurrency_key`? | Slots released on terminal run state. |
| `blok_concurrency_backend_install_total` | counter | `backend`, `status` (`success`\|`failure`) | Concurrency-backend install attempts — surfaces a silent fallback when the cross-process backend is misconfigured. |
| `blok_concurrency_occ_retries` | histogram | `workflow_name`, `concurrency_key`?, `outcome` (`success`\|`denied`\|`fail-closed`) | OCC retry depth on cross-process backends (buckets 0–10). |
| `blok_scheduling_dispatch_recovered_total` | counter | `workflow_name`, `trigger_type`, `dispatch_status`? | Scheduled dispatches re-registered on boot recovery. |
| `blok_scheduling_dispatch_expired_total` | counter | `workflow_name`, `trigger_type`, `dispatch_status`? | Scheduled dispatches marked expired (TTL elapsed) at boot. |
| `blok_scheduling_dispatch_fired_total` | counter | `workflow_name`, `trigger_type`, `dispatch_status`? | Deferred dispatches fired by the in-process scheduler. |

> `concurrency_key` is **off by default** — it can be per-user / per-tenant
> (high cardinality). Set `BLOK_METRICS_PER_KEY=1` to emit it as a label.

#### Sub-workflows + forEach

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `blok_subworkflow_async_failure_total` | counter | `workflow_name`, `dispatch` (`in-process`\|`http-self`) | Fire-and-forget (`wait:false`) sub-workflow dispatch failures, by parent workflow + strategy. |
| `blok_foreach_wait_cancelled_total` | counter | `workflow_name` | Iterations cancelled because a peer fired a `wait` inside a parallel `forEach`. High → authors should add `idempotencyKey` to inner steps. |

#### Process health + janitor

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `blok_unhandled_rejection_total` | counter | `trigger_type`, `reason_class` | `uncaughtException` / `unhandledRejection` events caught by the crash handlers. `reason_class` is the error constructor name (`TypeError`, …). Page on any non-zero rate. |
| `blok_janitor_sweep_duration_ms` | histogram | `table` (`idempotency_cache`\|`concurrency_locks`\|`scheduled_dispatches`) | Per-table janitor sweep duration. Doubles as a liveness signal. |
| `blok_janitor_purged_total` | counter | `table` | Rows purged per table (recorded even at zero so you can tell "running, clean" from "not running"). |
| `blok_janitor_sweep_errors_total` | counter | `table` | Per-table sweep failures — alert on a store that can't sweep (disk full, locked). |

---

## Traces

### Distributed tracing (OTLP → Tempo / Jaeger)

Set an OTLP endpoint and Blok installs the OpenTelemetry trace SDK at boot
(`HttpTrigger`/`WorkerTrigger`). No endpoint set → tracing is a no-op.

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318   # base; Blok appends /v1/traces
# or be explicit:
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:4318/v1/traces
```

Defaults to the `http/protobuf` protocol. The OTel trace SDK is an optional
peer dep — if it isn't installed, Blok logs a warning and tracing stays off
(metrics and Studio still work).

### Durable run history (Blok Studio)

Separate from OTLP, Blok records every run + step (inputs, outputs, errors,
timing) to a **RunStore**, surfaced at `/__blok` (Blok Studio) and the
`/__blok/runs` REST API. This is the durable record that survives restarts and
backs replay, idempotency caching, the durable scheduler, and concurrency
locks — they all share the store.

Pick the backend with `BLOK_TRACE_STORE` (see `createStore.ts`):

| `BLOK_TRACE_STORE` | Backend | Durable? | When |
|---|---|---|---|
| `sqlite` (**default** outside tests) | `better-sqlite3` file | Yes | Single-process production / dev. |
| `postgres` | PostgreSQL (`pg`) | Yes | Multi-process / HA deployments. |
| `memory` | In-process Map | **No — lost on restart** | Tests (`NODE_ENV=test` auto-selects this). |

> **Durable by default.** Outside tests, Blok defaults to `sqlite` — a bare
> `docker run` / `helm install` gets a durable store automatically. If
> `better-sqlite3` isn't installed (or the FS is read-only) the implicit
> default falls back to in-memory **with a loud warning** that runs, the
> idempotency cache, and the durable scheduler are lost on restart. An
> *explicit* `BLOK_TRACE_STORE=sqlite` fails loudly instead of falling back.

---

## Logs

Blok's `DefaultLogger` emits one structured JSON object per line on stdout.
Correlation keys join a log line to its Studio run and its Tempo trace:

| Field | Always present | Meaning |
|---|---|---|
| `level`, `app`, `env`, `message` | yes | Standard log fields. |
| `workflow_name`, `workflow_path` | when in a run | Which workflow emitted the line. |
| `request_id` | when set | Per-request correlation. |
| `run_id` | when in a run | Joins to the Studio run + REST API. |
| `trace_id`, `span_id` | when OTLP tracing is active | Joins to the Tempo trace/span. |

Ship stdout to Loki and the correlation closes the loop both ways: the
provisioned Loki datasource extracts `trace_id` from the JSON and renders a
clickable link to Tempo (`datasources.yml` `derivedFields`); Tempo's
`tracesToLogsV2` links the other direction back to Loki. The simplest shipper
is the Docker Loki log driver — see the commented `blok-http` service in
`infra/metrics/docker-compose.yml`:

```yaml
logging:
  driver: loki
  options:
    loki-url: "http://localhost:3100/loki/api/v1/push"
```

---

## Alerting

The default alert rules live in
[`infra/metrics/rules/blok-alerts.yml`](../infra/metrics/rules/blok-alerts.yml)
(loaded by Prometheus via `rule_files` in `prometheus.yml`, forwarded to
Alertmanager). They turn the metrics above into pages and are intentionally
conservative (sustained-window warnings) so they don't flap — tune the
thresholds and `for:` windows to your SLOs.

| Alert | Severity | Fires when |
|---|---|---|
| `BlokTargetDown` | critical | `up{job=~"blok-.*"} == 0` for 2m — a target stopped being scraped (crash / unreachable). |
| `BlokWorkflowErrorRateHigh` | warning | A workflow's error rate > 5% for 10m. |
| `BlokWorkflowCrashes` | critical | `blok_workflow_errors_total{status="crashed"}` > 0 for 5m — process-level fatal error. |
| `BlokWorkflowTimeouts` | warning | `blok_workflow_errors_total{status="timedOut"}` > 0 for 10m — step `maxDuration` exceeded. |
| `BlokUnhandledRejections` | critical | `blok_unhandled_rejection_total` > 0 for 5m — crash handlers caught a process-level error. |
| `BlokRuntimeNodeErrors` | warning | A cross-language runtime node sustains gRPC failures for 10m. |
| `BlokNodeErrorRateHigh` | warning | A node errors at > 0.1/s for 10m. |
| `BlokWorkflowLatencyHigh` | warning | A workflow's p99 latency > 5s for 10m. |
| `BlokConcurrencyThrottling` | warning | The concurrency gate is denying/queueing runs for 10m. |

> `blok_boot_error_total` is referenced as a future signal in the rules file
> but is **not yet emitted** — there is no boot-error alert today.

### On Kubernetes (Helm)

The chart at `infra/helm/blok/` ships a subset of these rules as a
`PrometheusRule` CRD plus a `ServiceMonitor` (both require the Prometheus
Operator). Both are gated on `monitoring.enabled`:

```yaml
# values.yaml
monitoring:
  enabled: true
  serviceMonitor:
    enabled: true
    interval: 30s
    path: /metrics
  prometheus:
    enabled: true          # adds Prometheus scrape annotations to the Service
  prometheusRule:
    enabled: true          # renders Blok's default alerts as a PrometheusRule
    labels: {}             # match your Prometheus' ruleSelector
    additionalGroups: []   # append your own rule groups
```

The Helm `PrometheusRule` mirrors `blok-alerts.yml`'s core groups
(availability / errors / saturation). Append deployment-specific rules via
`monitoring.prometheusRule.additionalGroups`.

---

## blokctl observability commands

| Command | What it does | Key options |
|---|---|---|
| `blokctl watch` | Streams workflow executions live in the terminal (consumes `/__blok/stream`). | `-u, --url` (default `http://localhost:4000`), `-w, --workflow <names>`, `--verbose`, `--token`, `--no-color` |
| `blokctl monitor` | Opens a metrics dashboard for your workflows, querying Prometheus. | `--web` (browser UI), `--host <prometheus>`, `--token` |
| `blokctl profile [workflow]` | Profiles execution performance from Prometheus (`node_time` / `node_memory` / `node_cpu`) and ranks bottlenecks. | `--duration <s>` (default 30), `--format table\|flamechart\|json`, `--output <file>`, `--host` (default `http://localhost:9090`), `--top <n>` (default 10), `--token` |

`watch` talks to the Blok trace API (`--token` required in production); `monitor`
and `profile` talk to Prometheus.

---

## Environment variable reference

### Metrics

| Variable | Default | Effect |
|---|---|---|
| `BLOK_METRICS_PORT` | `9464` | Port the standalone Prometheus exporter binds (non-HTTP triggers via `PrometheusBootstrap`). |
| `BLOK_METRICS_PER_KEY` | off | `1`/`true` emits the `concurrency_key` label on concurrency metrics (high-cardinality opt-in). |

### Traces

| Variable | Default | Effect |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | OTLP base endpoint; Blok appends `/v1/traces`. Unset → distributed tracing off. |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | unset | Explicit traces endpoint (overrides the base + suffix). |
| `BLOK_TRACE_STORE` | `sqlite` (outside tests) | RunStore backend: `memory` \| `sqlite` \| `postgres`. |
| `BLOK_TRACE_SQLITE_PATH` | `.blok/trace.db` | SQLite file path. |
| `BLOK_TRACE_DATABASE_URL` | unset | PostgreSQL connection string (required for `postgres`). |
| `BLOK_TRACE_PG_POOL_SIZE` | `5` | PostgreSQL pool size. |
| `BLOK_TRACE_PG_SSL` | `false` | `true` enables PostgreSQL SSL. |
| `BLOK_TRACE_RETENTION_DAYS` | `7` | Auto-delete runs older than N days. `0` disables retention. |
| `BLOK_TRACE_ENABLED` | `true` | `false` disables Studio trace recording — and, since they share the store, the idempotency cache too. |

### Background sweep (janitor)

| Variable | Default | Effect |
|---|---|---|
| `BLOK_JANITOR_INTERVAL_MS` | `300000` (5m) | Interval between janitor sweeps. |
| `BLOK_JANITOR_DISABLED` | off | `1` disables the janitor. |
