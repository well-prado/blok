# OBS-05 — Alerting & push-based error sinks

> **Status:** PROPOSED · **Phase:** mixed (wire-what-exists + build-new) · **Effort:** 8 eng-days · **Depends on:** OBS-01 (metrics naming contract), OBS-02 (Prometheus scrape health)

## TL;DR

Blok records every error class into its run store and emits OTel counters, but nothing acts on them: Prometheus has no alert rules, Alertmanager does not exist in the compose stack, the `SentryIntegration` class is never bootstrapped by any trigger, outbound webhooks fire only for three of twelve run-state transitions, async child-workflow failures produce a `console.error` and no metric, and the webhook registry is a process-local in-memory `Map` that vanishes on restart. This epic converts passive recording into active paging and push: Prometheus alert rules, an Alertmanager compose service, a Helm PrometheusRule CRD, auto-bootstrap of Sentry on `SENTRY_DSN`, full webhook coverage of all error-class transitions, a counter for async-child failures, and persistent webhook registration backed by the run store.

## Problem / current state

### A6 — No alert rules, no Alertmanager

| File | Line(s) | What's there today |
|---|---|---|
| `infra/metrics/prometheus.yml` | 1–39 | `global:`, `scrape_configs:` blocks only. No `rule_files:` block, no `alerting:` block. |
| `infra/metrics/docker-compose.yml` | 43–151 | `prometheus`, `grafana`, `tempo`, `loki` services present. No `alertmanager` service. |
| `infra/helm/blok/templates/` | entire dir | `servicemonitor.yaml`, `deployment.yaml`, `ingress.yaml`, `hpa.yaml`, `pvc.yaml`, `secret.yaml`, `configmap.yaml`. No `prometheusrule.yaml`. |

Prometheus scrapes `blok_workflow_errors_total` (defined at `core/runner/src/monitoring/PrometheusMetricsBridge.ts:57`) and `blok_concurrency_denied_total` (defined at `core/runner/src/monitoring/ConcurrencyMetrics.ts:73`) every 5 s. Neither counter is wired to an alert rule. A fintech workflow that fails at 100% for 10 minutes is visible only to someone watching Grafana.

### B5a — SentryIntegration is never bootstrapped

| File | Line(s) | What's there today |
|---|---|---|
| `core/runner/src/integrations/SentryIntegration.ts` | 87–278 | Full `SentryIntegration` class: `init()`, `captureWorkflowError()`, `captureNodeError()`, `captureTriggerError()`. Zero call sites outside tests. |
| `core/runner/src/TriggerBase.ts` | 1–36 | Imports list: `Configuration`, `DefaultLogger`, `RunCancelledError`, `Runner`, `WaitDispatchRequest`, concurrency/scheduling helpers, `Janitor`, `RunTracker`, `TracingLogger`, etc. `SentryIntegration` is not imported anywhere in `TriggerBase.ts`. |
| `triggers/http/src/` (entire package) | — | `grep -r SentryIntegration` returns zero hits inside any trigger package. |

The class ships, its `@example` docstring shows correct usage, and `SentryIntegration.test.ts` exercises every method — but no production code path calls `new SentryIntegration()` or `init()`. Setting `SENTRY_DSN` in the environment today has no effect whatsoever.

### B5b — Webhook fireWebhooks only covers 3 of 12 run-state events

| File | Line(s) | What's there today |
|---|---|---|
| `core/runner/src/tracing/RunTracker.ts` | 1204–1212 | `private fireWebhooks(event: RunEvent)` maps `event.type` against a 3-key `eventMap`: `{RUN_STARTED: "run.started", RUN_COMPLETED: "run.completed", RUN_FAILED: "run.failed"}`. Line 1211: `if (!webhookEvent) return;` — all other event types return immediately without firing. |
| `core/runner/src/tracing/types.ts` | 600, 638, 645, 653 | `RunEventType` union includes `RUN_THROTTLED`, `RUN_CANCELLED`, `RUN_CRASHED`, `RUN_TIMED_OUT` (plus `RUN_DELAYED`, `RUN_EXPIRED`, `RUN_QUEUED`, `RUN_DEBOUNCED`). None appear in `eventMap`. |

A webhook subscriber configured for `run.crashed` or `run.timedOut` today receives nothing — those transitions emit an internal EventEmitter event and update the run store but the outbound HTTP call is gated behind the `if (!webhookEvent) return` early exit.

