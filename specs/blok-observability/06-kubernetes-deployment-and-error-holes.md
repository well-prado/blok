# OBS-06 — Kubernetes deployment, scrape wiring & closing the error holes

> **Status:** PROPOSED · **Phase:** mixed (wire-what-exists + build-new) · **Effort:** 9.5 eng-days · **Depends on:** OBS-01 (blok_runtime_node_errors_total + /metrics on non-HTTP triggers), OBS-05 (alerting rules)

## TL;DR

Three distinct failure classes block 100% error observability on a multi-replica Kubernetes deployment. First, the Helm chart's ServiceMonitor is silently inert on every production install: the canonical multi-region override file puts the `serviceMonitor:` key at the wrong YAML nesting level (top-level instead of under `monitoring:`), and both the `monitoring.enabled` and `monitoring.serviceMonitor.enabled` defaults are `false`, meaning vanilla `helm install` emits zero Prometheus integration. Second, the Helm chart ships no Grafana/Loki/Tempo/Prometheus sub-chart dependencies, and the four existing dashboard JSON files live only in the Docker Compose dev-metrics stack with no path to the cluster. Third, three invisible failure categories produce no run record at all: `unhandledRejection` is caught and silently absorbed (no metric, no run record for the rejection itself); errors thrown before `tracker.startRun()` (workflow parse, `assertNoSetVar`, `Configuration.init`, middleware-not-found) produce no record; and OOM/SIGKILL deaths are handled by orphan-recovery but without any metric or structured log. This epic fixes the Helm wiring, specifies the Grafana/Loki/Tempo integration path with ConfigMap-mounted dashboards, adds a new blok-errors dashboard, and closes the invisible-failure gaps.

## Problem / current state

### A7 — k8s scraping

| File | Line(s) | What's there today |
|------|---------|-------------------|
| `infra/helm/blok/values.yaml` | 168–180 | `monitoring.enabled: false`, `monitoring.serviceMonitor.enabled: false` — both guards default false; vanilla `helm install` emits no Prometheus integration at all |
| `infra/helm/blok/templates/servicemonitor.yaml` | 1 | Template guard: `{{- if and .Values.monitoring.enabled .Values.monitoring.serviceMonitor.enabled -}}` — requires BOTH to be true; every field inside reads `.Values.monitoring.serviceMonitor.*` |
| `infra/helm/blok/values-multiregion.yaml` | 137–144 | `serviceMonitor:` key is top-level, NOT nested under `monitoring:`, so the template guard reads `.Values.monitoring.serviceMonitor.enabled` which is `false` (from `values.yaml` default) — the multi-region override is silently ignored |
| `infra/helm/blok/templates/servicemonitor.yaml` | 12–13 | Only creates a `ServiceMonitor` targeting `port: http` — no `PodMonitor`, so non-HTTP trigger pods (worker, cron, websocket, etc.) that expose metrics on `BLOK_METRICS_PORT` (9464) are never scraped |
| `infra/helm/blok/templates/deployment.yaml` | 21–25 | `prometheus.io/scrape: "true"` annotation only emitted when `monitoring.prometheus.enabled: false` (another default-off guard); Prometheus annotation-based scrape is also not wired when ServiceMonitor path is taken |
| `infra/metrics/prometheus.yml` | 10–12 | `cadvisor` job is listed as `static_configs: targets: ["cadvisor:8080"]` (Docker Compose only, no k8s equivalent) — no cAdvisor/kubelet scrape configured for the Helm path |
| `infra/helm/blok/Chart.yaml` | 1–14 | `dependencies: []` — no `kube-prometheus-stack`, Grafana, Loki, or Tempo sub-chart; no operator-ready dashboard delivery mechanism |
| `infra/metrics/dashboards/` | (all four files) | Grafana dashboards only consumed by `infra/metrics/docker-compose.yml` volume-mount — no ConfigMap, no Grafana dashboard sidecar provisioning in the Helm chart |

### Backend on k8s

The four existing dashboard JSON files (`blok-overview.json`, `blok-system.json`, `blok-tracing.json`, `blok-triggers.json`) reference metrics such as `blok_workflow_errors_total`, `blok_trigger_latency_p50_seconds`, and `blok_workflow_executions_total` that are real (defined in `core/runner/src/monitoring/PrometheusMetricsBridge.ts:47,52,57`) and exported at `/metrics` on the HTTP trigger (wired in `triggers/http/src/runner/HttpTrigger.ts:804` via `metricsHandler` from `triggers/http/src/runner/metrics/opentelemetry_metrics.ts`). However, these dashboards are unreachable in any k8s install: there is no Grafana provisioning ConfigMap in the Helm chart, and the chart has no sub-chart dependency on `kube-prometheus-stack` or a standalone Grafana release. There is also no `blok-errors` dashboard.

