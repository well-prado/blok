# OBS-01 — Metrics: correctness, naming standard & full coverage

> **Status:** PROPOSED · **Phase:** mixed (wire-what-exists + build-new) · **Effort:** ~5 eng-days · **Depends on:** none (self-contained; OBS-02..OBS-06 may build on the `/metrics` port this epic exposes)

## TL;DR

The framework ships two parallel metric families — a legacy un-prefixed family (`workflow`, `node`, `node_errors`, `node_time`, …) and a canonical `blok_*` family (`blok_workflow_executions_total`, `blok_workflow_duration_seconds`, …) — but the CLIs query only the legacy names, the Grafana dashboards reference only the legacy names, the legacy counters contain a dead `add(0)` call on the error path, and the `bootstrapPrometheus` function that would expose `blok_*` metrics on a scrape endpoint is never called from any trigger's `listen()`. Cross-language runtime nodes (Go, Python, Rust, etc.) are metrically invisible: `GrpcRuntimeAdapter` creates spans but no counters or histograms. Non-HTTP triggers (Worker, Cron, Webhook, MCP, PubSub, WebSocket) expose no `/metrics` endpoint at all. This epic corrects all four problems so that a Prometheus/Grafana scrape of a multi-trigger fintech deployment captures every error class across every node type and trigger kind, queryable and alertable.

## Problem / current state

### A1 — CLI tools query legacy metric family that resolves to nothing

`blokctl monitor` and `blokctl profile` both query Prometheus for un-prefixed metric names. The `blok_*` canonical metrics emitted by `PrometheusMetricsBridge` use completely different names. The legacy family emitted by `TriggerBase` and `BlokService` uses meter name `"default"` and is currently the only data these CLIs ever see — but the two families are not the same, and future work will retire the legacy family. The static HTML dashboard served by `blokctl monitor` also queries only legacy names.

| File | Line(s) | What's there today |
|---|---|---|
| `packages/cli/src/commands/monitor/monitor-component.tsx` | 102–104 | `queryPrometheus("sum(increase(workflow_total[5m]))")` — queries legacy `workflow` counter (registered as counter name `"workflow"`, OTel Prometheus exporter appends `_total`) |
| `packages/cli/src/commands/monitor/monitor-component.tsx` | 103 | `queryPrometheus("sum(increase(workflow_errors_total[5m]))")` — queries `workflow_errors_total` (created at `HttpTrigger.ts:1346` as `"workflow_errors"`) |
| `packages/cli/src/commands/monitor/monitor-component.tsx` | 104 | `queryPrometheus("avg(increase(workflow_time[5m]))")` — queries `workflow_time` gauge; `increase()` on a Gauge is meaningless PromQL |
| `packages/cli/src/commands/monitor/monitor-component.tsx` | 126–128 | Trigger-status panel queries `workflow_total` and `workflow_time` by `workflow_name` label |
| `packages/cli/src/commands/monitor/monitor-component.tsx` | 163–168 | Workflow-detail panel queries `workflow_total`, `workflow_time`, `node_total`, `node_time`, `node_errors_total` — all legacy names |
| `packages/cli/src/commands/monitor/monitor-component.tsx` | 199–203 | Node-detail panel queries `node_total`, `node_time`, `node_errors_total` — legacy |
| `packages/cli/src/commands/monitor/static/index.html` | 1008–1046 | All JS chart queries use `workflow_total`, `workflow_time`, `node_total`, `node_time`, `node_errors_total` |
| `packages/cli/src/commands/profile/index.ts` | 59–65 | Queries `node_time`, `node_total`, `node_memory`, `node_cpu`, `node_errors_total` — all legacy |
| `core/runner/src/monitoring/PrometheusMetricsBridge.ts` | 47–60 | Canonical names: `blok_workflow_executions_total` (Counter), `blok_workflow_duration_seconds` (Histogram), `blok_workflow_errors_total` (Counter) — these are what Grafana/alerting should use |

The canonical histogram `blok_workflow_duration_seconds` supports `histogram_quantile` across replicas. The per-process `blok_trigger_latency_p99_seconds` gauge (PrometheusMetricsBridge lines 97–105) is computed inside a single process from its local ring buffer — averaging gauges across replicas gives a meaningless value. CLIs that switch to the histogram should use `histogram_quantile(0.99, rate(blok_workflow_duration_seconds_bucket[5m]))`.

### A8 — Dead `add(0)` counter and legacy un-prefixed metric family

The error handler in `HttpTrigger` runs `workflow_execution.add(0, ...)` — adding zero to a counter on error, which is a no-op. The real error path is supposed to increment `workflow_runner_errors` at line 1346. Both counters use un-prefixed legacy names registered on meter `"default"` instead of the canonical `blok_*` names on meter `"blok"`.

