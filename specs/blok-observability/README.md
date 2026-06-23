# Blok Observability — SPEC Workspace

> **Status:** PROPOSED — awaiting epic-by-epic approval. **Nothing in runtime source has been changed.**
> **Goal:** ~100% **error observability** for production (multi-replica Kubernetes) — every failure mode Recorded, Metrized, Traced, Logged-with-correlation, and Alertable.
> **Produced:** 2026-06-23 via a code-grounded audit + a multi-agent spec-authoring pass (6 epics, re-verified against `main`).

## Start here

**Read [`00-overview.md`](00-overview.md) first** — the thesis, the measurable definition of "100% error observability," the **Error-Coverage Matrix** (§2.1, the acceptance spine), the dependency graph, and the wave sequencing.

## The thesis in one line

The **recording plane** (RunTracker → Studio) is excellent and stays untouched; the **export plane** (Grafana/Loki/Tempo) is configured in YAML but **fed by almost nothing**. This initiative wires the feeds, fixes the metric names, and closes a handful of genuinely-invisible failure holes (crash / OOM / mapper miscompile / pre-boot). Mostly plumbing on machinery that already exists.

## The six epics

| Epic | Title | Phase | Effort | Tasks | Depends on |
|---|---|---|---|---|---|
| [00](00-overview.md) | Overview & Architecture (read first) | — | — | — | — |
| [01](01-metrics-correctness-and-coverage.md) | Metrics: correctness, naming standard & full coverage | mixed | ~5d | 7 | none |
| [02](02-distributed-tracing-otel-tempo.md) | Distributed tracing (OpenTelemetry → Tempo) | 1 + targeted | ~5.5d | 7 | none |
| [03](03-logs-to-loki-and-correlation.md) | Logs → Loki & correlation | mixed | ~6d | 7 | OBS-02 |
| [04](04-trace-store-durability-and-studio.md) | Trace store durability & real-time Studio | mixed | ~7.5d | 9 | none |
| [05](05-alerting-and-error-sinks.md) | Alerting & push-based error sinks | mixed | ~8d | 8 | OBS-01, OBS-02 |
| [06](06-kubernetes-deployment-and-error-holes.md) | Kubernetes deployment, scrape wiring & error holes | mixed | ~9.5d | 12 | OBS-01, OBS-05 |

**Total: ~41.5 eng-days · 50 tasks.**

## Suggested sequencing (waves)

- **Wave 1 (parallel, no deps):** OBS-01, OBS-02, OBS-04 — removes the two *actively-misleading* defects (all-legacy `monitor` dashboard; ephemeral default trace store) and makes traces actually flow.
- **Wave 2:** OBS-03 (needs OBS-02's `trace_id`), OBS-05 (needs OBS-01's metrics).
- **Wave 3:** OBS-06 — closes the invisible-failure holes and makes a vanilla `helm install` production-capable.

## Each spec follows the house template

TL;DR → Problem/current state (with a **file:line evidence table**) → Goal & acceptance criteria → Design / proposed changes → **Tasks (SDD breakdown)** → Tests → Back-compat/kill-switches/defaults → Risks & open questions → Out of scope. The **Tasks** section is the unit of work: each task is sized for one PR / one agent with its own acceptance check.

## Breaking default changes (when these land)

`BLOK_TRACE_STORE` default `memory→sqlite` (OBS-04); `CONSOLE_LOG_ACTIVE` no longer `false` in prod compose (OBS-03); OTel SDK becomes a hard dep (OBS-02); possible `monitoring.enabled` Helm default flip (OBS-06). All kill-switchable. See [`00-overview.md` §4.1](00-overview.md).

## Approval

Epics are independent within their wave. Tell me which to implement (e.g. *"do OBS-01 and OBS-02"*, *"all of Wave 1"*) and I'll produce code + tests per the task breakdown, one PR per epic. Related: the shipped bug-fix specs in [`../blok-framework-fixes/`](../blok-framework-fixes/README.md).