### B7 — truly-invisible failures

| File | Line(s) | What's there today |
|------|---------|-------------------|
| `core/runner/src/TriggerBase.ts` | 325–337 | `onRejection` handler: flips in-flight runs to `crashed`, then adds a `console.error` log. No OTel counter (`blok_unhandled_rejection_total`) is incremented. The `reason` (root cause) is captured in the `logger?.error?.(...)` call but is lost if `CONSOLE_LOG_ACTIVE=false` (the production default in `values-multiregion.yaml:152`). No synthetic run record is created for the rejection itself — only any runs that happened to be in-flight at the moment are flipped. A pure background `Promise` rejection (e.g. from a Janitor sweep or NATS reconnect) that has no in-flight run produces zero observable signal. |
| `core/runner/src/TriggerBase.ts` | 308–323 | `onUncaught` handler: same as above — flips runs, logs, re-throws. No OTel counter. |
| `triggers/http/src/runner/HttpTrigger.ts` | 1419–1424 | `Configuration.init()` is called BEFORE `tracker.startRun()` (which lives inside `TriggerBase.run()` at line ~900). An exception thrown by `init()` (workflow YAML parse error, `assertNoSetVar` enforcement, missing node type) propagates to the outer Hono catch and produces an HTTP error response, but **no run record** ever gets created. |
| `triggers/http/src/runner/HttpTrigger.ts` | 1501 | `this.applyMiddlewareChain(ctx, this.nodeMap)` is also called BEFORE `this.run(ctx)` (line 1503). A middleware-not-found throw here similarly lands before `startRun` has been called, leaving no run record. |
| `infra/metrics/prometheus.yml` | 10–12 | `cadvisor` job is present in the Docker Compose config only. In the Helm path, cAdvisor is not a scrape target, so OOM kills and SIGKILL events (cgroup memory.stat, container_oom_events_total) are never visible. |
| `core/runner/src/tracing/Janitor.ts` | (entire file) | Janitor sweep errors are swallowed: `JanitorMetrics.recordSweep` (in `core/runner/src/monitoring/JanitorMetrics.ts:49`) records duration and row counts but has no error counter. A Janitor sweep that throws (e.g. locked SQLite) increments nothing. |

## Goal & acceptance criteria

1. `helm install blok ./infra/helm/blok` with `monitoring.enabled=true` creates a working ServiceMonitor that Prometheus (via kube-prometheus-stack) can discover and scrape.
2. `helm install blok ./infra/helm/blok -f values-multiregion.yaml` with `monitoring.enabled=true` correctly enables the ServiceMonitor (the YAML nesting bug is fixed).
3. A `PodMonitor` is created alongside the `ServiceMonitor` so individual pod `/metrics` endpoints are scraped (required for non-HTTP trigger pods once OBS-01 B6 ships their `/metrics` port).
4. Applying the Helm chart with `monitoring.grafanaDashboards.enabled=true` creates four `ConfigMap` objects that a Grafana sidecar provisioner (e.g. `grafana-sidecar` in kube-prometheus-stack) picks up and loads into Grafana dashboards.
5. A fifth ConfigMap ships the new `blok-errors.json` dashboard driven by `blok_workflow_errors_total`, `blok_concurrency_denied_total`, crash/timeout/timedOut run counts, and `blok_unhandled_rejection_total`.
6. An operator can deploy a full Grafana + Prometheus + Loki + Tempo stack in k8s by following documented steps that reference the kube-prometheus-stack Helm chart — the chart's `README` or `NOTES.txt` explains the integration, and the Blok Helm chart ships values examples for the integration.
7. `blok_unhandled_rejection_total{trigger_type,reason_class}` counter increments for every `unhandledRejection` event — verifiable by running a workflow that causes an unhandled rejection in a background Promise and querying Prometheus.
8. A pre-`startRun` boot/config-failure metric `blok_boot_error_total{trigger_type,error_class}` increments for every `Configuration.init` parse error, `assertNoSetVar` throw, or middleware-not-found error — verifiable by submitting a request for a non-existent workflow and querying Prometheus.
9. When a pre-`startRun` error occurs AND the tracker is active, a synthetic run record with status `"failed"` is created with `workflowName` set to the attempted workflow name (or `"unknown"` if parse failed before the name was resolved), so the failure is visible in Blok Studio.
10. cAdvisor scrape instructions and/or a PodMonitor that sources `container_oom_events_total` from kubelet/cAdvisor are documented in the chart's values or NOTES as part of the Helm install guide for OOM visibility.
11. Janitor sweep errors increment `blok_janitor_sweep_errors_total{table}` — verifiable by injecting a store error and querying Prometheus.
12. `CONSOLE_LOG_ACTIVE=false` does NOT suppress the crash-handler log output to structured logging — the root cause of every `unhandledRejection` is written to `stderr` unconditionally via `process.stderr.write`.