| File | Line(s) | What's there today |
|---|---|---|
| `triggers/http/src/runner/HttpTrigger.ts` | 1346–1351 | `defaultMeter.createCounter("workflow_errors", ...)` + `defaultMeter.createCounter("workflow", ...)` — un-prefixed, meter `"default"` |
| `triggers/http/src/runner/HttpTrigger.ts` | 1546–1551 | `workflow_execution.add(0, {...})` — dead add-zero on the error path |
| `core/runner/src/TriggerBase.ts` | 1127–1165 | `createCounter("workflow", ...)`, `createGauge("workflow_time", ...)`, `createGauge("workflow_memory", ...)`, `createGauge("workflow_cpu", ...)` — ten legacy gauges + one counter, all un-prefixed on meter `"default"` |
| `core/runner/src/Blok.ts` | 46–82 | `createCounter("node", ...)`, ten `createGauge("node_*", ...)` — legacy, meter `"default"` |
| `core/runner/src/Blok.ts` | 233–243 | `createCounter("node_errors", ...)` — legacy, meter `"default"` |
| `infra/metrics/dashboard.json` | 149, 668, 850, 1033 | Grafana panel expressions: `increase(workflow_total[1m])`, `increase(workflow_time[1m])`, `increase(node_total[1m])`, `increase(node_time[1m])` — legacy names, scaffolded verbatim into every new project |
| `packages/cli/src/commands/create/project.ts` | 641–642 | `fsExtra.copySync(repoSource + "/infra/metrics", dirPath + "/infra/metrics")` — copies the legacy-named dashboard.json into every scaffolded project |

### B3 — gRPC runtime nodes are metrically invisible

`GrpcRuntimeAdapter.execute()` creates an OTEL span but never records any counter or histogram. A Python, Go, Rust, Java, C#, PHP, or Ruby node failure is undetectable in Prometheus — only Studio's RunTracker (SQLite) knows about it.

| File | Line(s) | What's there today |
|---|---|---|
| `core/runner/src/adapters/grpc/GrpcRuntimeAdapter.ts` | 129–191 | `execute()` creates span, records `blok.response.bytes` attribute, catches errors — zero `metrics.getMeter(...)` calls, zero `add()` or `record()` calls |
| `core/runner/src/adapters/grpc/GrpcRuntimeAdapter.ts` | 155–166 | Span attributes include `blok.runtime.kind` and `blok.node.name` but NOT `workflow_name`, `step_id` |
| `core/runner/src/Blok.ts` | 113–127 | In-process node counters `node` / `node_errors` include `node_name` and `workflow_name` labels but NOT `step_id` |

### B6 — Non-HTTP triggers expose no `/metrics` route

`bootstrapPrometheus` (exported from `core/runner/src/monitoring/PrometheusBootstrap.ts`) is a fully-functional function that starts a Prometheus exporter on `BLOK_METRICS_PORT` (default `9464`). It is exported from `@blokjs/runner` (line 259 of `core/runner/src/index.ts`) but is never called from any trigger's `listen()` method.

| File | Line(s) | What's there today |
|---|---|---|
| `core/runner/src/monitoring/PrometheusBootstrap.ts` | 34–92 | `bootstrapPrometheus(config)` — fully implemented, dynamically imports optional OTel SDK packages, starts HTTP server on `BLOK_METRICS_PORT`, returns `{metricsHandler, shutdown}` or `null` if packages absent |
| `triggers/http/src/runner/HttpTrigger.ts` | 696–1000 | `listen()` — no call to `bootstrapPrometheus` |
| `triggers/worker/src/WorkerTrigger.ts` | 261–570 | `listen()` — no call to `bootstrapPrometheus` |
| `triggers/cron/src/CronTrigger.ts` | 141–240 | `listen()` — no call to `bootstrapPrometheus` |
| `triggers/webhook/src/WebhookTrigger.ts` | 156 | `listen()` — no call to `bootstrapPrometheus` |
| `triggers/mcp/src/McpTrigger.ts` | (listen) | `listen()` — no call to `bootstrapPrometheus` |
| `triggers/pubsub/src/PubSubTrigger.ts` | (listen) | `listen()` — no call to `bootstrapPrometheus` |

`HttpTrigger` exposes a `GET /metrics` Hono route only if `bootstrapPrometheus` were called to provide the handler — since it is never called, the route is never registered. Worker, Cron, and all other non-HTTP triggers have no HTTP server at all, so they need the standalone port that `bootstrapPrometheus` opens.

## Goal & acceptance criteria