### B5c — Async child failures produce console.error and no metric

| File | Line(s) | What's there today |
|---|---|---|
| `core/runner/src/SubworkflowNode.ts` | 513–535 | `dispatchAsync` method. `setImmediate` callback: on child error calls `tracker.failRun(childRunId, err)` (run record updated) then `console.error(...)` (line 522–525). No OTel counter increment. No Sentry capture. The `http-self wait:false` path at line 451–452 has the same pattern: `.catch((err) => console.error(...))` with no metric. |
| `core/runner/src/monitoring/ConcurrencyMetrics.ts` | 68–177 | Counter names declared: `blok_concurrency_acquired_total`, `blok_concurrency_denied_total`, `blok_concurrency_released_total`, three scheduling counters, two install counters. No `blok_subworkflow_async_failure_total` or equivalent. |

An operator with 1 000 fire-and-forget sub-workflows failing per hour has no way to know without polling Studio — `console.error` is discarded in production (`CONSOLE_LOG_ACTIVE=false`) and no metric reflects the failures.

### B5d — Webhook registry is in-process, lost on restart, not shared across replicas

| File | Line(s) | What's there today |
|---|---|---|
| `core/runner/src/tracing/RunTracker.ts` | 118 | `private webhooks: Map<string, Webhook> = new Map();` — plain in-process `Map`, no persistence. |
| `core/runner/src/tracing/RunTracker.ts` | 1152–1171 | `registerWebhook`, `removeWebhook`, `getWebhooks` — all operate on the in-memory `Map`. No call to any `RunStore` method. |
| `core/runner/src/tracing/RunStore.ts` / `InMemoryRunStore.ts` / `SqliteRunStore.ts` | — | No `saveWebhook`, `getWebhooks`, or `deleteWebhook` methods exist in any store implementation. |

Registering a webhook via the API and then restarting the process (deploy, OOM, SIGKILL) silently drops the registration. In a multi-replica Kubernetes deployment, a webhook registered on replica 0 never fires from replica 1.

## Goal & acceptance criteria

- **AC1** `infra/metrics/prometheus.yml` contains a `rule_files:` block pointing at `rules/blok-alerts.yml`. That file defines at minimum four alert rules: `BlokWorkflowErrorRateHigh`, `BlokCrashedRunsSpike`, `BlokTimeoutRateHigh`, `BlokConcurrencyDeniedRateHigh`. Each fires in the `dev` environment within 5 minutes of the condition being met (verifiable with `promtool test rules`).
- **AC2** `infra/metrics/docker-compose.yml` includes an `alertmanager` service with a `config.yml` that routes `severity=critical` alerts to a webhook receiver (or email stub); Prometheus's `alerting:` block points at it. `docker compose up` starts alertmanager without errors.
- **AC3** `infra/helm/blok/templates/prometheusrule.yaml` is a `PrometheusRule` CRD whose `spec.groups[0].rules` mirrors `blok-alerts.yml`. Enabled when `values.monitoring.prometheusRule.enabled: true`.
- **AC4** Starting any trigger with `SENTRY_DSN=<dsn>` set bootstraps `SentryIntegration` exactly once per process. `captureWorkflowError` is called for every run that reaches `failRun`, `markRunCrashed`, or `markRunTimedOut`. Verifiable by setting `DSN` to a test ingest URL and confirming event receipt; or via the unit-test mock path.
- **AC5** `fireWebhooks` fires for `run.crashed`, `run.timedOut`, `run.throttled`, and `run.cancelled` in addition to the existing three. A subscriber configured for `run.crashed` receives a POST within the 5 s timeout window when a run enters `crashed` state.
- **AC6** A new OTel counter `blok_subworkflow_async_failure_total` with label `workflow_name` is incremented every time `dispatchAsync` catches an error AND every time the `http-self wait:false` fetch rejects. The counter appears in `/metrics` output when the Prometheus exporter is active.
- **AC7** Webhook registrations survive process restart: `registerWebhook` writes to the `RunStore` (new `saveWebhook` method); `RunTracker` seeds `this.webhooks` from the store on construction. A webhook registered before restart fires correctly after restart without re-registering.
- **AC8** In a two-process setup (simulated by two `RunTracker` instances sharing one `SqliteRunStore`), a webhook registered via process A fires from process B. (Single-store shared-file sqlite only; NATS/Redis cross-process is out of scope for this epic.)

## Design / proposed changes

### T1 — Prometheus alert rules + Alertmanager compose service (A6)

