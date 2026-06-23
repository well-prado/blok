# OBS-02 — Distributed tracing (OpenTelemetry → Tempo)

> **Status:** PROPOSED · **Phase:** 1 wire-what-exists + targeted new build · **Effort:** 5.5 eng-days · **Depends on:** none (OBS-01 log correlation is a follow-up consumer, not a prerequisite)

## TL;DR

The framework ships a complete, well-designed `bootstrapTracing` function and a `DistributedTracer` class in `core/runner/src/monitoring/`, but no trigger ever calls either — so every span lands in the no-op provider and nothing reaches Tempo. This epic wires what already exists (B1: trigger boot calls `bootstrapTracing`), then adds the two propagation layers that are structurally absent (B2: W3C `traceparent` extraction on inbound HTTP requests and injection into outbound gRPC Metadata and `http-self` sub-workflow fetches), and finally adds per-step child spans in `RunnerSteps.ts` (B4) so every node execution is visible as a discrete span in a trace rather than as an opaque block inside the run-level span. Together these deliver end-to-end distributed traces for every workflow run that flows through one or more language runtimes — the prerequisite for error observability on a multi-replica fintech deployment.

## Problem / current state

### B1 — `bootstrapTracing` is never called; OTLP SDK deps are absent

`bootstrapTracing` (`core/runner/src/monitoring/TracingBootstrap.ts`) is a polished, production-ready function. It dynamically imports `@opentelemetry/sdk-trace-node` and either `@opentelemetry/exporter-trace-otlp-http` or `@opentelemetry/exporter-trace-otlp-grpc`, creates a `NodeTracerProvider` with `BatchSpanProcessor`, calls `provider.register()` globally, and returns `{ shutdown, forceFlush }`. It has zero call sites in the entire codebase outside its own test.

Every trigger (`HttpTrigger`, `WorkerTrigger`, `CronTrigger`) acquires a tracer via `trace.getTracer(...)` and calls `this.tracer.startActiveSpan(...)` or `this.tracer.startSpan(...)` — but because no `NodeTracerProvider` is ever registered, the `@opentelemetry/api` stubs return a no-op provider, all spans are silently dropped, and zero bytes reach Tempo.

The OTLP SDK packages that `bootstrapTracing` dynamically imports are not installed in any trigger package:

- `@opentelemetry/sdk-trace-node` — absent from all `package.json` files; absent from `node_modules/@opentelemetry/`.
- `@opentelemetry/exporter-trace-otlp-http` — absent from all `package.json` files; absent from `node_modules/@opentelemetry/`.
- The packages present in `node_modules/@opentelemetry/` are: `api`, `core`, `exporter-prometheus`, `resources`, `sdk-metrics`, `sdk-trace-base`, `sdk-trace-web`, `semantic-conventions` — all metrics/web-trace concerns, none of which are the Node.js trace SDK or OTLP exporter.

`bootstrapTracing` silently returns `null` when the dynamic imports fail (catch block at line 165). With the packages absent, every deployment is silently no-op.

Additionally, `bootstrapTracing` is exported from `core/runner/src/monitoring/index.ts` (line 56) but is NOT re-exported from `core/runner/src/index.ts` — so `import { bootstrapTracing } from "@blokjs/runner"` fails at runtime even if a trigger wanted to call it.

| File | Line(s) | What's there today |
|---|---|---|
| `core/runner/src/monitoring/TracingBootstrap.ts` | 73–168 | `bootstrapTracing()` — fully functional, zero call sites |
| `core/runner/src/monitoring/TracingBootstrap.ts` | 165 | Silent `catch {}` returns `null` when SDK packages are absent |
| `core/runner/src/monitoring/index.ts` | 56–61 | Exports `bootstrapTracing` from the monitoring sub-index |
| `core/runner/src/index.ts` | — | Does NOT re-export `bootstrapTracing`; it's unreachable via `@blokjs/runner` |
| `triggers/http/package.json` | — | No `@opentelemetry/sdk-trace-node`; no `@opentelemetry/exporter-trace-otlp-http` |
| `triggers/worker/package.json` | — | Only `@opentelemetry/api`; no trace SDK |
| `triggers/cron/package.json` | — | Only `@opentelemetry/api`; no trace SDK |
| `triggers/http/src/index.ts` | 50–76 | `App.run()` — calls `httpTrigger.listen()` and siblings; zero `bootstrapTracing` call |
| `triggers/http/src/runner/HttpTrigger.ts` | 696–774 | `listen()` — zero `bootstrapTracing` call |
| `triggers/worker/src/WorkerTrigger.ts` | 261–437 | `listen()` — zero `bootstrapTracing` call |
| `triggers/cron/src/CronTrigger.ts` | 141–204 | `listen()` — zero `bootstrapTracing` call |