## Design / proposed changes

### A7-1 — Fix the `values-multiregion.yaml` nesting bug

**File:** `infra/helm/blok/values-multiregion.yaml`, line 137–144.

Current (broken):
```yaml
# ─── Monitoring ───────────────────────────────────────────────────────────────
serviceMonitor:
  enabled: true
  interval: 15s
  scrapeTimeout: 10s
  path: /metrics
  labels:
    release: prometheus
```

Correct (fix nesting):
```yaml
# ─── Monitoring ───────────────────────────────────────────────────────────────
monitoring:
  enabled: true
  serviceMonitor:
    enabled: true
    interval: 15s
    scrapeTimeout: 10s
    path: /metrics
    labels:
      release: prometheus
  prometheus:
    enabled: true
```

The template guard `{{- if and .Values.monitoring.enabled .Values.monitoring.serviceMonitor.enabled -}}` in `templates/servicemonitor.yaml:1` then evaluates correctly. The `scrapeTimeout` field is new (no `scrapeTimeout` in the base `values.yaml`) — add it there too with default `10s`.

### A7-2 — Reconsider defaults and add scrapeTimeout to base values

**File:** `infra/helm/blok/values.yaml`, lines 167–181.

Change `monitoring.enabled` default from `false` to `false` (keep it off for truly-vanilla installs that have no Prometheus operator), but add `monitoring.serviceMonitor.scrapeTimeout: 10s` and a comment explaining what a consumer needs: the Prometheus Operator (kube-prometheus-stack). Also add a `monitoring.serviceMonitor.labels` map (empty by default) so operators can set the `release: prometheus` label required by kube-prometheus-stack's ServiceMonitor selector.

New default block:
```yaml
monitoring:
  enabled: false
  serviceMonitor:
    enabled: false
    interval: 30s
    scrapeTimeout: 10s
    path: /metrics
    labels: {}
    # labels:
    #   release: prometheus   # required by kube-prometheus-stack
  prometheus:
    enabled: false
  grafanaDashboards:
    enabled: false
    label: grafana_dashboard
    labelValue: "1"
    namespace: ""   # empty = same namespace as release
```

### A7-3 — Add PodMonitor template

**New file:** `infra/helm/blok/templates/podmonitor.yaml`

A `PodMonitor` scrapes individual pod metrics endpoints directly, bypassing the Service load-balancer. Required for non-HTTP trigger pods that will expose `/metrics` on `BLOK_METRICS_PORT` (default 9464) after OBS-01 B6 ships.

```yaml
{{- if and .Values.monitoring.enabled .Values.monitoring.podMonitor.enabled -}}
apiVersion: monitoring.coreos.com/v1
kind: PodMonitor
metadata:
  name: {{ include "blok.fullname" . }}
  labels:
    {{- include "blok.labels" . | nindent 4 }}
    {{- with .Values.monitoring.serviceMonitor.labels }}
    {{- toYaml . | nindent 4 }}
    {{- end }}
spec:
  selector:
    matchLabels:
      {{- include "blok.selectorLabels" . | nindent 6 }}
  podMetricsEndpoints:
    - port: http
      path: {{ .Values.monitoring.serviceMonitor.path }}
      interval: {{ .Values.monitoring.serviceMonitor.interval }}
      scrapeTimeout: {{ .Values.monitoring.serviceMonitor.scrapeTimeout }}
    - port: metrics
      path: /metrics
      interval: {{ .Values.monitoring.serviceMonitor.interval }}
      scrapeTimeout: {{ .Values.monitoring.serviceMonitor.scrapeTimeout }}
  namespaceSelector:
    matchNames:
      - {{ .Release.Namespace }}
{{- end }}
```

Add to `values.yaml`:
```yaml
  podMonitor:
    enabled: false
```

Add `metrics` named port to `templates/deployment.yaml` when `monitoring.enabled`:
```yaml
{{- if .Values.monitoring.enabled }}
- name: metrics
  containerPort: 9464
  protocol: TCP
{{- end }}
```

### A7-4 — cAdvisor / kubelet scraping documentation

Blok does not need to ship cAdvisor itself — kube-prometheus-stack includes it. The missing piece is documentation. Add to `infra/helm/blok/templates/NOTES.txt`:

```
For OOM/SIGKILL visibility, ensure kube-prometheus-stack is installed with
  kubelet.enabled=true and kubeStateMetrics.enabled=true.
Query: container_oom_events_total{namespace="{{ .Release.Namespace }}"}
```