**New file `infra/metrics/rules/blok-alerts.yml`:**

```yaml
groups:
  - name: blok.workflow
    rules:
      - alert: BlokWorkflowErrorRateHigh
        expr: rate(blok_workflow_errors_total[5m]) > 0.1
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Elevated workflow error rate ({{ $value | humanizePercentage }} errors/s)"
          description: "blok_workflow_errors_total is rising. Check Blok Studio for failing runs."

      - alert: BlokCrashedRunsSpike
        expr: increase(blok_workflow_errors_total{status="crashed"}[5m]) > 3
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Crash spike detected ({{ $value }} new crashed runs in 5m)"
          description: "Runs entering 'crashed' state. Likely an uncaught exception or OOM. Check process logs."

      - alert: BlokTimeoutRateHigh
        expr: rate(blok_workflow_errors_total{status="timedOut"}[5m]) > 0.05
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Workflow timeout rate elevated"
          description: "Runs are timing out via per-step maxDuration. Review slow nodes or increase maxDuration."

      - alert: BlokConcurrencyDeniedRateHigh
        expr: rate(blok_concurrency_denied_total[5m]) > 1
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Concurrency denials elevated ({{ $value }}/s)"
          description: "Workflows are being throttled. Consider raising concurrencyLimit or onLimit:queue."
```

Note: `blok_workflow_errors_total{status=...}` requires that `PrometheusMetricsBridge.recordError` (currently at `core/runner/src/monitoring/PrometheusMetricsBridge.ts:57–60`) gains a `status` label for `failed`/`crashed`/`timedOut`. See T2.

**Edit `infra/metrics/prometheus.yml`** — add after line 4 (after `evaluation_interval`):

```yaml
rule_files:
  - "rules/blok-alerts.yml"

alerting:
  alertmanagers:
    - static_configs:
        - targets: ["alertmanager:9093"]
```

**New file `infra/metrics/alertmanager/config.yml`:**

```yaml
global:
  resolve_timeout: 5m

route:
  receiver: blok-webhook
  group_by: [alertname, severity]
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h
  routes:
    - match:
        severity: critical
      receiver: blok-webhook

receivers:
  - name: blok-webhook
    webhook_configs:
      - url: "${ALERTMANAGER_WEBHOOK_URL:-http://localhost:4000/__blok/alerts}"
        send_resolved: true
```

**Edit `infra/metrics/docker-compose.yml`** — add `alertmanager` service (after the `prometheus` block):

```yaml
alertmanager:
  container_name: alertmanager
  image: prom/alertmanager:latest
  ports:
    - "9093:9093"
  volumes:
    - "./alertmanager/config.yml:/etc/alertmanager/config.yml"
  command:
    - --config.file=/etc/alertmanager/config.yml
    - --storage.path=/alertmanager
  restart: unless-stopped
  networks:
    - shared-network
```

**New file `infra/helm/blok/templates/prometheusrule.yaml`:**

```yaml
{{- if and .Values.monitoring.enabled .Values.monitoring.prometheusRule.enabled -}}
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: {{ include "blok.fullname" . }}
  labels:
    {{- include "blok.labels" . | nindent 4 }}
spec:
  groups:
    - name: blok.workflow
      rules:
        - alert: BlokWorkflowErrorRateHigh
          expr: rate(blok_workflow_errors_total[5m]) > 0.1
          for: 2m
          labels:
            severity: critical
        - alert: BlokCrashedRunsSpike
          expr: increase(blok_workflow_errors_total{status="crashed"}[5m]) > 3
          for: 1m
          labels:
            severity: critical
        - alert: BlokTimeoutRateHigh
          expr: rate(blok_workflow_errors_total{status="timedOut"}[5m]) > 0.05
          for: 2m
          labels:
            severity: warning
        - alert: BlokConcurrencyDeniedRateHigh
          expr: rate(blok_concurrency_denied_total[5m]) > 1
          for: 2m
          labels:
            severity: warning
{{- end }}
```

**Edit `infra/helm/blok/values.yaml`** — add under `monitoring:`:

```yaml
monitoring:
  prometheusRule:
    enabled: false   # set true when prometheus-operator is installed
```

### T2 — Add `status` label to blok_workflow_errors_total (prerequisite for crash/timedOut alerts)

**File:** `core/runner/src/monitoring/PrometheusMetricsBridge.ts`