- **AC-A1a.** `blokctl monitor` displays non-zero workflow request counts and error counts when at least one workflow has executed, querying `blok_workflow_executions_total` and `blok_workflow_errors_total` from Prometheus.
- **AC-A1b.** `blokctl monitor` latency column uses `histogram_quantile(0.99, rate(blok_workflow_duration_seconds_bucket[5m]))` and returns a finite value after workflow execution.
- **AC-A1c.** `blokctl profile` per-node timing data is populated from the new `blok_node_duration_seconds` histogram introduced in B3.
- **AC-A1d.** The static HTML dashboard (`monitor/static/index.html`) renders non-zero charts after workflow execution when pointed at Prometheus with canonical `blok_*` metrics.
- **AC-A8a.** No `add(0, ...)` call exists anywhere in the HTTP trigger or TriggerBase error paths.
- **AC-A8b.** The legacy un-prefixed counter/gauge registrations (`"workflow"`, `"workflow_time"`, `"node"`, `"node_errors"`, etc.) are removed from `TriggerBase.ts` and `Blok.ts` (or aliased to the canonical names). Prometheus scrape contains only `blok_*` names.
- **AC-A8c.** The scaffolded `infra/metrics/dashboard.json` references `blok_workflow_executions_total`, `blok_workflow_duration_seconds`, and `blok_node_duration_seconds` (or is replaced by a dashboard that does). New projects created with `blokctl create` do not inherit the legacy-named Grafana panels.
- **AC-B3a.** A gRPC node execution (any runtime kind) increments `blok_runtime_node_duration_seconds` histogram with labels `{runtime_kind, node_name, workflow_name, step_id}` after execution.
- **AC-B3b.** A gRPC node failure (gRPC error or `success: false` result) increments `blok_runtime_node_errors_total{runtime_kind, node_name, workflow_name, step_id}`.
- **AC-B3c.** A Python node failure (e.g. unhandled exception in the SDK) is visible in `blok_runtime_node_errors_total{runtime_kind="python3"}` within the next Prometheus scrape interval.
- **AC-B3d.** In-process node counters (`blok_node_executions_total`, `blok_node_duration_seconds`) include a `step_id` label.
- **AC-B6a.** An HTTP trigger process exposes `GET /metrics` (or a standalone port `BLOK_METRICS_PORT`) that returns `blok_workflow_executions_total` after at least one workflow execution.
- **AC-B6b.** A Worker trigger process exposes a standalone Prometheus scrape endpoint on `BLOK_METRICS_PORT` (default `9464`) without requiring an HTTP trigger to be co-located.
- **AC-B6c.** A Cron, Webhook, MCP, and PubSub trigger process each expose the same standalone metrics endpoint.
- **AC-B6d.** Setting `BLOK_METRICS_DISABLED=1` suppresses the endpoint and suppresses the dynamic import of OTel SDK packages.

## Design / proposed changes

### T1 — Canonical naming standard (source of truth)

Establish one place that documents all `blok_*` metric names. Add a `METRICS.md` alongside `core/runner/src/monitoring/` (or a doc page in `docs/`) listing every metric, its type, labels, and which code path emits it. The canonical set after this epic:

| Name | Type | Labels | Emitted by |
|---|---|---|---|
| `blok_workflow_executions_total` | Counter | `workflow_name`, `workflow_version`, `status` (`success`\|`error`), `trigger_type`, `env` | `PrometheusMetricsBridge.recordExecution` (TriggerBase) |
| `blok_workflow_duration_seconds` | Histogram | `workflow_name`, `trigger_type`, `env` | `PrometheusMetricsBridge.recordExecution` |
| `blok_workflow_errors_total` | Counter | `error_category`, `trigger_type`, `env` | `PrometheusMetricsBridge.recordError` |
| `blok_node_executions_total` | Counter | `node_name`, `workflow_name`, `workflow_path`, `step_id`, `env` | `BlokService.run` (T3) |
| `blok_node_duration_seconds` | Histogram | `node_name`, `workflow_name`, `workflow_path`, `step_id`, `env` | `BlokService.run` (T3) |
| `blok_node_errors_total` | Counter | `node_name`, `workflow_name`, `workflow_path`, `step_id`, `env` | `BlokService.run` (T3) |
| `blok_runtime_node_duration_seconds` | Histogram | `runtime_kind`, `node_name`, `workflow_name`, `step_id` | `GrpcRuntimeAdapter.execute` (T4) |
| `blok_runtime_node_errors_total` | Counter | `runtime_kind`, `node_name`, `workflow_name`, `step_id` | `GrpcRuntimeAdapter.execute` (T4) |
| `blok_concurrency_acquired_total` | Counter | (existing) | `ConcurrencyMetrics` |
| `blok_concurrency_denied_total` | Counter | (existing) | `ConcurrencyMetrics` |
| `blok_scheduling_dispatch_fired_total` | Counter | (existing) | `ConcurrencyMetrics` |
| `blok_trigger_latency_p99_seconds` | Gauge | `trigger_type`, `trigger_name` | `PrometheusMetricsBridge` observable (per-process — see note) |

**Naming-standard note (p99 trap):** `blok_trigger_latency_p99_seconds` is a per-process gauge computed from the local ring buffer (`TriggerMetricsCollector`). In a multi-replica deployment, Prometheus stores one time-series per replica — `avg()` across them is wrong. Alerting rules must use `histogram_quantile(0.99, sum(rate(blok_workflow_duration_seconds_bucket[5m])) by (le, workflow_name))` instead. Document this prominently in `METRICS.md` and in `PrometheusMetricsBridge.ts`.