### A7-5 — Grafana dashboard ConfigMaps

**New file:** `infra/helm/blok/templates/dashboards.yaml`

When `monitoring.grafanaDashboards.enabled=true`, emit one ConfigMap per dashboard JSON file. Grafana's sidecar provisioner (configured in kube-prometheus-stack's Grafana values via `sidecar.dashboards.enabled=true` and `sidecar.dashboards.label=grafana_dashboard`) will pick them up.

```yaml
{{- if and .Values.monitoring.enabled .Values.monitoring.grafanaDashboards.enabled }}
{{- $files := .Files }}
{{- range $name, $path := dict "blok-overview" "dashboards/blok-overview.json" "blok-system" "dashboards/blok-system.json" "blok-tracing" "dashboards/blok-tracing.json" "blok-triggers" "dashboards/blok-triggers.json" "blok-errors" "dashboards/blok-errors.json" }}
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ include "blok.fullname" $ }}-dashboard-{{ $name }}
  namespace: {{ default $.Release.Namespace $.Values.monitoring.grafanaDashboards.namespace }}
  labels:
    {{ $.Values.monitoring.grafanaDashboards.label }}: {{ $.Values.monitoring.grafanaDashboards.labelValue | quote }}
    {{- include "blok.labels" $ | nindent 4 }}
data:
  {{ $name }}.json: |
    {{- $files.Get $path | nindent 4 }}
{{- end }}
{{- end }}
```

The dashboard JSON files must be moved from `infra/metrics/dashboards/` to `infra/helm/blok/dashboards/` so the Helm `.Files.Get` lookup works (Helm only accesses files inside the chart directory).

### A7-6 — Backend on k8s: kube-prometheus-stack integration guide

Add `infra/helm/blok/OBSERVABILITY.md` documenting the recommended integration with kube-prometheus-stack. Key points:

- Install kube-prometheus-stack: `helm install kube-prom prometheus-community/kube-prometheus-stack -n monitoring --create-namespace --set sidecar.dashboards.enabled=true --set sidecar.dashboards.label=grafana_dashboard`
- Install Blok with monitoring: `helm install blok ./infra/helm/blok -f values-multiregion.yaml --set monitoring.enabled=true --set monitoring.serviceMonitor.enabled=true --set monitoring.serviceMonitor.labels.release=prometheus --set monitoring.grafanaDashboards.enabled=true`
- For Loki log shipping: configure a Promtail DaemonSet targeting the Blok pod log files. Since `CONSOLE_LOG_ACTIVE=false` in production, Blok must write to a file (or the Loki integration needs the structured-log changes from OBS-03).
- For Tempo tracing: set `OTEL_EXPORTER_OTLP_ENDPOINT=http://tempo.monitoring:4318` (already in `values-multiregion.yaml:155`).

Do NOT add a `Chart.yaml` `dependencies:` entry for kube-prometheus-stack — it is an operator concern, not a library, and bundling it would force operators to accept a specific version. Reference it instead.

### B7-1 — `blok_unhandled_rejection_total` counter

**File:** `core/runner/src/TriggerBase.ts`, lines 325–337 (the `onRejection` handler).

Current code logs the error to `logger?.error?.(...)` (which is gated by `CONSOLE_LOG_ACTIVE`) and calls `RunTracker.markAllRunningRunsAsCrashed`. No OTel counter is emitted.

New behavior:
1. Emit `blok_unhandled_rejection_total{trigger_type, reason_class}` via OTel. `reason_class` is derived by inspecting the error: `"Error"` for `instanceof Error`, the `err.name` property (e.g. `"TypeError"`, `"RangeError"`), or `"unknown"` for non-Error throws.
2. Write to `process.stderr` unconditionally (bypassing any `CONSOLE_LOG_ACTIVE` guard) so the root cause is always visible in container logs even in production.

```typescript
// In TriggerBase.ts, replace the onRejection handler body:
const onRejection = (reason: unknown) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  // Always write to stderr — bypass CONSOLE_LOG_ACTIVE
  process.stderr.write(
    `[blok][crash-autoflip] unhandledRejection — ${err.stack || err.message}\n`
  );
  try {
    const flipped = RunTracker.getInstance().markAllRunningRunsAsCrashed(err);
    logger?.error?.(
      `[blok][crash-autoflip] unhandledRejection — flipped ${flipped} run(s) to crashed: ${err.message}`
    );
  } catch (markErr) {
    process.stderr.write(`[blok][crash-autoflip] markAllRunningRunsAsCrashed failed: ${markErr}\n`);
  }
  // Emit OTel counter — no-op if no exporter configured
  const reasonClass = err.name && err.name !== "Error" ? err.name : "Error";
  metrics.getMeter("blok").createCounter("blok_unhandled_rejection_total", {
    description: "Total unhandled promise rejections seen by this process",
  }).add(1, { trigger_type: "process", reason_class: reasonClass });
};
```