The existing `errorsCounter` at line 57 is incremented by `recordError(labels: ExecutionLabels)`. Add a `status` field to the labels type and update every call site in `TriggerBase.ts` where `failRun` / `markRunCrashed` / `markRunTimedOut` flow through the metrics bridge.

Current call site pattern (TriggerBase run() finally block): `this.metricsCollector.recordFailure(...)` → `this.metricsBridge.recordError(...)`. Extend `ExecutionLabels` with `status?: "failed" | "crashed" | "timedOut"` and pass the actual terminal status. This is the only change needed for the rule expressions in T1 to work.

**Env var:** none. **Kill-switch:** none needed (label is additive; alert thresholds are tunable in the rules file).

### T3 — Auto-bootstrap SentryIntegration in TriggerBase.installOperationalHandlers (B5a)

**File:** `core/runner/src/TriggerBase.ts`

**Current `installOperationalHandlers` (lines 516–538):** installs crash handlers, orphan recovery, Janitor, shutdown handlers. No Sentry reference.

**New behavior:** At the end of `installOperationalHandlers`, check `process.env.SENTRY_DSN`. If set, import `SentryIntegration` lazily (dynamic import preserves the existing "optional peer dep" contract), call `await sentry.init()`, and store the instance on a process-global singleton so subsequent calls are no-ops:

```typescript
// In installOperationalHandlers, after the shutdown handler block:
try {
  await TriggerBase.bootstrapSentry(logger);
} catch (err) {
  logger?.error?.(`[blok][sentry] bootstrap failed: ${err instanceof Error ? err.message : String(err)}`);
}
```

**New private static method `TriggerBase.bootstrapSentry`:**

```typescript
private static sentryInstance: import("./integrations/SentryIntegration").SentryIntegration | null = null;
private static sentryBootstrapped = false;

static async bootstrapSentry(logger?: CrashAutoflipLogger): Promise<void> {
  if (TriggerBase.sentryBootstrapped) return;
  TriggerBase.sentryBootstrapped = true;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  const { SentryIntegration } = await import("./integrations/SentryIntegration");
  const sentry = new SentryIntegration({
    dsn,
    environment: process.env.NODE_ENV || "production",
    release: process.env.BLOK_RELEASE,
  });
  const ok = await sentry.init();
  if (!ok) {
    logger?.error?.("[blok][sentry] init() returned false — @sentry/node may not be installed");
    return;
  }
  TriggerBase.sentryInstance = sentry;
  logger?.log?.("[blok][sentry] initialized");
}

static getSentryInstance(): import("./integrations/SentryIntegration").SentryIntegration | null {
  return TriggerBase.sentryInstance;
}
```

**Wire Sentry captures in `TriggerBase.run()`:** In the `catch` block that calls `tracker.failRun(traceRunId, err)` (the existing error handling around line 1200 of TriggerBase.ts), add:

```typescript
TriggerBase.getSentryInstance()?.captureWorkflowError(
  err instanceof Error ? err : new Error(String(err)),
  {
    workflowName: cfg.name || ctx.workflow_name || "unknown",
    workflowPath: ctx.workflow_path || "",
    requestId: traceRunId,
    triggerType: this.constructor.name,
  }
);
```

The same capture call sits in the `markRunCrashed` path (inside `installCrashHandlers` and `recoverOrphanedRuns`) — pass the error through to Sentry there too.

**Env vars:**

| Var | Default | Purpose |
|---|---|---|
| `SENTRY_DSN` | unset | If set, Sentry is bootstrapped. Absence = no Sentry (zero overhead). |
| `BLOK_RELEASE` | unset | Passed as `release` to `Sentry.init`. Use `git rev-parse HEAD` in your CI. |
| `BLOK_SENTRY_DISABLED` | unset | Kill-switch: set to `1` to prevent bootstrap even when `SENTRY_DSN` is set. |

**Back-compat:** `@sentry/node` remains an optional peer dep. Dynamic import keeps the existing silent-fallback contract intact. No change to call sites that already construct `SentryIntegration` manually.

### T4 — Extend fireWebhooks to all error-class events (B5b)

**File:** `core/runner/src/tracing/RunTracker.ts`, lines 1204–1212.

**Current `eventMap`:**

```typescript
const eventMap: Record<string, string> = {
  RUN_STARTED: "run.started",
  RUN_COMPLETED: "run.completed",
  RUN_FAILED: "run.failed",
};
```

**New `eventMap` (replace in-place):**