### T2 — Wire `bootstrapPrometheus` in all trigger `listen()` methods (B6)

**Change:** In `TriggerBase.ts`, add a protected `startMetricsServer()` method that calls `bootstrapPrometheus(...)` when `BLOK_METRICS_DISABLED` is not set. Call it from `listen()` implementations in HttpTrigger, WorkerTrigger, CronTrigger, WebhookTrigger, McpTrigger, PubSubTrigger, and WebSocketTrigger (each calls `super`-scoped or shared helper).

For HttpTrigger: register the metrics handler as a Hono route `GET /metrics` (or mount on the standalone port, whichever `bootstrapPrometheus` opens — the default opens its own port, which is preferable to avoid auth confusion).

For non-HTTP triggers: the standalone `BLOK_METRICS_PORT` server is exactly what `bootstrapPrometheus` opens. No additional HTTP server is needed.

**New env var:** `BLOK_METRICS_DISABLED=1` — skip `bootstrapPrometheus`. Default: unset (enabled when OTel SDK packages are installed; silently skipped when not).

**Back-compat:** `bootstrapPrometheus` already returns `null` if `@opentelemetry/exporter-prometheus` and `@opentelemetry/sdk-metrics` are not installed (dynamic import, caught silently). No change for projects that don't have those packages.

```typescript
// core/runner/src/TriggerBase.ts — new protected method
protected async startMetricsServer(): Promise<void> {
  if (process.env.BLOK_METRICS_DISABLED === "1") return;
  const result = await bootstrapPrometheus({
    serviceName: this.constructor.name.toLowerCase().replace("trigger", ""),
    port: Number.parseInt(process.env.BLOK_METRICS_PORT || "9464", 10),
  });
  if (result) {
    this.logger.log(`[blok][metrics] Prometheus metrics available on port ${process.env.BLOK_METRICS_PORT || "9464"}/metrics`);
    // store result.shutdown for graceful shutdown
    this._metricsShutdown = result.shutdown;
  }
}
```

Call `this.startMetricsServer()` near the top of each trigger's `listen()` — after `installOperationalHandlers` but before serving traffic.

### T3 — Replace legacy in-process node metrics with canonical `blok_*` names (A8 partial)

**File:** `core/runner/src/Blok.ts`

**Current code:** Ten gauges (`node_time`, `node_memory`, `node_memory_average`, …) + one counter (`node`) created per-invocation on meter `"default"`. Counter `node_errors` created on error path. No `step_id` label.

**New behavior:** Replace with two instruments created once as class-level singletons on meter `"blok"`:

```typescript
// As static class members on BlokService (lazy-init once)
private static readonly nodeExecCounter = metrics.getMeter("blok")
  .createCounter("blok_node_executions_total", { description: "Total in-process node executions", unit: "1" });
private static readonly nodeDurationHistogram = metrics.getMeter("blok")
  .createHistogram("blok_node_duration_seconds", { description: "In-process node execution duration", unit: "s" });
private static readonly nodeErrorCounter = metrics.getMeter("blok")
  .createCounter("blok_node_errors_total", { description: "In-process node errors", unit: "1" });
```