### B2 — Trace context propagation is missing at every process boundary

Three boundaries where context must cross:

**Inbound HTTP requests (traceparent extraction):** `HttpTrigger.runWorkflowExecution` calls `this.tracer.startActiveSpan(workflowNameInPath, ...)` at line 1353. This creates a fresh root span on every request — it never reads a `traceparent` / `tracestate` header from the inbound HTTP request. When a downstream service or an API gateway calls Blok with a `traceparent` header (standard for B2B or inter-service calls), the Blok span starts a new root trace instead of joining the caller's trace. The fix requires `propagation.extract(context.active(), carrier)` before calling `startActiveSpan`, where `carrier` is the request headers map.

**Outbound gRPC calls (traceparent injection):** `GrpcRuntimeAdapter.execute` creates a span at line 155 (`this.tracer.startSpan(...)`) and calls `this.unaryExecute(client, request, deadlineMs)` at line 169. The `Metadata` object passed into `unaryExecute` (line 430) is built empty — no trace headers are injected. The Python/Go/Rust/Java SDK on the other end has no visibility into the Node.js trace tree. The `DistributedTracer.getTraceHeaders(span)` helper at `core/runner/src/monitoring/DistributedTracer.ts:264–274` already knows how to build a W3C `traceparent` string from a span context; the gRPC adapter ignores it. The fix is to call `propagation.inject(context.with(trace.setSpan(context.active(), span), ...), carrier)` (or use the `getTraceHeaders` helper directly) and set the resulting keys on the `Metadata` before calling `unaryExecute`.

**http-self sub-workflow dispatch (traceparent injection):** `SubworkflowNode.dispatchHttpSelf` builds a `headers` object at lines 433–441 and fires `fetch(url, { method, headers, body })`. The outbound headers contain only `content-type`, `X-Blok-Parent-Run-Id`, `X-Blok-Parent-Node-Run-Id`, and `X-Blok-Subworkflow-Depth` — no `traceparent`. A child workflow running in another process starts a new root trace. The fix is the same pattern: inject the active context into the headers map before the fetch.

`DistributedTracer` exists in `core/runner/src/monitoring/DistributedTracer.ts` with `getTraceHeaders(span)` at line 264, but it is never imported by the gRPC adapter or `SubworkflowNode`. The entire class has zero call sites outside its own file.

The `@opentelemetry/api` `propagation` module (which is already installed as a root dependency) provides `propagation.inject()` and `propagation.extract()`, which work correctly once a real `TracerProvider` with a W3C propagator is registered (standard behavior of `NodeTracerProvider`).

| File | Line(s) | What's there today |
|---|---|---|
| `triggers/http/src/runner/HttpTrigger.ts` | 1353 | `startActiveSpan(name, callback)` — no `propagation.extract()` before it; fresh root on every request |
| `core/runner/src/adapters/grpc/GrpcRuntimeAdapter.ts` | 1–4 | Imports `SpanStatusCode, Tracer, trace` from OTel API — does NOT import `context` or `propagation` |
| `core/runner/src/adapters/grpc/GrpcRuntimeAdapter.ts` | 155–166, 429–440 | Span created; `Metadata()` built empty — no `traceparent` injected |
| `core/runner/src/SubworkflowNode.ts` | 433–441 | Headers built without `traceparent`; `fetch()` called |
| `core/runner/src/monitoring/DistributedTracer.ts` | 264–274 | `getTraceHeaders(span)` builds W3C header — zero call sites outside the file |

### B4 — `RunnerSteps` emits zero OTel spans; per-step visibility is absent

`RunnerSteps.runSteps` (abstract class, `core/runner/src/RunnerSteps.ts`) is the inner loop that executes every workflow step. It has 862 lines and makes extensive use of `RunTracker` for Blok Studio trace recording (`tracker.startNode`, `tracker.completeNode`, `tracker.recordNodeAttemptFailed` at lines 330, 653, 696) but contains zero imports from `@opentelemetry/api` and zero `startSpan` / `startActiveSpan` calls. The only OTel span in the entire request path is the workflow-level span created by `HttpTrigger.runWorkflowExecution`. All steps appear as a single, undifferentiated block from the perspective of any APM tool (Grafana Tempo, Datadog, etc.).