The counter instrument should be created once as a module-level or class-level field rather than per-call (OTel best practice). Add a static field `private static unhandledRejectionCounter` initialized in `installCrashHandlers`.

### B7-2 — Pre-`startRun` error metric and synthetic run record

**File:** `triggers/http/src/runner/HttpTrigger.ts`, the inner request handler around lines 1419–1424.

Currently, if `this.configuration.init(...)` throws or `this.applyMiddlewareChain(...)` throws, the error propagates to the outer Hono catch (around line 1541+) which emits an HTTP error but no run record exists.

New behavior — wrap the pre-`startRun` section in a try/catch and on failure:

1. Emit `blok_boot_error_total{trigger_type, error_class}` counter. `error_class` is one of `"workflow_parse"` (thrown by `WorkflowNormalizer.assertNoSetVar` or JSON parse), `"configuration_init"` (thrown by `Configuration.init` for node-type lookup failures), `"middleware_not_found"` (thrown by `runMiddlewareChain` before `run()` is called), or `"unknown"`.
2. If `RunTracker.getInstance().active`, create a synthetic run record:

```typescript
const synthRun = tracker.startRun({
  workflowName: attemptedWorkflowName || "unknown",
  workflowPath: workflowNameInPath || "",
  triggerType: "http",
  triggerSummary: `${c.req.method} ${subPath}`,
  nodeCount: 0,
});
tracker.failRun(synthRun.id, err instanceof Error ? err : new Error(String(err)));
```

`attemptedWorkflowName` is the workflow name resolved from the route BEFORE `Configuration.init()` is called (it is available from the route table lookup). The synthetic record surfaces in Blok Studio as a failed run for the attempted workflow with the parse/config error visible in the run detail.

The `blok_boot_error_total` counter is defined in `PrometheusMetricsBridge` alongside the existing `blok_workflow_errors_total` counter:

```typescript
this.bootErrorCounter = this.meter.createCounter("blok_boot_error_total", {
  description: "Errors occurring before a run record is created (parse, init, middleware)",
  unit: "1",
});
```

### B7-3 — Janitor sweep error counter

**File:** `core/runner/src/monitoring/JanitorMetrics.ts`.

Add a new counter `blok_janitor_sweep_errors_total{table}`. The `Janitor.runOnce` method (in `core/runner/src/tracing/Janitor.ts`) should call `JanitorMetrics.getInstance().recordSweepError(attrs)` in its per-table catch block instead of (or in addition to) silently logging.

```typescript
// JanitorMetrics.ts — add:
private readonly sweepErrorCounter = metrics.getMeter("blok").createCounter("blok_janitor_sweep_errors_total", {
  description: "Total errors encountered during Janitor sweeps per table.",
  unit: "1",
});

recordSweepError(attrs: JanitorAttributes): void {
  this.sweepErrorCounter.add(1, attrs as unknown as Record<string, string>);
}
```

### B7-4 — New `blok-errors.json` dashboard

**New file:** `infra/metrics/dashboards/blok-errors.json` (and `infra/helm/blok/dashboards/blok-errors.json` after A7-5 moves the files).

Dashboard panels:

| Panel | Query | Unit |
|-------|-------|------|
| Workflow Error Rate | `sum(rate(blok_workflow_errors_total[$__rate_interval])) by (workflow_name, error_category)` | req/s |
| Concurrency Denied Rate | `sum(rate(blok_concurrency_denied_total[$__rate_interval])) by (workflow_name, mode)` | req/s |
| Crash / Timeout Run Count | `sum(increase(blok_workflow_executions_total{status=~"crashed|timedOut"}[$__rate_interval])) by (workflow_name, status)` | count |
| Unhandled Rejection Rate | `rate(blok_unhandled_rejection_total[$__rate_interval])` | /s |
| Pre-startRun Boot Errors | `sum(rate(blok_boot_error_total[$__rate_interval])) by (trigger_type, error_class)` | /s |
| Janitor Sweep Errors | `sum(rate(blok_janitor_sweep_errors_total[$__rate_interval])) by (table)` | /s |
| Error Rate by Category (stat) | `topk(5, sum(rate(blok_workflow_errors_total[$__rate_interval])) by (error_category))` | top-N |

The dashboard uses `${DS_PROMETHEUS}` data source variable (matching the four existing dashboards), `env` and `workflow_name` template variables for filtering.

## Tasks (SDD breakdown)