```typescript
const eventMap: Record<string, string> = {
  RUN_STARTED:   "run.started",
  RUN_COMPLETED: "run.completed",
  RUN_FAILED:    "run.failed",
  RUN_CRASHED:   "run.crashed",
  RUN_TIMED_OUT: "run.timedOut",
  RUN_THROTTLED: "run.throttled",
  RUN_CANCELLED: "run.cancelled",
};
```

No other changes needed — the rest of `fireWebhooks` (HMAC, HTTP POST, fail-count circuit breaker at line 1247) works identically for any event type. The webhook subscriber's `events` array already accepts arbitrary strings; `run.crashed` etc. must simply be listed when registering.

**Back-compat:** Existing subscribers that listed only `["run.started", "run.completed", "run.failed"]` receive no additional calls. Subscribers must opt in to the new events by listing them.

### T5 — blok_subworkflow_async_failure_total counter (B5c)

**Files:** `core/runner/src/SubworkflowNode.ts`, `core/runner/src/monitoring/ConcurrencyMetrics.ts` (or a new `SubworkflowMetrics.ts`).

Add a new singleton counter (following the `ConcurrencyMetrics` pattern):

```typescript
// core/runner/src/monitoring/SubworkflowMetrics.ts (new file)
import { metrics } from "@opentelemetry/api";

export class SubworkflowMetrics {
  private static instance: SubworkflowMetrics | null = null;

  private readonly asyncFailureCounter = metrics.getMeter("blok").createCounter(
    "blok_subworkflow_async_failure_total",
    { description: "Async (wait:false) sub-workflow dispatch failures.", unit: "1" }
  );

  private constructor() {}

  static getInstance(): SubworkflowMetrics {
    if (!SubworkflowMetrics.instance) SubworkflowMetrics.instance = new SubworkflowMetrics();
    return SubworkflowMetrics.instance;
  }

  recordAsyncFailure(attrs: { workflow_name: string; dispatch: "in-process" | "http-self" }): void {
    this.asyncFailureCounter.add(1, attrs as unknown as Record<string, string>);
  }
}
```

**Edit `SubworkflowNode.ts` `dispatchAsync`** (after line 520, inside the catch):

```typescript
} catch (err) {
  if (childRunId) {
    tracker.failRun(childRunId, err instanceof Error ? err : new Error(String(err)));
  }
  SubworkflowMetrics.getInstance().recordAsyncFailure({
    workflow_name: childWorkflowName,
    dispatch: "in-process",
  });
  // Also capture to Sentry if bootstrapped
  TriggerBase.getSentryInstance()?.captureWorkflowError(
    err instanceof Error ? err : new Error(String(err)),
    { workflowName: childWorkflowName, requestId: childRunId, triggerType: "subworkflow-async" }
  );
  console.error(...); // existing line preserved
}
```

**Edit `SubworkflowNode.ts` `dispatchHttpSelf` wait:false path** (after line 452):

```typescript
fetch(url, { method, headers, body }).catch((err: unknown) => {
  SubworkflowMetrics.getInstance().recordAsyncFailure({
    workflow_name: entry.name,
    dispatch: "http-self",
  });
  console.error(...); // existing line preserved
});
```

**Env var:** none. The counter is no-op without an OTel exporter (identical pattern to `ConcurrencyMetrics`).

### T6 — Persist webhook registrations to RunStore (B5d)

**Files:**
- `core/runner/src/tracing/RunStore.ts` (interface)
- `core/runner/src/tracing/InMemoryRunStore.ts`
- `core/runner/src/tracing/SqliteRunStore.ts`
- `core/runner/src/tracing/RunTracker.ts`

**RunStore interface additions:**

```typescript
saveWebhook(webhook: Webhook): void;
getWebhooks(): Webhook[];
deleteWebhook(id: string): boolean;
updateWebhook(id: string, updates: Partial<Webhook>): void;
```

**SqliteRunStore migration (v14):**

```sql
CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  events TEXT NOT NULL,        -- JSON array
  secret TEXT,
  created_at INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  fail_count INTEGER NOT NULL DEFAULT 0,
  last_triggered_at INTEGER,
  last_status INTEGER
);
```

The migration increments the version counter to 14 (the existing `CURRENT_VERSION` in `SqliteRunStore.ts`).

**RunTracker changes:**