For a fintech workflow with 10 steps — validate payment, fetch account, call pricing engine, charge card, update ledger, send receipt — only one span exists in Tempo: the workflow span. When the charge-card step hangs, Tempo shows a slow workflow span with no child spans. There is no way to identify which step caused the latency or failure without Blok Studio (which is unavailable in alerting/PagerDuty workflows).

The `DistributedTracer.startNodeSpan` / `endNodeSpan` pair at `core/runner/src/monitoring/DistributedTracer.ts:134–183` already has exactly the interface needed — it takes a `parentSpan`, sets a `SpanKind.INTERNAL` child with `blok.node.name` + `blok.node.type` attributes, calls `recordException` + `setStatus(ERROR)` on failure. Zero call sites.

| File | Line(s) | What's there today |
|---|---|---|
| `core/runner/src/RunnerSteps.ts` | 1, imports | Zero `@opentelemetry/api` imports |
| `core/runner/src/RunnerSteps.ts` | 330, 653, 696 | `tracker.startNode/completeNode/recordNodeAttemptFailed` — Blok Studio only, no OTel |
| `core/runner/src/monitoring/DistributedTracer.ts` | 134–183 | `startNodeSpan/endNodeSpan` — zero call sites |
| `triggers/http/src/runner/HttpTrigger.ts` | 1353 | Single `startActiveSpan` wraps the whole workflow — no child spans for steps |

## Goal & acceptance criteria