**T1. Fix `values-multiregion.yaml` nesting bug** — `infra/helm/blok/values-multiregion.yaml:137–144`: move `serviceMonitor:` block under `monitoring:` and add `prometheus.enabled: true`. Acceptance: `helm template blok ./infra/helm/blok -f values-multiregion.yaml --set monitoring.enabled=true | grep -c "ServiceMonitor"` returns 1. Effort: 0.25 days.

**T2. Extend base `values.yaml` monitoring block** — `infra/helm/blok/values.yaml:167–181`: add `scrapeTimeout`, `labels`, `podMonitor.enabled`, `grafanaDashboards.*`. Acceptance: `helm lint ./infra/helm/blok` passes with no warnings. Effort: 0.25 days.

**T3. Add `scrapeTimeout` and `labels` to `servicemonitor.yaml` template** — `infra/helm/blok/templates/servicemonitor.yaml`: add `.Values.monitoring.serviceMonitor.scrapeTimeout` and `.Values.monitoring.serviceMonitor.labels` to the endpoints block. Acceptance: rendered ServiceMonitor YAML includes `scrapeTimeout` and the operator-supplied labels. Effort: 0.25 days.

**T4. Ship `podmonitor.yaml` template** — new `infra/helm/blok/templates/podmonitor.yaml` as specified in Design A7-3. Also add `metrics` named port to `deployment.yaml` when `monitoring.enabled`. Acceptance: `helm template --set monitoring.enabled=true --set monitoring.podMonitor.enabled=true` produces a `PodMonitor` with both `http` and `metrics` endpoints. Effort: 0.5 days.

**T5. Move dashboards into Helm chart and add ConfigMap template** — Move `infra/metrics/dashboards/*.json` to `infra/helm/blok/dashboards/`. Create `infra/helm/blok/templates/dashboards.yaml`. Acceptance: `helm template --set monitoring.enabled=true --set monitoring.grafanaDashboards.enabled=true` produces five ConfigMaps each containing valid JSON. Effort: 0.5 days.

**T6. Author `blok-errors.json` dashboard** — new `infra/helm/blok/dashboards/blok-errors.json` (and keep a copy at `infra/metrics/dashboards/blok-errors.json` for the Docker Compose dev stack). Panels as specified in Design B7-4. Acceptance: dashboard imports cleanly into Grafana and all panels render without "No data" when Blok is running and emitting the named metrics. Effort: 1.0 days.

**T7. Write `OBSERVABILITY.md` integration guide** — new `infra/helm/blok/OBSERVABILITY.md` as specified in Design A7-6. Also add cAdvisor guidance to `infra/helm/blok/templates/NOTES.txt`. Acceptance: a new engineer can follow the guide to a working Grafana dashboard in a fresh k8s cluster. Effort: 0.5 days.

**T8. Add `blok_unhandled_rejection_total` counter to crash handlers** — `core/runner/src/TriggerBase.ts:303–341`. Add static `private static unhandledRejectionCounter` initialized in `installCrashHandlers`. Add `process.stderr.write(...)` call in both `onUncaught` and `onRejection` handlers (unconditional, bypasses logger). Acceptance: unit test `TriggerBase.crash-handlers.test.ts` asserts the counter increments on `process.emit('unhandledRejection', ...)` and that the counter has a `reason_class` attribute. Effort: 0.75 days.

**T9. Emit `blok_boot_error_total` and create synthetic run on pre-`startRun` error** — `triggers/http/src/runner/HttpTrigger.ts` inner handler; `core/runner/src/monitoring/PrometheusMetricsBridge.ts` (new counter field). Wrap `Configuration.init()` and `applyMiddlewareChain()` calls in a try/catch that: (a) emits the counter with `error_class` derived from the exception type/message, (b) creates a synthetic run via `tracker.startRun` + immediate `tracker.failRun` when tracker is active. Acceptance: integration test submits a request for a workflow whose JSON has a `set_var` field (triggers `assertNoSetVar`); Studio shows a failed run record; `blok_boot_error_total{error_class="workflow_parse"}` increments. Effort: 1.5 days.

**T10. Add `blok_janitor_sweep_errors_total` to `JanitorMetrics`** — `core/runner/src/monitoring/JanitorMetrics.ts`: add `sweepErrorCounter` field and `recordSweepError(attrs)` method. Update `core/runner/src/tracing/Janitor.ts` per-table catch to call `JanitorMetrics.getInstance().recordSweepError(attrs)`. Acceptance: unit test injects a store that throws on purge; asserts `blok_janitor_sweep_errors_total{table="idempotency_cache"}` = 1. Effort: 0.5 days.

