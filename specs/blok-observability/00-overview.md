# OBS-00 — Blok Observability: Overview & Architecture

> **Status:** PROPOSED · **Initiative:** 100% error observability for production (multi-replica Kubernetes) · **Total effort:** ~41.5 eng-days across 6 epics / 50 tasks · **Produced:** 2026-06-23 from a code-grounded audit of `main`.

This is the master spec for bringing Blok's observability from *"an excellent local trace UI plus a `/metrics` endpoint"* to **production-grade, ~100% error observability** on a horizontally-scaled deployment. It is the entry point; read it first, then the per-epic specs ([`01`](01-metrics-correctness-and-coverage.md)–[`06`](06-kubernetes-deployment-and-error-holes.md)).

> **Why this is not optional.** Blok is the orchestration layer for a money-moving fintech (see [[paga-eu-project]]). A billing saga, a Pix-settlement webhook, or a cross-language pricing node that fails **silently** is a financial incident, not a log line. The bar is: **no error class can happen without being captured, queryable, and alertable.**

---

## 1. The thesis (the one thing to internalize)

Blok has **two observability planes**, and they are in very different states:

- **The recording plane is excellent.** `RunTracker → Blok Studio` records every run (12 states) and every node (inputs, outputs, a rich `RunErrorDetail`, retry attempts, gRPC wire metrics) into a SQLite/Postgres store, surfaced over `/__blok/*` REST + SSE. This is the strongest part of the framework. **We do not rewrite it.**
- **The export plane is a field of present-but-unwired components.** The Grafana/Loki/Tempo stack is configured in `infra/` YAML but **fed by almost nothing**: distributed tracing emits to a **no-op provider** (`bootstrapTracing` has zero trigger call-sites and the OTLP SDK isn't installed), the `monitor`/`profile` CLIs query a **legacy metric family**, and **logs never reach Loki** (no shipper, prod sets `CONSOLE_LOG_ACTIVE=false`, no `run_id`/`trace_id` correlation key).

**Corollary:** the road to 100% error observability is **mostly plumbing on machinery that already exists** — wire the feeds, fix the names, close a handful of genuine holes. Only one item (the multi-replica Studio SSE bus, [OBS-04](04-trace-store-durability-and-studio.md) T-bus) is a real architectural lift.

---

## 2. Definition: what "100% error observability" means here

An error is **observable** only if it satisfies **all five** signals. Recording alone (today's strength) is necessary but not sufficient — you cannot alert on a SQLite row.

| Signal | Question it answers | Today's vehicle |
|---|---|---|
| **R — Recorded** | "Can I see this failure, with full context, after the fact?" | RunTracker / Studio (`RunErrorDetail`) |
| **M — Metrized** | "Can I count it, rate it, and alert on it?" | Prometheus `blok_*` counters/histograms |
| **T — Traced** | "Can I see the failing span in the request's distributed trace?" | OTel span + `recordException` → Tempo |
| **L — Logged+correlated** | "Can I jump from the trace/run to the exact log lines?" | structured log w/ `run_id`+`trace_id` → Loki |
| **A — Alertable** | "Does a human get paged when this spikes?" | Prometheus rule → Alertmanager / Sentry / webhook |

### 2.1 The Error-Coverage Matrix (the acceptance spine of this initiative)

Every failure mode Blok can produce, its **current** coverage, and the epic that closes each gap. `✅` shipped · `⚠️` partial · `❌` absent.

| # | Failure mode | R | M | T | L | A | Closed by |
|---|---|:-:|:-:|:-:|:-:|:-:|---|
| 1 | Node logic error (thrown `Error`/`GlobalError`) | ✅ | ⚠️ legacy | ❌ | ⚠️ | ❌ | 01, 02, 03, 05 |
| 2 | Zod input/output validation (400) | ✅ | ⚠️ | ❌ | ⚠️ | ❌ | 01, 02, 05 |
| 3 | Step timeout → `timedOut` | ✅ | ❌ | ❌ | ⚠️ | ❌ | 01, 04, 05 |
| 4 | Crash: `uncaughtException`/`unhandledRejection` → `crashed` | ⚠️ root cause absorbed | ❌ | ❌ | ⚠️ | ❌ | 06 (T8), 04, 05 |
| 5 | **OOM / SIGKILL** (orphan, ~2min blind window) | ⚠️ late | ❌ | ❌ | ❌ | ❌ | 06 (cAdvisor/kubelet) |
| 6 | Cooperative cancellation → `cancelled` | ✅ | ❌ | ❌ | ⚠️ | ❌ | 04, 05 |
| 7 | Concurrency throttle → `throttled` | ✅ | ✅ `blok_concurrency_denied_total` | ❌ | ⚠️ | ⚠️ no rule | 05 (alert), 04 (SSE) |
| 8 | **Mapper miscompile** (`warn` mode passes literal through) | ❌ not flipped to failed | ❌ | ❌ | ⚠️ warn log | ❌ | 01 (counter) + policy |
| 9 | **gRPC runtime node error/panic** (Go/Rust/Python/…) | ✅ lossless | ❌ invisible | ❌ severed | ⚠️ | ❌ | 01 (B3), 02 (B2) |
| 10 | Fire-and-forget (`wait:false`) child failure | ⚠️ child only | ❌ `console.error` | ❌ | ❌ | ❌ | 05 (T6) |
| 11 | **Pre-`startRun` boot/config failure** (parse, `assertNoSetVar`, `Configuration.init`, middleware-not-found) | ❌ no record | ❌ | ❌ | ⚠️ suppressed in prod | ❌ | 06 (T9) |
| 12 | Webhook signature/verify rejection (401) | ⚠️ counter | ✅ `blok_webhook_rejected_total` | ❌ | ⚠️ | ❌ | 05 (alert) |
| 13 | Self-failures (trace-store write, Janitor sweep, PG queue) | ❌ | ❌ | ❌ | ❌ | ❌ | 06 (T10) |

**Definition of Done for the initiative:** every row above is `R✅ M✅ T✅ L✅ A✅` (T is "no-op-when-OTLP-unset" tolerant), verified by the per-epic acceptance tests. Rows **4, 5, 8, 11** are the genuinely-invisible failures today and are the highest priority — a crash, an OOM, a silent data-flow miscompile, or a boot failure currently leaves **zero** alertable signal.

---

## 3. The six epics

| Epic | Title | Phase | Effort | Tasks | Depends on |
|---|---|---|---|---|---|
| [OBS-01](01-metrics-correctness-and-coverage.md) | Metrics: correctness, naming standard & full coverage | mixed | ~5d | 7 | none |
| [OBS-02](02-distributed-tracing-otel-tempo.md) | Distributed tracing (OpenTelemetry → Tempo) | 1 + targeted | ~5.5d | 7 | none |
| [OBS-03](03-logs-to-loki-and-correlation.md) | Logs → Loki & correlation | mixed | ~6d | 7 | OBS-02 (`trace_id`) |
| [OBS-04](04-trace-store-durability-and-studio.md) | Trace store durability & real-time Studio | mixed | ~7.5d | 9 | none |
| [OBS-05](05-alerting-and-error-sinks.md) | Alerting & push-based error sinks | mixed | ~8d | 8 | OBS-01, OBS-02 |
| [OBS-06](06-kubernetes-deployment-and-error-holes.md) | Kubernetes deployment, scrape wiring & error holes | mixed | ~9.5d | 12 | OBS-01, OBS-05 |

### 3.1 Dependency graph & wave sequencing

```
Wave 1 (parallel, no deps — the foundations):
  OBS-01 metrics ───────────────┐
  OBS-02 tracing ──────┐        │
  OBS-04 store/studio  │        │
                       │        │
Wave 2:                ▼        ▼
  OBS-03 logs/loki (needs OBS-02 trace_id)
  OBS-05 alerting  (needs OBS-01 metrics + OBS-02 scrape health)
                            │
Wave 3:                     ▼
  OBS-06 k8s + error holes (needs OBS-01 runtime metrics + OBS-05 alert rules)
```

**Recommended order:** ship **Wave 1 in full first** — it's almost entirely plumbing on existing machinery and removes the two *actively-misleading* defects (the all-legacy `monitor` dashboard reads as "no errors" when it means "no data"; the default in-memory trace store loses everything on restart). Then **OBS-02 B1+B2 + OBS-05 B5** deliver the biggest single jump toward 100% (traces flow, connect across languages, and errors push to Sentry/webhooks). **OBS-06** closes the invisible-failure holes (rows 4/5/11/13) and makes a vanilla `helm install` production-capable.

---

## 4. Cross-cutting standards (apply to every epic)

1. **Canonical metric namespace = `blok_*` on meter `"blok"`.** The legacy un-prefixed family on meter `"default"` (`workflow`, `node`, `node_time`, …) is **retired** (OBS-01 T1/T5). One source of truth: the naming doc in OBS-01 T1. Latency across replicas is `histogram_quantile(…, rate(blok_workflow_duration_seconds_bucket[5m]))` — **never** the per-process `blok_trigger_latency_p99` gauge.
2. **No-op-when-unset for OTLP.** Distributed tracing/log-export must add **zero overhead** and never error when `OTEL_EXPORTER_OTLP_ENDPOINT` (and friends) are unset. Production opt-in via env, dev stays clean.
3. **Kill-switches for every new subsystem**, mirroring the existing `BLOK_*_DISABLED` convention.
4. **Correlation triad on everything:** `run_id` (trace store) ⇄ `trace_id`/`span_id` (OTel) ⇄ Loki labels. This is what makes Studio ↔ Tempo ↔ Loki one joined experience (OBS-03 T2/T6).
5. **Multi-replica-first.** Any per-process state (the Studio SSE bus, p-gauges, the in-memory webhook registry, the in-memory trace store) is treated as a bug for production — each epic names its cross-process backend (Postgres / Redis / NATS), reusing the existing `createConcurrencyBackend` pattern.

### 4.1 Breaking default changes (release-note material)

These ship as deliberate hardening; flag them in the release that lands them:

- **`BLOK_TRACE_STORE` default `"memory"` → `"sqlite"`** outside test (OBS-04 T1) — traces survive restart by default.
- **`CONSOLE_LOG_ACTIVE` removed/`true` in the production compose** (OBS-03 T3) — logs are emitted so a shipper can collect them.
- **`@opentelemetry/sdk-trace-node` + OTLP exporter become hard deps** of the trigger packages (OBS-02 T2) — small install-size increase; required for traces to ever flow.
- **OBS-06 may flip `monitoring.enabled` Helm default** — discuss before shipping (a vanilla install gaining a ServiceMonitor changes operator expectations).

---

## 5. Risk & effort summary

| Risk | Mitigation |
|---|---|
| Two metric families during migration cause double-counting | OBS-01 retires legacy in one PR (T5) after CLIs + dashboards move (T6/T7); alias for one minor if needed |
| OTLP hard-deps bloat the bundle | Exporter is ~small; gated init means zero runtime cost when unused; revisit lazy `import()` if size matters |
| `CONSOLE_LOG_ACTIVE=true` floods logs | Pair with `BLOK_LOG_LEVEL` (StructuredLogger already supports it, OBS-03 T1) |
| Multi-replica SSE bus is large | Isolated as its own task; Studio degrades gracefully to per-pod until it lands |
| Breaking defaults surprise existing deployments | All kill-switchable; consolidated release-notes section (§4.1) |

**Total: ~41.5 eng-days / 50 tasks.** Wave 1 (~17.5d) delivers the misleading-defect fixes + real traces + durable store. Waves 2–3 (~24d) close the remaining matrix rows and the k8s story.

---

## 6. How to use this workspace

1. Read this overview + §2.1 matrix (the acceptance spine).
2. Approve epics **individually** — they're independent within their wave. Tell me e.g. *"do OBS-01 and OBS-02"* and I implement code + tests per the task breakdown, one PR per epic (or per task for the larger ones).
3. Each epic's **Tasks** section is the SDD unit of work — small enough for one PR / one agent, ordered by dependency, each with its own acceptance check.
4. Nothing here has touched runtime source — these are proposals. The recording layer is intentionally left alone.

**Verification north star:** the initiative is done when a chaos test that injects each of the 13 failure modes in §2.1 produces, for every one, a Studio record **and** a Prometheus metric increment **and** a Tempo span with the exception **and** a correlated Loki log line **and** a firing alert.