- **AC-B1.1** — Booting the HTTP trigger with `OTEL_EXPORTER_OTLP_ENDPOINT=http://tempo:4318` set emits at least one span to Tempo within 60s. Without the env var the trigger boots without error and emits nothing (no-op).
- **AC-B1.2** — Booting the Worker trigger with the env var set emits spans for processed jobs. Without the env var the worker boots cleanly.
- **AC-B1.3** — Booting the Cron trigger with the env var set emits spans for scheduled executions. Without the env var the cron trigger boots cleanly.
- **AC-B1.4** — SIGTERM on a trigger with tracing enabled causes a graceful `provider.forceFlush()` before exit; no spans are silently dropped.
- **AC-B1.5** — `bootstrapTracing` is importable as `import { bootstrapTracing } from "@blokjs/runner"`.
- **AC-B2.1** — A request arriving at `HttpTrigger` with a `traceparent: 00-<traceId>-<parentSpanId>-01` header produces a Blok workflow span whose parent span ID equals `<parentSpanId>` in Tempo (not a fresh root).
- **AC-B2.2** — A workflow step calling a Python/Go/Rust/Java node includes a `traceparent` metadata entry in the gRPC request. The SDK process can read `metadata.get("traceparent")` and get a valid W3C traceparent string.
- **AC-B2.3** — A `dispatch: "http-self"` sub-workflow step includes a `traceparent` header in the outbound HTTP request. The receiving process joins the trace.
- **AC-B4.1** — Each step in a workflow produces a child OTel span nested under the workflow span. Verifiable in Tempo's trace detail view: a 5-step workflow produces 1 root + 5 child spans (plus gRPC runtime spans if applicable).
- **AC-B4.2** — A step that throws produces a child span with `status=ERROR` and a `recordException` event (visible in Tempo's error event list). The span name includes the step id (`blok.step.id` attribute).
- **AC-B4.3** — A step that succeeds produces a child span with `status=OK` and `blok.step.index`, `blok.step.id`, `blok.node.type`, `blok.node.name` attributes.
- **AC-B4.4** — When `OTEL_EXPORTER_OTLP_ENDPOINT` is unset, `RunnerSteps` incurs zero OTel overhead (the no-op tracer ensures this; verify via a benchmark that shows < 1ms overhead per step with no provider).

## Design / proposed changes

### B1 — Wire `bootstrapTracing` at trigger boot

**Pattern (same for all three triggers):** In each trigger's `listen()` method, before any request is served, call `bootstrapTracing` gated on `OTEL_EXPORTER_OTLP_ENDPOINT` (or the more specific `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`). Store the result and call `result.shutdown()` during graceful shutdown.

```typescript
// New env-var-gated boot pattern (same in HTTP, Worker, Cron listen())
if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) {
  const tracingResult = await bootstrapTracing({
    serviceName: process.env.OTEL_SERVICE_NAME ?? "blok-http",  // or blok-worker, blok-cron
    exporter: "otlp",
    protocol: (process.env.OTEL_EXPORTER_OTLP_PROTOCOL as "http/protobuf" | "grpc") ?? "http/protobuf",
    samplingRatio: process.env.OTEL_SAMPLING_RATIO ? Number(process.env.OTEL_SAMPLING_RATIO) : 1.0,
  });
  if (tracingResult) {
    this.logger.log("[blok][tracing] OTLP trace export enabled");
    // Store for shutdown — the existing installShutdownHandlers drain order gains a tracing step
    this._tracingShutdown = tracingResult.shutdown;
  }
}
```

**Files to change:**
- `triggers/http/src/index.ts` — call in `App.run()` before `httpTrigger.listen()`. `App.run()` is the process entry point; this is the correct place so bootstrap happens once, before any span is created.
- `triggers/worker/src/WorkerTrigger.ts` — at the top of `listen()`, before `loadNodes()`.
- `triggers/cron/src/CronTrigger.ts` — at the top of `listen()`.
- `triggers/http/package.json`, `triggers/worker/package.json`, `triggers/cron/package.json` — add `@opentelemetry/sdk-trace-node` and `@opentelemetry/exporter-trace-otlp-http` as hard dependencies (not optional peers). The bootstrap function guards dynamic imports with a try/catch; making them hard deps ensures they are present and the dynamic import never falls through to the `null` return path in production.
- `core/runner/src/index.ts` — add re-export: `export { bootstrapTracing, resetTracingBootstrap, type TracingBootstrapConfig, type TracingBootstrapResult } from "./monitoring/TracingBootstrap";`

**Graceful shutdown integration:** `TriggerBase.installShutdownHandlers` at `core/runner/src/TriggerBase.ts` (line 453+) drains in order: `trigger.stop()` → `Janitor.stop()` → `DeferredRunScheduler.clear()` → `backend.disconnect()`. Add `tracingShutdown?.()` after `DeferredRunScheduler.clear()` and before `backend.disconnect()` so pending spans are flushed before the NATS/Redis connection closes.

**New env vars:**

| Env var | Default | Purpose |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset (no-op) | OTLP collector base URL. Gate for `bootstrapTracing`. Already read by `TracingBootstrap.ts:117`. |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | unset | Per-signal override. Already read by `TracingBootstrap.ts:116`. |
| `OTEL_SERVICE_NAME` | `blok-http` / `blok-worker` / `blok-cron` | OTel `service.name` resource attribute. Standard OTEL env var. |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` | `http/protobuf` or `grpc`. Read and passed to `bootstrapTracing.protocol`. |
| `OTEL_SAMPLING_RATIO` | `1.0` | `TraceIdRatioBasedSampler` ratio. Read and passed to `bootstrapTracing.samplingRatio`. |

**Kill-switch:** Unset `OTEL_EXPORTER_OTLP_ENDPOINT` (and `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`). Zero overhead when unset — no `bootstrapTracing` call, no SDK imported, no timer threads.

**Back-compat:** Additive. Triggers that previously got a no-op tracer continue to get a no-op tracer when the env var is unset.

### B2 — W3C traceparent propagation at process boundaries

#### B2.1 — Inbound HTTP context extraction

In `HttpTrigger.runWorkflowExecution` at line 1353, replace the bare `startActiveSpan` call with a context-propagation-aware variant:

```typescript
import { context, propagation, trace } from "@opentelemetry/api";

// Before the startActiveSpan call:
const requestHeaders = Object.fromEntries(c.req.raw.headers.entries());
const extractedContext = propagation.extract(context.active(), requestHeaders);

return this.tracer.startActiveSpan(
  workflowNameInPath,
  { kind: SpanKind.SERVER },
  extractedContext,   // <-- parent context derived from incoming traceparent header
  async (span: Span) => { /* existing body unchanged */ }
);
```

When no `traceparent` header is present, `propagation.extract` returns `context.active()` unchanged — behavior is identical to today. When `traceparent` is present and a real provider is registered, the new span becomes a child of the caller's trace.

**Files to change:** `triggers/http/src/runner/HttpTrigger.ts` — add `context, propagation, SpanKind` to the existing `@opentelemetry/api` import (line 30); update `startActiveSpan` call at line 1353.

#### B2.2 — Outbound gRPC context injection

In `GrpcRuntimeAdapter.execute` (lines 148–191) and `executeStream` (lines 218–326), inject the active OTel context into the gRPC `Metadata` before calling `unaryExecute` / `openExecuteStream`:

```typescript
import { context, propagation, trace } from "@opentelemetry/api";

// After creating the span (line 155), before calling unaryExecute:
const spanContext = trace.setSpan(context.active(), span);
const carrier: Record<string, string> = {};
propagation.inject(spanContext, carrier);
const metadata = new Metadata();
for (const [k, v] of Object.entries(carrier)) {
  metadata.set(k, v);
}
// Pass metadata to unaryExecute (currently called with an empty Metadata — line 430):
const response = await this.unaryExecuteWithMetadata(client, request, metadata, deadlineMs);
```

`unaryExecute` at line 425 builds its own `Metadata` internally; it needs to accept the caller-provided one or the injection step needs to merge into it. The cleanest change is to add a `metadata?: Metadata` parameter to `openExecuteStream` and `unaryExecute` and merge the passed entries in — backward-compatible because the parameter is optional.

The `DistributedTracer.getTraceHeaders(span)` helper (`monitoring/DistributedTracer.ts:264–274`) constructs the `traceparent` string manually. The `propagation.inject` approach is preferred because it delegates format to the registered propagator (W3C TraceContext + Baggage by default in `NodeTracerProvider`), making it forward-compatible if the operator also configures B3 or Datadog propagators.

**Files to change:** `core/runner/src/adapters/grpc/GrpcRuntimeAdapter.ts` — add `context, propagation, trace` to the OTel import (line 4); update `execute` (lines 148–191), `executeStream` (lines 218–325), and the private `unaryExecute` / `openExecuteStream` helpers to accept and use a `Metadata` parameter.

#### B2.3 — http-self sub-workflow fetch context injection

In `SubworkflowNode.dispatchHttpSelf` at lines 433–441, inject the active OTel context into the headers before calling `fetch`:

```typescript
import { context, propagation } from "@opentelemetry/api";

// After building the base headers (line 441), before fetch:
propagation.inject(context.active(), headers);
// headers now contains "traceparent" (and optionally "tracestate") if a provider is registered
fetch(url, { method, headers, body });
```

When no provider is registered, `propagation.inject` is a no-op — zero overhead.

**Files to change:** `core/runner/src/SubworkflowNode.ts` — add `context, propagation` import; update `dispatchHttpSelf` header assembly at lines 433–441.

### B4 — Per-step OTel spans in `RunnerSteps`

`RunnerSteps.runSteps` already has a clean per-step loop. The step's `RunTracker.startNode` call at line 330 is the natural hook point. Wrap each step's `step.process(ctx, step)` call in a child span:

```typescript
import { SpanKind, SpanStatusCode, context, trace } from "@opentelemetry/api";

const stepTracer = trace.getTracer("@blokjs/runner.steps", "1.0.0");

// Inside the per-step loop, after tracker.startNode() (line 330):
const stepSpan = stepTracer.startSpan(`step ${step.name}`, {
  kind: SpanKind.INTERNAL,
  attributes: {
    "blok.step.id": step.name,
    "blok.step.index": i,
    "blok.node.name": step.name,
    "blok.node.type": stepType,
    ...(stepAny.runtime ? { "blok.runtime.kind": stepAny.runtime as string } : {}),
  },
});

const stepCtx = trace.setSpan(context.active(), stepSpan);
try {
  await context.with(stepCtx, () => step.process(ctx, step));  // step execution inside span context
  stepSpan.setStatus({ code: SpanStatusCode.OK });
} catch (err) {
  stepSpan.recordException(err instanceof Error ? err : new Error(String(err)));
  stepSpan.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
  throw err;  // existing error handling path unchanged
} finally {
  stepSpan.end();
}
```

**Critical nuance:** `context.with(stepCtx, callback)` sets the active context for the duration of the callback, so `GrpcRuntimeAdapter.execute` — called inside `step.process` — will call `this.tracer.startSpan(...)` with the step span as the active context. This means the gRPC span automatically nests under the step span once B2.2 is applied. The span hierarchy in Tempo becomes:
```
workflow-span (HttpTrigger)
  └─ step "fetch-user" span (RunnerSteps B4)
       └─ grpc.python3.Execute span (GrpcRuntimeAdapter)
  └─ step "charge-card" span (RunnerSteps B4)
       └─ grpc.go.Execute span (GrpcRuntimeAdapter)
```

**Files to change:** `core/runner/src/RunnerSteps.ts` — add `SpanKind, SpanStatusCode, context, trace` import from `@opentelemetry/api`; add the span-wrapping logic around `step.process(ctx, step)` in the step loop.

**Overhead control:** The `trace.getTracer()` call and `startSpan()` + `end()` pair are no-ops when no provider is registered (guaranteed by the OTel API spec). This gives free-running deployments zero overhead.

## Tasks (SDD breakdown)

**T1. Export `bootstrapTracing` from `@blokjs/runner` public index**
- File: `core/runner/src/index.ts`
- Change: add `export { bootstrapTracing, resetTracingBootstrap, type TracingBootstrapConfig, type TracingBootstrapResult } from "./monitoring/TracingBootstrap";`
- Acceptance: `import { bootstrapTracing } from "@blokjs/runner"` resolves without error in a trigger package.
- Effort: 0.25 eng-days

**T2. Add `@opentelemetry/sdk-trace-node` + `@opentelemetry/exporter-trace-otlp-http` to trigger packages**
- Files: `triggers/http/package.json`, `triggers/worker/package.json`, `triggers/cron/package.json`
- Change: add both packages as hard dependencies at the same `^1.x` / `^0.57.x` version range used by sibling OTel packages. Run `bun install`.
- Acceptance: `ls node_modules/@opentelemetry/sdk-trace-node` and `ls node_modules/@opentelemetry/exporter-trace-otlp-http` resolve in the workspace.
- Effort: 0.25 eng-days

**T3. Call `bootstrapTracing` at HTTP trigger boot (`triggers/http/src/index.ts`)**
- File: `triggers/http/src/index.ts` — `App.run()` method
- Change: before `this.httpTrigger.listen()`, call `bootstrapTracing(...)` gated on `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`. Store `shutdown` function and add it to the SIGTERM drain order (wire into `installShutdownHandlers` via a stored callback on `App`).
- Acceptance: booting `App.run()` with `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` logs `[blok][tracing] OTLP trace export enabled`; booting without the env var produces no log line and no error.
- Effort: 0.5 eng-days

**T4. Call `bootstrapTracing` at Worker and Cron trigger boot**
- Files: `triggers/worker/src/WorkerTrigger.ts` (`listen()` preamble), `triggers/cron/src/CronTrigger.ts` (`listen()` preamble)
- Change: same pattern as T3. For Worker: add `_tracingShutdown` field, call in `listen()` preamble before `loadNodes()`, wire into the existing shutdown drain at the appropriate point. For Cron: identical pattern.
- Acceptance: same gated-log assertion for Worker and Cron; Cron's `listen()` tests still pass.
- Effort: 0.5 eng-days

**T5. Extract inbound W3C `traceparent` in `HttpTrigger.runWorkflowExecution` (B2.1)**
- File: `triggers/http/src/runner/HttpTrigger.ts` — `runWorkflowExecution` (~line 1353)
- Change: add `context, propagation, SpanKind` to the existing `@opentelemetry/api` import; extract incoming context with `propagation.extract(context.active(), headersMap)` and pass the result as the third argument to `startActiveSpan`.
- Acceptance: a unit test sends a request with `traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01` and asserts the resulting span's `parentSpanId` equals `00f067aa0ba902b7` (requires a test-mode provider that records spans).
- Effort: 0.75 eng-days

**T6. Inject `traceparent` into outbound gRPC Metadata and http-self headers (B2.2 + B2.3)**
- Files:
  - `core/runner/src/adapters/grpc/GrpcRuntimeAdapter.ts` — `execute()`, `executeStream()`, `unaryExecute()`, `openExecuteStream()`
  - `core/runner/src/SubworkflowNode.ts` — `dispatchHttpSelf()`
- Changes:
  - gRPC adapter: add `context, propagation, trace` to OTel import; after creating the step span, build a carrier via `propagation.inject(trace.setSpan(context.active(), span), carrier)`; merge carrier into a new `Metadata` and pass it down to `unaryExecute` / `openExecuteStream`. Update private helper signatures to accept `metadata?: Metadata`.
  - SubworkflowNode: add `context, propagation` import; call `propagation.inject(context.active(), headers)` after line 441.
- Acceptance:
  - gRPC: a test-mode provider captures the span; the `Metadata` object passed to `unaryExecute` contains a `traceparent` key with the correct format.
  - http-self: intercept the `fetch` call in a test and assert the `traceparent` header is present and non-empty.
- Effort: 1.0 eng-day

**T7. Add per-step child spans in `RunnerSteps.runSteps` (B4)**
- File: `core/runner/src/RunnerSteps.ts`
- Change: add `SpanKind, SpanStatusCode, context, trace` import; acquire a module-level tracer `const stepTracer = trace.getTracer("@blokjs/runner.steps", "1.0.0")`; wrap the `step.process(ctx, step)` call in a `context.with(trace.setSpan(context.active(), stepSpan), ...)` block; record exception + set `ERROR` status on throw; call `stepSpan.end()` in `finally`. Add `blok.step.id`, `blok.step.index`, `blok.node.type`, `blok.node.name`, `blok.runtime.kind` attributes.
- Acceptance:
  - A test-mode `NodeTracerProvider` captures spans for a 3-step workflow; assertions confirm 3 child spans with correct names and attributes.
  - A step that throws produces a span with `status=ERROR` and an exception event.
  - When no provider is registered, step execution timing is indistinguishable from pre-patch (OTel no-op guarantee; verify with a benchmark that shows < 2% overhead vs. baseline).
- Effort: 2.0 eng-days (the loop has complex branching — flow nodes, sub-workflows, wait steps, retry loops — all need correct span lifecycle management)

## Tests

**Unit — T1 export:**
- `core/runner/__tests__/unit/monitoring/TracingBootstrap.export.test.ts`: `import { bootstrapTracing } from "@blokjs/runner"` resolves; is a function.

**Unit — T5 propagation extract:**
- `triggers/http/__tests__/unit/runner/HttpTrigger.tracing.test.ts`: mock `NodeTracerProvider` via `@opentelemetry/sdk-trace-base`'s `InMemorySpanExporter`; fire a request with `traceparent` header; assert the span recorded by the exporter has the correct `parentSpanId`.

**Unit — T6 gRPC injection:**
- `core/runner/__tests__/unit/adapters/grpc/GrpcRuntimeAdapter.tracing.test.ts`: mock `unaryExecute` to capture the `Metadata` argument; assert `metadata.get("traceparent")[0]` matches the active span's context in W3C format.

**Unit — T6 http-self injection:**
- `core/runner/__tests__/unit/SubworkflowNode.tracing.test.ts`: spy on global `fetch`; call `dispatchHttpSelf`; assert the captured request headers include `traceparent`.

**Unit — T7 per-step spans:**
- `core/runner/__tests__/unit/RunnerSteps.tracing.test.ts`: install an `InMemorySpanExporter`; run a 3-step workflow through `runSteps`; assert 3 child spans with correct `blok.step.id` and `blok.step.index` attributes; run a failing-step workflow and assert the error span has `status=ERROR` and an exception event.

**Integration — end-to-end:**
- Boot the HTTP trigger with `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` pointing at a `docker compose` Tempo instance.
- Send a `POST /test-workflow` request.
- Query `GET http://localhost:3200/api/traces` (Tempo query API) and assert at least one trace exists with service name `blok-http`.
- Assert the trace contains a root span (workflow) and child spans (steps + gRPC spans if a runtime node was exercised).

## Back-compat, kill-switches & defaults

| Item | Default | Kill-switch / opt-out |
|---|---|---|
| OTLP trace export | OFF (no-op) | Unset `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` |
| Service name | `blok-http` / `blok-worker` / `blok-cron` | Override via `OTEL_SERVICE_NAME` |
| OTLP protocol | `http/protobuf` | `OTEL_EXPORTER_OTLP_PROTOCOL=grpc` |
| Sampling ratio | `1.0` (sample everything) | `OTEL_SAMPLING_RATIO=0.1` (10%) |
| Per-step spans (B4) | ON when a provider is registered | No dedicated kill-switch — follows the top-level `OTEL_EXPORTER_OTLP_ENDPOINT` gate; no provider = no spans |
| W3C propagation extract (B2.1) | ON when a provider is registered | `propagation.extract` is a no-op without a real propagator; unset the endpoint |
| gRPC Metadata injection (B2.2) | ON when a provider is registered | Same gate |
| http-self header injection (B2.3) | ON when a provider is registered | Same gate |
| Tracing shutdown flush | Part of the existing SIGTERM drain | `BLOK_GRACEFUL_SHUTDOWN_DISABLED=1` skips the whole drain (existing kill-switch) |

**BREAKING CHANGE — none.** All changes are additive or gated on `OTEL_EXPORTER_OTLP_ENDPOINT` being set. Deployments that have never set that env var see zero behavior change. The only visible surface change is the `bootstrapTracing` export appearing in `@blokjs/runner`'s public index, which is purely additive.

**Dependency note:** Adding `@opentelemetry/sdk-trace-node` and `@opentelemetry/exporter-trace-otlp-http` as hard deps to trigger packages increases the bundle size by approximately 300–400 KB (both packages are tree-shakeable; the actual loaded bytes on a cold start are bounded by what `bootstrapTracing` imports). Operators who use the `BLOK_TRACE_ENABLED=false` + unset-endpoint path add these to disk but never execute the import.

## Risks & open questions

1. **`@opentelemetry/exporter-trace-otlp-grpc` peer dep:** The bootstrap function supports gRPC OTLP (`OTEL_EXPORTER_OTLP_PROTOCOL=grpc`) via a separate package that this epic does NOT add as a hard dep. If an operator sets the protocol to gRPC, the dynamic import fails silently and tracing is a no-op. Decision needed: add `@opentelemetry/exporter-trace-otlp-grpc` as a hard dep too, or document the manual install step. Recommendation: add it as a hard dep alongside http for consistency; gRPC-to-Tempo is common in Kubernetes deployments.

2. **Span attribute value caps and PII:** Step inputs/outputs are currently NOT added as span attributes (this epic follows the `recordPayloads: false` default from `DistributedTracer`). If a future epic adds payload attributes for easier debugging, PII scrubbing must be in place first. Explicitly out of scope here.

3. **`RunnerSteps` loop complexity around flow nodes:** The step loop has a `flow` branch that calls `step.processFlow(ctx)` and then recursively calls `runSteps`. Span lifecycle inside flow nodes (if/else branches, forEach iterations) needs careful handling to avoid orphaned unclosed spans. The recommended approach is to NOT wrap flow node dispatch itself in a span (only leaf `step.process(ctx, step)` calls), but validate that `step.processFlow` calls do not bypass the try/finally span end.

4. **Sub-workflow in-process dispatch:** When `dispatch` is `"in-process"` (the default), `SubworkflowNode.run` calls `runner.run()` which calls `runSteps` which creates child spans. These will nest under whatever span is active in the parent's step context, which is correct. The `wait: false` path runs via `setImmediate` — the OTel context is NOT automatically propagated across `setImmediate` boundaries. A `context.with(...)` wrapper around the `setImmediate` callback may be needed to preserve parent context. This is a follow-up investigation item.

5. **Multi-process `OTEL_EXPORTER_OTLP_ENDPOINT` collision:** Two deployments sharing one Tempo instance can produce trace ID collisions if trace IDs are not globally unique. This is handled by OTel's `TraceIdRatioBasedSampler` and the W3C 128-bit trace ID spec. No special action required.

6. **Open question — `OTEL_SERVICE_NAME` per-trigger:** In a mono-repo where HTTP + Worker share one process (co-hosted on port 4000), a single `OTEL_SERVICE_NAME` covers both. In separate processes, the operator sets distinct names. Should we auto-suffix with the trigger type (`blok-http`, `blok-worker`, `blok-cron`) when `OTEL_SERVICE_NAME` is unset? Current proposal: yes (see T3/T4 defaults). Confirm before implementation.

## Out of scope / follow-ups

- **OBS-01** (log/Loki correlation) — `trace_id` / `span_id` injection into log lines. This epic is a prerequisite; OBS-01 can extract the active span context via `trace.getActiveSpan()` once B4's `context.with` wrapping is in place.
- **`@opentelemetry/exporter-trace-otlp-grpc` as a hard dep** — noted in risks; decision deferred to implementer.
- **`wait: false` in-process sub-workflow context propagation** — requires wrapping the `setImmediate` callback in `context.with(context.active(), ...)`.
- **Baggage propagation** — once the W3C propagator is registered, `Baggage` can carry per-tenant context across all process boundaries. Useful for rate-limit keys, tenant IDs in fintech contexts. Follow-up epic.
- **Span sampling configuration per workflow** — the current design applies one ratio globally. Per-workflow sampling (e.g., 100% on payment workflows, 10% on health-check workflows) requires a custom `Sampler` implementation.
- **Studio ↔ Tempo deep-link** — linking a Blok Studio run to its Tempo trace URL. Requires storing the `traceId` on `WorkflowRun` at start time and surfacing it in the Studio UI. Follow-up to this epic after traces are confirmed to land in Tempo.
- **Metrics bridge for trace-derived RED metrics** — `requests`, `errors`, `duration` per workflow, derived from span data rather than from the existing Prometheus counters. Follow-up.