- `registerWebhook`: after `this.webhooks.set(...)`, call `this.store.saveWebhook(webhook)`.
- `removeWebhook`: after `this.webhooks.delete(...)`, call `this.store.deleteWebhook(id)`.
- `constructor`: after `this.store = store ?? new InMemoryRunStore()`, call `this._seedWebhooksFromStore()`.
- `_seedWebhooksFromStore()` (private): `for (const wh of this.store.getWebhooks()) { this.webhooks.set(wh.id, wh); }`.
- In `fireWebhooks`, after updating `webhook.failCount` / `webhook.lastStatus`: call `this.store.updateWebhook(webhook.id, { failCount: webhook.failCount, active: webhook.active, lastTriggeredAt: webhook.lastTriggeredAt, lastStatus: webhook.lastStatus })`.

**Back-compat:** `InMemoryRunStore` implements the four new methods against an in-memory `Map<string, Webhook>` — identical semantics to the current behavior. `PostgresRunStore` gets stub implementations (returning `[]` / no-op) in this epic; a follow-up can add a PG table.

## Tasks (SDD breakdown)

**T1. Add Prometheus alert rules and Alertmanager to the dev metrics stack**
- Files to create: `infra/metrics/rules/blok-alerts.yml`, `infra/metrics/alertmanager/config.yml`
- Files to edit: `infra/metrics/prometheus.yml` (add `rule_files:` + `alerting:` blocks), `infra/metrics/docker-compose.yml` (add `alertmanager` service)
- Acceptance: `promtool check rules infra/metrics/rules/blok-alerts.yml` passes; `docker compose -f infra/metrics/docker-compose.yml up alertmanager` starts; Prometheus UI `/alerts` page shows all four rules in INACTIVE state.
- Effort: 0.5 eng-days

**T2. Add `status` label to blok_workflow_errors_total and add PrometheusRule Helm template**
- Files to edit: `core/runner/src/monitoring/PrometheusMetricsBridge.ts` (extend `ExecutionLabels`, pass status at record sites), `core/runner/src/TriggerBase.ts` (pass terminal status when calling recordError)
- Files to create: `infra/helm/blok/templates/prometheusrule.yaml`
- Files to edit: `infra/helm/blok/values.yaml` (add `monitoring.prometheusRule.enabled: false`)
- Acceptance: `/metrics` output for a failed run includes `blok_workflow_errors_total{status="failed"}` etc.; `helm template` renders the PrometheusRule YAML when `monitoring.prometheusRule.enabled=true`.
- Effort: 1 eng-day

**T3. Auto-bootstrap SentryIntegration in TriggerBase when SENTRY_DSN is set**
- Files to edit: `core/runner/src/TriggerBase.ts` (add `bootstrapSentry`, `getSentryInstance`, wire into `installOperationalHandlers`, add Sentry capture calls in the `failRun` / crash / orphan paths)
- Acceptance: Starting HttpTrigger with `SENTRY_DSN=<dsn>` and triggering a failing workflow sends an event to Sentry with `workflow_name` and `requestId` context. `BLOK_SENTRY_DISABLED=1` prevents bootstrap. Starting without `SENTRY_DSN` has zero overhead (no import, no instantiation).
- Effort: 1.5 eng-days