Labels to include: `node_name`, `workflow_name`, `workflow_path`, `step_id`, `env`. The `step_id` is available as `this.name` inside `BlokService.run()` (the step's `id` field flows through as the node service name in v2 workflows). Confirm and document.

Remove the ten legacy `node_*` gauges and the `node` counter. The memory/CPU gauges were never consumed by anything useful (per-step Gauge on meter `"default"` with no exporter is lost).

### T4 — Add OTel counters/histogram to `GrpcRuntimeAdapter` (B3)

**File:** `core/runner/src/adapters/grpc/GrpcRuntimeAdapter.ts`

**Current code:** `execute()` creates a span with attributes `blok.runtime.kind`, `blok.node.name` but no metrics calls. `workflow_name` is not set on the span attributes.

**New behavior:** Add two singleton instruments to the class:

```typescript
private static readonly runtimeDurationHistogram = metrics.getMeter("blok")
  .createHistogram("blok_runtime_node_duration_seconds", {
    description: "gRPC runtime node execution duration",
    unit: "s",
  });
private static readonly runtimeErrorCounter = metrics.getMeter("blok")
  .createCounter("blok_runtime_node_errors_total", {
    description: "gRPC runtime node errors",
    unit: "1",
  });
```

Record in `execute()` after the try/catch:

```typescript
const durationS = (performance.now() - startTime) / 1000;
const labels = {
  runtime_kind: this.kind,
  node_name: node.name,
  workflow_name: ctx.workflow_name ?? "",
  step_id: (ctx as Record<string,unknown>)._stepInfo ? node.name : "",
};
GrpcRuntimeAdapter.runtimeDurationHistogram.record(durationS, labels);
if (!result.success) {
  GrpcRuntimeAdapter.runtimeErrorCounter.add(1, labels);
}
```

Also add `workflow_name` as a span attribute so traces and metrics share the same label for joins:

```typescript
span.setAttribute("blok.workflow.name", ctx.workflow_name ?? "");
span.setAttribute("blok.step.id", node.name);
```

The streaming path (`executeStream`) receives the same treatment in the inner `try/catch` around the stream-close event.

### T5 — Kill dead `add(0)` and retire legacy workflow metrics from `TriggerBase` and `HttpTrigger` (A8)

**Files:** `core/runner/src/TriggerBase.ts`, `triggers/http/src/runner/HttpTrigger.ts`

**TriggerBase.ts changes:**
- Remove lines 1127–1165 (ten `createGauge`/`createCounter` calls for `workflow`, `workflow_time`, `workflow_memory`, `workflow_cpu`, etc.).
- Remove the corresponding `.record(...)` and `.add(...)` calls. `PrometheusMetricsBridge.recordExecution()` (already called at line 1397) is the correct, canonical replacement.

**HttpTrigger.ts changes:**
- Remove lines 1346–1351 (`createCounter("workflow_errors", ...)` + `createCounter("workflow", ...)`).
- Remove lines 1546–1551 — the dead `workflow_execution.add(0, {...})` on the error path.
- The `metricsBridge.recordError(...)` call (inherited from `TriggerBase`) is the correct replacement for error tracking.

**Back-compat warning (release note):** Any custom Grafana alert or dashboard that queries `workflow_total`, `workflow_time`, `workflow_errors_total`, `node_total`, `node_time`, or `node_errors_total` will go dark after this change. Operators must migrate to `blok_workflow_executions_total` / `blok_workflow_duration_seconds` / `blok_node_executions_total` / `blok_node_duration_seconds`. Provide a migration note in the changelog.

### T6 — Fix CLI monitor and profile to query canonical names (A1)

**Files:** `packages/cli/src/commands/monitor/monitor-component.tsx`, `packages/cli/src/commands/monitor/static/index.html`, `packages/cli/src/commands/profile/index.ts`

**monitor-component.tsx changes:**

Replace every legacy PromQL expression:

| Old expression | New expression |
|---|---|
| `sum(increase(workflow_total[5m]))` | `sum(increase(blok_workflow_executions_total[5m]))` |
| `sum(increase(workflow_errors_total[5m]))` | `sum(increase(blok_workflow_errors_total[5m]))` |
| `avg(increase(workflow_time[5m]))` | `histogram_quantile(0.99, sum(rate(blok_workflow_duration_seconds_bucket[5m])) by (le))` |
| `sum(increase(workflow_total[1m])) by (workflow_path)` | `sum(increase(blok_workflow_executions_total[1m])) by (workflow_name)` |
| `sum(increase(workflow_time[1m])) by (workflow_path)` | `histogram_quantile(0.99, sum(rate(blok_workflow_duration_seconds_bucket[1m])) by (le, workflow_name))` |
| `sum(increase(node_total[1m])) by (node_name, workflow_path)` | `sum(increase(blok_node_executions_total[1m])) by (node_name, workflow_name)` |
| `sum(increase(node_time[1m])) by (node_name, workflow_path)` | `histogram_quantile(0.99, sum(rate(blok_node_duration_seconds_bucket[1m])) by (le, node_name, workflow_name))` |
| `sum(increase(node_errors_total[1m])) by (node_name, workflow_path)` | `sum(increase(blok_node_errors_total[1m])) by (node_name, workflow_name)` |

Note: label `workflow_path` becomes `workflow_name` to match `PrometheusMetricsBridge` label name. If both are needed, add `workflow_path` as a secondary label in T3.

**static/index.html changes:** Mirror the same expression substitutions in the JS `queries` object (lines 1008–1046 and 1508–1618). Update chart titles and tooltip labels to say "executions" rather than "total".

**profile/index.ts changes:** Replace `node_time` / `node_total` / `node_memory` / `node_cpu` / `node_errors_total` with `blok_node_duration_seconds` / `blok_node_executions_total` / `blok_node_errors_total`. Drop queries for memory/cpu gauges (no canonical replacement — those gauges are removed in T3). Update the `profiler.addSample()` call to read `blok_node_duration_seconds` histogram sum/count.

### T7 — Replace scaffolded Grafana dashboard with canonical-named version (A8)

**File:** `infra/metrics/dashboard.json`

Replace the four panel expressions that reference `workflow_total`, `workflow_time`, `node_total`, `node_time` with canonical equivalents (`blok_workflow_executions_total`, `blok_workflow_duration_seconds` histogram quantiles, `blok_node_executions_total`, `blok_node_duration_seconds`).

Add a new panel for runtime node errors: `sum(increase(blok_runtime_node_errors_total[1m])) by (runtime_kind, node_name)`.

The existing dashboards under `infra/metrics/dashboards/` (`blok-overview.json`, `blok-triggers.json`, etc.) should be audited for the same legacy name references; update those as well.

Since `packages/cli/src/commands/create/project.ts` copies `infra/metrics` verbatim (lines 641–642), updating `dashboard.json` automatically fixes every new project scaffolded after this change. Existing projects need a manual migration step (document in changelog).

## Tasks (SDD breakdown)

**T1. Establish canonical metric naming document**
- Files: `core/runner/src/monitoring/METRICS.md` (new), `core/runner/src/monitoring/PrometheusMetricsBridge.ts` (add doc comment about p99 trap)
- Change: create METRICS.md listing every `blok_*` metric, its type, labels, emitter, and the per-process p99 gauge warning. Add a JSDoc block to `blok_trigger_latency_p99_seconds` calling out the multi-replica averaging trap.
- Acceptance: `METRICS.md` exists; code reviewers can reference a single source of truth for naming decisions.
- Effort: 0.25 eng-days

**T2. Wire `bootstrapPrometheus` in all trigger `listen()` methods**
- Files: `core/runner/src/TriggerBase.ts` (add `startMetricsServer()` + `_metricsShutdown` field + hook into `destroy()`), `triggers/http/src/runner/HttpTrigger.ts`, `triggers/worker/src/WorkerTrigger.ts`, `triggers/cron/src/CronTrigger.ts`, `triggers/webhook/src/WebhookTrigger.ts`, `triggers/mcp/src/McpTrigger.ts`, `triggers/pubsub/src/PubSubTrigger.ts`
- Change: Add `protected async startMetricsServer(): Promise<void>` to `TriggerBase`. Call it at the start of each trigger's `listen()`. Hook `this._metricsShutdown?.()` into the existing graceful-shutdown sequence in `TriggerBase.destroy()` / `installShutdownHandlers`.
- Env var: `BLOK_METRICS_DISABLED=1` (default: unset = enabled when OTel packages present). Port: `BLOK_METRICS_PORT` (default `9464`, already read by `PrometheusBootstrap`).
- Acceptance: `curl localhost:9464/metrics` after `listen()` returns MIME type `text/plain; version=0.0.4` containing `blok_workflow_executions_total`.
- Effort: 0.75 eng-days

**T3. Replace legacy in-process node metrics with `blok_node_*` (A8 partial + B3 partial)**
- Files: `core/runner/src/Blok.ts`
- Change: Replace ten per-invocation `createGauge`/`createCounter` calls (lines 46–82, 233–243) with three static singleton instruments: `blok_node_executions_total` (Counter), `blok_node_duration_seconds` (Histogram), `blok_node_errors_total` (Counter). Add `step_id` label (= `this.name`). Remove all legacy gauge `.record()` calls.
- Acceptance: After a workflow execution, `blok_node_executions_total{node_name="my-node",step_id="step-1"}` appears in `/metrics`; legacy `node_total` does not.
- Effort: 0.5 eng-days

**T4. Add `blok_runtime_node_*` metrics to `GrpcRuntimeAdapter` (B3)**
- Files: `core/runner/src/adapters/grpc/GrpcRuntimeAdapter.ts`
- Change: Add two static singleton instruments (`blok_runtime_node_duration_seconds` Histogram, `blok_runtime_node_errors_total` Counter). Record them after every `execute()` call with labels `{runtime_kind, node_name, workflow_name, step_id}`. Add `blok.workflow.name` and `blok.step.id` as span attributes. Apply same treatment to `executeStream()`.
- Acceptance: Calling a Python3 node and having it error increments `blok_runtime_node_errors_total{runtime_kind="python3"}` visible in the next Prometheus scrape. A successful call records a non-zero sample in `blok_runtime_node_duration_seconds`.
- Effort: 0.75 eng-days

**T5. Kill dead `add(0)` and remove legacy workflow metrics from `TriggerBase` and `HttpTrigger` (A8)**
- Files: `core/runner/src/TriggerBase.ts` (remove lines 1127–1165 + matching record calls), `triggers/http/src/runner/HttpTrigger.ts` (remove lines 1346–1351 + dead `add(0)` at line 1546)
- Change: Delete legacy `workflow`, `workflow_time`, `workflow_memory`, `workflow_cpu`, `workflow_errors` instruments and their record/add calls. Verify `metricsBridge.recordExecution()` (line 1397 in TriggerBase) covers the happy path and `metricsBridge.recordError()` covers the error path — no net loss of coverage.
- Acceptance: `grep -r '"workflow"' core/runner/src triggers/http/src | grep createCounter` returns zero hits. `grep 'add(0' triggers/http/src` returns zero hits.
- Effort: 0.5 eng-days

**T6. Fix CLI monitor and profile to query canonical metric names (A1)**
- Files: `packages/cli/src/commands/monitor/monitor-component.tsx`, `packages/cli/src/commands/monitor/static/index.html`, `packages/cli/src/commands/profile/index.ts`
- Change: Replace all legacy PromQL expressions (see Design section T6 table). Switch latency queries to `histogram_quantile(0.99, ...)` over `blok_workflow_duration_seconds`. Remove profile queries for `node_memory` / `node_cpu` gauges (no canonical replacement). Update label references from `workflow_path` to `workflow_name` where needed.
- Acceptance: `blokctl monitor --host http://localhost:9090` shows non-zero request counts after executing a workflow. `blokctl profile` shows per-node timing. `grep -n "workflow_total\|node_total\|workflow_time\|node_time" packages/cli/src/commands/monitor/monitor-component.tsx packages/cli/src/commands/profile/index.ts` returns zero hits.
- Effort: 1.0 eng-day

**T7. Replace scaffolded Grafana dashboard with canonical-named version (A8)**
- Files: `infra/metrics/dashboard.json`, `infra/metrics/dashboards/blok-overview.json`, `infra/metrics/dashboards/blok-triggers.json`, `infra/metrics/dashboards/blok-system.json`, `infra/metrics/dashboards/blok-tracing.json`
- Change: Replace panel expressions referencing `workflow_total`, `workflow_time`, `node_total`, `node_time` with `blok_*` canonical names. Add a panel for `blok_runtime_node_errors_total` broken down by `runtime_kind`. Update variable templates if they reference metric names.
- Acceptance: Importing updated `dashboard.json` into Grafana with a working Prometheus datasource shows non-empty panels after workflow execution. No legacy metric names remain in any panel expression.
- Effort: 0.5 eng-days

**Dependency order:** T1 → T3 → T4 → T5 → T2 → T6 → T7. T3/T4/T5 must land before T2 (the metrics server is only useful when there are canonical metrics to scrape). T6 and T7 depend on T3/T4 for the node-level metrics to exist. T1 is informational and can land any time.

## Tests

### Unit tests

**`core/runner/src/__tests__/unit/Blok.metrics.test.ts`** (new)
- Assert `blok_node_executions_total` increments by 1 after a successful `BlokService.run()` call with a mock ctx.
- Assert `blok_node_errors_total` increments when `response.success === false`.
- Assert `blok_node_duration_seconds` records a positive value.
- Assert no legacy `"node"` counter is registered (`getMeter("default")` mock returns no matching instrument).
- Assert `step_id` label equals `this.name` on the emitted attributes.

**`core/runner/src/adapters/grpc/__tests__/GrpcRuntimeAdapter.metrics.test.ts`** (new)
- Mock `unaryExecute` to return a success response; assert `blok_runtime_node_duration_seconds` records a sample with `{runtime_kind: "python3", node_name: "my-node"}`.
- Mock `unaryExecute` to throw a gRPC error; assert `blok_runtime_node_errors_total` increments with the correct labels.
- Assert the span carries `blok.workflow.name` attribute.

**`core/runner/src/monitoring/__tests__/TriggerBase.metrics.test.ts`** (extend existing)
- Assert that `TriggerBase.run()` does NOT call any legacy `createCounter("workflow", ...)` or `createGauge("workflow_time", ...)`.
- Assert `metricsBridge.recordExecution` is called with `durationMs > 0` on both success and error paths.

**`packages/cli/src/__tests__/unit/monitor-component.test.ts`** (new or extend)
- Mock `queryPrometheus` and assert that `fetchPrometheusMetrics` calls include `blok_workflow_executions_total` and NOT `workflow_total`.
- Assert `fetchSystemMetrics` requests include `blok_workflow_executions_total`.

**`packages/cli/src/__tests__/unit/profile.test.ts`** (new)
- Mock `queryPrometheus`; assert the profile command queries `blok_node_duration_seconds` and not `node_time`.

### Integration / smoke tests

**`core/runner/src/__tests__/integration/PrometheusBootstrap.integration.test.ts`** (new or extend existing)
- Boot a minimal `HttpTrigger` with the real `startMetricsServer()` wired in.
- Execute one workflow.
- `GET http://localhost:9464/metrics` — assert response body contains `blok_workflow_executions_total` with value `1`.
- Shut down; assert no port leak.

**`core/runner/src/__tests__/integration/GrpcRuntime.metrics.integration.test.ts`** (new)
- Requires `@opentelemetry/sdk-metrics` installed.
- Stand up a real (or mock) gRPC runtime stub that returns an error.
- Assert `blok_runtime_node_errors_total{runtime_kind="go"}` is non-zero after the call.

### End-to-end verification

1. Start a full dev stack: `blokctl dev` (spawns HTTP trigger + runner).
2. Execute a workflow via `curl`.
3. `curl localhost:9464/metrics | grep blok_workflow_executions_total` — must return a non-zero counter.
4. `blokctl monitor --host http://localhost:9090` — must show non-zero Requests column.
5. `blokctl profile --host http://localhost:9090` — must show per-node timing rows.
6. In Grafana (if configured), import updated `dashboard.json` — all panels must show data.

## Back-compat, kill-switches & defaults

| Env var | Default | Effect |
|---|---|---|
| `BLOK_METRICS_DISABLED` | unset (enabled) | Set to `1` to skip `bootstrapPrometheus` entirely; suppresses dynamic import of OTel SDK |
| `BLOK_METRICS_PORT` | `9464` | Port for the standalone Prometheus scrape server (already read by `PrometheusBootstrap`) |

**BREAKING default change (release-note material):** Removal of the legacy un-prefixed metric family (`workflow`, `workflow_time`, `node`, `node_errors`, etc.) is a breaking change for any operator who has custom Grafana panels, alerting rules, or recording rules querying those names. Minimum notice: one minor version with a deprecation warning (log at trigger startup if `BLOK_METRICS_LEGACY=1` is set to re-emit the legacy names as aliases). Recommend publishing a migration guide alongside the v0.7.x changelog.

**Legacy alias escape hatch:** Optionally add `BLOK_METRICS_LEGACY=1` — when set, `TriggerBase` re-registers the old counter/gauge names as aliases that forward to the canonical instruments. Allows operators a one-release migration window without a data gap. This is optional — only implement if the release cadence warrants it.

**No schema migration:** This epic touches only OTel metric instrumentation and CLI query strings. No SQLite/Postgres migrations, no wire-format changes, no workflow schema changes.

**`bootstrapPrometheus` graceful degradation:** If `@opentelemetry/exporter-prometheus` is not installed, `bootstrapPrometheus` returns `null` silently (current behavior, unchanged). Triggers that call `startMetricsServer()` log nothing and proceed normally. Zero-cost for projects without the optional OTel packages.

## Risks & open questions

1. **Instrument singleton vs. per-invocation:** T3 proposes moving `createCounter/createHistogram` from per-invocation (inside `BlokService.run()`) to static class-level singletons. OTel's `getMeter().createCounter()` is idempotent when called with the same name — it returns the same instrument — so the current per-invocation pattern is not buggy, but it is wasteful (re-resolves the meter and instrument on every node execution). Static class-level is the correct pattern. Confirm no test infrastructure mocks `metrics.getMeter()` at call-site granularity and breaks.

2. **`step_id` availability in `BlokService`:** The `step_id` proposed for node-level metrics uses `this.name` (the `BlokService` subclass's `name` field). In v2 workflows, `this.name` is the step's `id`; in v1 workflows it may be the `name` key from the `nodes{}` map, which could differ. Verify that `this.name` in `BlokService.run()` reliably identifies the step, not just the node type.

3. **`workflow_name` in `GrpcRuntimeAdapter`:** `ctx.workflow_name` must be populated by the time `GrpcRuntimeAdapter.execute()` is called. Confirm `TriggerBase.createContext()` populates `ctx.workflow_name` before the step loop starts. If not, `GrpcRuntimeAdapter` will label all its metrics with an empty string.

4. **Port collision in multi-trigger deployments:** If an operator co-locates HttpTrigger and WorkerTrigger in the same process (unusual but possible), both call `startMetricsServer()`. `bootstrapPrometheus` has an `initialized` guard that returns `null` on the second call — so no collision, but only one trigger's `serviceName` wins. Document this.

5. **Legacy alias complexity:** If `BLOK_METRICS_LEGACY=1` is implemented, test that the alias instruments don't cause duplicate-series cardinality explosions in Prometheus. OTel's Prometheus exporter deduplicates by metric name, not by instrument identity.

6. **Open question:** Should `blok_workflow_duration_seconds` buckets be configurable? The OTel SDK uses default exponential buckets unless configured. For a fintech platform, explicit buckets in the `[0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, +Inf]` range may be preferable. Revisit when Prometheus alerting rules are defined (OBS-02 or OBS-05).

## Out of scope / follow-ups

- **Distributed tracing (OBS-02):** `bootstrapTracing` is also never called (zero call sites found). Wiring OTLP tracing export is a separate epic — this epic only covers the Prometheus metrics plane.
- **Log shipping to Loki:** Stdout logs never reach Loki (no shipper, `CONSOLE_LOG_ACTIVE=false` in prod). Out of scope here.
- **`blok_trigger_latency_p99_seconds` per-replica alert rule:** The correct multi-replica alerting PromQL is `histogram_quantile(0.99, ...)` over `blok_workflow_duration_seconds`. Writing the actual Prometheus alerting rule and PrometheusRule CRD is OBS-05 scope.
- **OTel metrics for the Janitor and DeferredRunScheduler:** `JanitorMetrics` and `ConcurrencyMetrics` already emit canonical `blok_*` names. No changes needed here.
- **Memory/CPU gauges (legacy `workflow_memory`, `node_cpu`, etc.):** These are dropped in T3/T5 with no canonical replacement. If per-node memory/CPU tracking is desired, it belongs in a new telemetry epic using OTel's process metrics SDK, not per-invocation gauges.
- **Studio tile for runtime node errors:** A `RuntimeNodeErrorTile` in Blok Studio (reading from SQLite RunTracker, not Prometheus) is a UX follow-up and out of scope for this metrics-plane epic.