**T11. Wire Docker Compose dev stack to pick up the new `blok-errors.json`** — `infra/metrics/docker-compose.yml`: ensure the Grafana volume mount covers the new file. Update `infra/metrics/datasources.yml` if needed. Acceptance: `docker compose -f infra/metrics/docker-compose.yml up -d` and navigating to Grafana shows the blok-errors dashboard. Effort: 0.25 days.

**T12. Regression tests for Helm rendering** — New `infra/helm/blok/tests/` directory with Helm unit tests (using `helm unittest` or equivalent). Test cases: (a) vanilla install renders no ServiceMonitor; (b) `monitoring.enabled=true,serviceMonitor.enabled=true` renders one ServiceMonitor with correct labels field; (c) multiregion values file with `monitoring.enabled=true` renders ServiceMonitor (validates the nesting-bug fix); (d) `podMonitor.enabled=true` renders PodMonitor with both named ports; (e) `grafanaDashboards.enabled=true` renders five ConfigMaps. Effort: 1.0 days.

**Dependency order:** T1→T2→T3 in parallel; T4 after T2; T5→T6 in sequence; T7 after T5+T6; T8 independent; T9 independent (depends on OBS-01 defining the error counter convention); T10 independent; T11 after T6; T12 after T1–T5.

## Tests

### Unit tests

- `core/runner/src/monitoring/__tests__/JanitorMetrics.test.ts`: new test case "recordSweepError increments blok_janitor_sweep_errors_total with table label". Mock the OTel meter, inject an error in the Janitor's purge path, assert the counter fires.
- `core/runner/src/__tests__/unit/TriggerBase.crash-handlers.test.ts` (extend existing): assert `blok_unhandled_rejection_total` increments when `process.emit('unhandledRejection', new TypeError("test"))` is called after `installCrashHandlers()`; assert `reason_class=TypeError`; assert `process.stderr.write` is called unconditionally (mock `process.stderr.write` before calling the handler).
- `core/runner/src/monitoring/__tests__/PrometheusMetricsBridge.test.ts` (extend): assert `blok_boot_error_total` counter increments when `recordBootError(category, labels)` is called with `error_class="workflow_parse"`.

### Integration tests

- `triggers/http/src/__tests__/integration/boot-error-synthetic-run.test.ts`: start an HttpTrigger with a workflow that has `set_var: true` in its JSON (triggers `assertNoSetVar`); POST to the workflow's route; assert the response is 500; query `tracker.getRuns({workflowName: "test-wf"})` and assert one run exists with `status="failed"` and an error message containing "set_var".
- `triggers/http/src/__tests__/integration/middleware-not-found-synthetic-run.test.ts`: configure `BLOK_GLOBAL_MIDDLEWARE=nonexistent-mw`; POST to a workflow; assert a failed synthetic run exists.

### End-to-end Helm test

- Smoke test with `helm install --dry-run --debug` to validate all template paths.
- `helm unittest` tests for the five rendering scenarios in T12.

## Back-compat, kill-switches & defaults

| Env var / value | Default | Kill-switch | Notes |
|----------------|---------|------------|-------|
| `monitoring.enabled` | `false` | N/A (Helm value) | No behavior change for existing installs. |
| `monitoring.serviceMonitor.enabled` | `false` | N/A | The nesting fix in `values-multiregion.yaml` is a BREAKING CHANGE for operators who relied on the broken path — they were getting NO ServiceMonitor before, and will now get one when they set `monitoring.enabled=true`. Net-positive; document in changelog. |
| `monitoring.podMonitor.enabled` | `false` | N/A | Requires Prometheus Operator CRD; if CRD is absent, `helm install` will error unless `monitoring.podMonitor.enabled=false`. |
| `monitoring.grafanaDashboards.enabled` | `false` | N/A | ConfigMaps are large; opt-in only. |
| `BLOK_CRASH_AUTOFLIP_DISABLED=1` | not set (enabled) | Kills crash handlers including the new stderr write and counter | Existing kill-switch, unchanged. |
| `blok_unhandled_rejection_total` counter | emitted when crash handlers are installed (i.e., by default) | `BLOK_CRASH_AUTOFLIP_DISABLED=1` | New metric; no existing dashboards query it — additive. |
| `blok_boot_error_total` counter | emitted on any pre-startRun error | N/A (error path only) | New metric; additive. |
| `blok_janitor_sweep_errors_total` counter | emitted from Janitor when a sweep throws | `BLOK_JANITOR_DISABLED=1` | New metric; additive. |
| Synthetic run record on pre-startRun error | created when `BLOK_TRACE_ENABLED != "false"` | `BLOK_TRACE_ENABLED=false` | Existing trace store toggle; new behavior under the existing toggle. |
| Moving dashboard JSONs from `infra/metrics/dashboards/` to `infra/helm/blok/dashboards/` | — | — | BREAKING for any operator mounting `infra/metrics/dashboards/` as a Docker volume directly. Keep symlinks or copies at the old path for the Docker Compose dev stack (T11). |