**T4. Add Sentry capture for async sub-workflow and crash-handler failures**
- Files to edit: `core/runner/src/SubworkflowNode.ts` (call `TriggerBase.getSentryInstance()?.captureWorkflowError` in `dispatchAsync` catch and `dispatchHttpSelf` wait:false catch), `core/runner/src/TriggerBase.ts` (add Sentry capture in `installCrashHandlers`' `onUncaught` / `onRejection` handlers)
- Dependency: T3 (needs `getSentryInstance` to exist)
- Acceptance: A crashed process with `SENTRY_DSN` set sends at least one Sentry event with `trigger_type: "crash"` context per crash. An async sub-workflow failure sends a Sentry event with `trigger_type: "subworkflow-async"`.
- Effort: 1 eng-day

**T5. Extend fireWebhooks to cover run.crashed / run.timedOut / run.throttled / run.cancelled**
- Files to edit: `core/runner/src/tracing/RunTracker.ts` lines 1205–1212 (`fireWebhooks` `eventMap` literal)
- Acceptance: Unit test: construct `RunTracker` with a mock store + registered webhook subscribed to `["run.crashed"]`, call `markRunCrashed`, assert the mock HTTP POST was called. Integration test: register a webhook, run a workflow that crashes, confirm the outbound POST body contains `event: "run.crashed"`.
- Effort: 0.5 eng-days

**T6. Add blok_subworkflow_async_failure_total counter**
- Files to create: `core/runner/src/monitoring/SubworkflowMetrics.ts`
- Files to edit: `core/runner/src/SubworkflowNode.ts` (import and call in `dispatchAsync` catch and `dispatchHttpSelf` wait:false catch)
- Acceptance: A `wait:false` sub-workflow step that always throws increments `blok_subworkflow_async_failure_total{workflow_name=...,dispatch="in-process"}` in `/metrics`. The counter is 0 when no failures occur (not present vs. 0 is acceptable per OTel convention).
- Effort: 0.5 eng-days

**T7. Persist webhook registrations to RunStore**
- Files to edit: `core/runner/src/tracing/RunStore.ts` (interface: 4 new methods), `core/runner/src/tracing/InMemoryRunStore.ts` (implement), `core/runner/src/tracing/SqliteRunStore.ts` (migration v14 + implement), `core/runner/src/tracing/RunTracker.ts` (`registerWebhook`, `removeWebhook`, constructor seed, `fireWebhooks` update call)
- Files to edit (stub): `core/runner/src/tracing/PostgresRunStore.ts` (stub implementations returning `[]` / no-op)
- Acceptance: `registerWebhook` → process restart → `getWebhooks()` returns the registered webhook. `POST /__blok/webhooks` → restart → `GET /__blok/webhooks` returns the same entry. Two `RunTracker` instances sharing one SqliteRunStore both see the same webhook list.
- Effort: 2 eng-days

**T8. Add Alertmanager unit tests and alert rule tests**
- Files to create: `infra/metrics/rules/blok-alerts.test.yml` (promtool unit tests asserting each alert fires under synthetic series)
- Acceptance: `promtool test rules infra/metrics/rules/blok-alerts.test.yml` passes in CI. Each alert has at least one "should fire" and one "should not fire" series.
- Effort: 1 eng-day

## Tests

### Unit tests

**`core/runner/src/__tests__/tracing/RunTracker.webhooks.test.ts`** (new)
- Assert `registerWebhook` calls `store.saveWebhook` with the correct shape.
- Assert constructor calls `store.getWebhooks()` and seeds `this.webhooks`.
- Assert `removeWebhook` calls `store.deleteWebhook`.
- Assert `fireWebhooks` fires for `RUN_CRASHED`, `RUN_TIMED_OUT`, `RUN_THROTTLED`, `RUN_CANCELLED` (mock HTTP via `nock` or `undici mock`).
- Assert `fireWebhooks` does NOT fire for `NODE_STARTED` or `LOG_ENTRY` (unchanged guard).

**`core/runner/src/__tests__/integrations/SentryAutoBootstrap.test.ts`** (new)
- Assert `TriggerBase.bootstrapSentry` is a no-op when `SENTRY_DSN` is unset.
- Assert `TriggerBase.bootstrapSentry` is a no-op when `BLOK_SENTRY_DISABLED=1`.
- Assert `TriggerBase.bootstrapSentry` calls `SentryIntegration.init()` when DSN is set (mock `@sentry/node`).
- Assert second call is idempotent (init called once).
- Assert `captureWorkflowError` is forwarded to the mock client when `failRun` is called through a concrete trigger subclass.

**`core/runner/src/__tests__/monitoring/SubworkflowMetrics.test.ts`** (new)
- Assert `recordAsyncFailure` increments the counter (mock OTel meter).
- Assert `dispatchAsync` catch path calls `SubworkflowMetrics.getInstance().recordAsyncFailure`.

**`infra/metrics/rules/blok-alerts.test.yml`** (new promtool unit test)

```yaml
rule_files:
  - rules/blok-alerts.yml
tests:
  - interval: 1m
    input_series:
      - series: 'blok_workflow_errors_total'
        values: '0 0 0 5 10 15 20'
    alert_rule_test:
      - eval_time: 5m
        alertname: BlokWorkflowErrorRateHigh
        exp_alerts:
          - exp_labels: { severity: critical }
```

### Integration tests

**`core/runner/__tests__/integration/webhooks-persist.test.ts`** (new)
- Start `RunTracker` with `SqliteRunStore` backed by a temp file.
- Register a webhook.
- Create a new `RunTracker` instance pointing at the same file.
- Assert `getWebhooks()` on the new instance returns the registered webhook.

### End-to-end verification

1. Start `docker compose -f infra/metrics/docker-compose.yml up`.
2. Trigger a workflow that always fails: `curl -X POST http://localhost:4000/test-fail`.
3. After 30 s, navigate to `http://localhost:9090/alerts` — `BlokWorkflowErrorRateHigh` should be PENDING.
4. After 2 min, state should flip to FIRING.
5. `http://localhost:9093` (Alertmanager UI) should show the alert routed to `blok-webhook`.

## Back-compat, kill-switches & defaults

| Env var | Default | Effect |
|---|---|---|
| `SENTRY_DSN` | unset | Sentry bootstrap is skipped entirely when unset. Zero overhead. |
| `BLOK_RELEASE` | unset | Passed to `Sentry.init({ release })` when Sentry is active. |
| `BLOK_SENTRY_DISABLED` | unset | Set to `1` to skip bootstrap even when `SENTRY_DSN` is present. Useful in test environments that set a real DSN but don't want prod captures. |
| `ALERTMANAGER_WEBHOOK_URL` | `http://localhost:4000/__blok/alerts` | Receiver URL in the alertmanager config stub. Override in real deployments. |

**BREAKING default changes:** none. The `eventMap` expansion in `fireWebhooks` is strictly additive — no existing subscriber receives events it didn't ask for. The webhook persistence migration (v14) is additive SQL; pre-existing SQLite databases upgrade transparently via the existing versioned migration loop. The `status` label on `blok_workflow_errors_total` is new; existing Grafana panels that aggregate without label filters are unaffected.

**`@sentry/node` peer dep:** remains optional and absent from `package.json`. The dynamic import in `bootstrapSentry` silently returns `false` from `sentry.init()` if the package is missing (existing behavior of the `catch` block at `SentryIntegration.ts:154`). Operators who want Sentry must `bun add @sentry/node` themselves — no framework-level dep change.

## Risks & open questions

1. **Metric cardinality for `status` label on `blok_workflow_errors_total`:** Adding `status` increases cardinality by 3× (failed, crashed, timedOut). For deployments with many distinct `workflow_name` labels and hundreds of workflows this is still well within Prometheus limits (~O(1000) series). Risk: low.

2. **Sentry event volume in high-error scenarios:** If a workflow fails at 1000 req/s, `captureWorkflowError` is called 1000 times/s. Sentry's default client-side sampling (`sampleRate: 1.0`) would forward all of them. Operators should set `SENTRY_TRACES_SAMPLE_RATE` and Sentry project rate limits. The existing `SentryIntegration` already exposes `sampleRate` in its config. Risk: medium — document in the AC4 acceptance note.

3. **SQLite concurrent writes in webhook persistence (T7):** `SqliteRunStore` uses WAL mode (from the existing migration). `saveWebhook` / `updateWebhook` run in the same WAL transaction model as other writes — no additional locking concern. Risk: low.

4. **Alertmanager config in production:** The stub `config.yml` in `infra/metrics/alertmanager/` uses a webhook receiver pointing at the blok HTTP trigger, which may itself be down when alerts fire. Operators should add a PagerDuty / email receiver as a secondary in the real deployment. The stub is only for the dev compose stack.

5. **Open question:** Should `RUN_DEBOUNCED`, `RUN_DELAYED`, `RUN_EXPIRED`, `RUN_QUEUED` also fire webhooks? They represent lifecycle transitions, not errors. Recommendation: leave them out of this epic (they are not error-class events) and gate them behind a follow-up subscriber opt-in flag (`includeLifecycle: true` on registration).

## Out of scope / follow-ups

- **PagerDuty / Slack Alertmanager receivers** — the stub uses a generic webhook; real routing config is operator responsibility. Document in ops runbook.
- **PostgresRunStore webhook persistence** — T7 adds stubs; a full PG migration is a follow-up once the SQLite path is validated.
- **Cross-process webhook dedup** — in a multi-replica deployment with shared PG, all replicas seed from the store and all fire for the same event (N duplicate posts). A `fired_by` lock or a dedicated dispatcher process is a Tier-C follow-up.
- **Sentry performance tracing** — `SentryIntegration` exposes `startTransaction` but the runner does not yet create per-workflow transactions. Tracing integration is OBS-03 territory.
- **`RUN_DEBOUNCED` / `RUN_DELAYED` webhook events** — lifecycle events, not errors; see open question 5.
- **Alertmanager HA** — the compose service is single-instance; Kubernetes HA is out of scope here.