**Explicit breaking change (release note material):** The `values-multiregion.yaml` nesting bug fix means operators who previously passed `-f values-multiregion.yaml` and saw NO ServiceMonitor will now get one after setting `monitoring.enabled=true`. This is the correct behavior but operators with strict resource constraints should audit before upgrading.

## Risks & open questions

1. **Prometheus Operator CRD availability:** `ServiceMonitor` and `PodMonitor` are CRDs installed by the Prometheus Operator (kube-prometheus-stack). If an operator installs the Blok chart against a cluster without the CRD, `helm install` will fail with an API discovery error. Mitigation: document the dependency clearly, and consider adding a `monitoring.serviceMonitor.enabled: false` guard check with a NOTES.txt warning when `monitoring.enabled: true` but the CRD is unknown. The `helm install --skip-crds` flag bypasses CRD creation but not CRD validation.
2. **Synthetic run record cost:** Creating a synthetic run for every pre-`startRun` error means a bombardment of 404 requests (e.g., from a k8s liveness probe misconfiguration) creates many run records. Mitigation: gate synthetic record creation on a `blok_boot_error_synthetic_runs.enabled` env var, or add a rate-limit (e.g., at most one synthetic record per `(workflowName, error_class)` per 10 seconds). Default-on but with the rate limit.
3. **`blok_unhandled_rejection_total` counter per-call overhead:** Creating the counter instrument per rejection event (as shown in the design) triggers an OTel instrument lookup on each call. Use a cached static field instead. The design already notes this — confirm the implementation uses a static field.
4. **Dashboard JSON maintenance:** The `blok-errors.json` dashboard references `blok_unhandled_rejection_total` (new, from T8) and `blok_boot_error_total` (new, from T9). These metrics only appear after the respective code changes ship. Pre-T8/T9, all panels on the errors dashboard show "No data" — acceptable during phased rollout, but operators should be aware.
5. **`CONSOLE_LOG_ACTIVE=false` and structured logging:** `values-multiregion.yaml:152` sets `CONSOLE_LOG_ACTIVE=false`. The `process.stderr.write` bypass introduced in B7-1 only handles the crash-handler path. Other pre-`startRun` error logs (from `logger.error(...)` in the Hono catch) still go through the DefaultLogger which may be suppressed. A full structured-log-to-Loki story is out of scope here (belongs to OBS-03) but operators should be warned in OBSERVABILITY.md.
6. **File-path compatibility after dashboard move:** Moving JSONs from `infra/metrics/dashboards/` to `infra/helm/blok/dashboards/` breaks the Docker Compose dev stack volume mount. T11 must update `infra/metrics/docker-compose.yml` to point to the new path, OR maintain copies in both locations. Symlinks are fragile in Docker. Recommendation: keep the source of truth in `infra/helm/blok/dashboards/` and update the Docker Compose mount path.

## Out of scope / follow-ups

- **OBS-03:** Full structured-log-to-Loki shipping (no-op logger suppression fix, run_id/trace_id correlation in log lines, Promtail/FluentBit DaemonSet configuration). This epic only guarantees that crash-handler events reach stderr.
- **OBS-01 B6:** `/metrics` port exposure for non-HTTP triggers (cron, worker, websocket). The PodMonitor in T4 is pre-wired with a `metrics` port but will show no data until OBS-01 B6 ships.
- **`blok_runtime_node_errors_total` metric:** Referenced in the blok-errors dashboard design above but not yet defined in the codebase (no grep hits in `core/`). Its definition belongs to OBS-01 and is assumed to land before this dashboard is used in production.
- **Cross-process OTel counter deduplication:** In a multi-replica deployment, `blok_unhandled_rejection_total` and `blok_boot_error_total` counters are per-process; Prometheus naturally aggregates them via `sum()`. No special handling needed.
- **Horizontal scaling of the run store (SQLite):** Synthetic run records written from T9 go to the same SQLite run store as normal runs. In a multi-replica deployment, each replica has its own SQLite file. This is the existing limitation for all run records. The Postgres run store (production recommendation) would centralize them.
- **Wakeup-on-slot-release for queued concurrency runs:** OOM/SIGKILL of the process holding a concurrency slot leaves the slot with a lease expiry (default 1h). cAdvisor visibility helps detect OOM events, but releasing the lease on death still requires the cross-process backend (NATS KV or Redis) documented in `CLAUDE.md` rule 10.
- **Helm unittest CI integration:** T12 specifies unit tests but not a CI step. Adding `helm unittest` to the CI pipeline is a follow-up (blocked on confirming the CI toolchain supports it).
