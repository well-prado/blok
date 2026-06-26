# Blok Modular Observability — Specification

`specs/blok-modular-observability/README.md`

## 1. Problem

Every Blok project scaffolded with `blokctl create` unconditionally receives:
- The full `infra/metrics/` stack (Prometheus, Grafana, Loki, Tempo, Alertmanager, nginx) — copied wholesale in `packages/cli/src/commands/create/project.ts`.
- Always-on Prometheus metrics: `triggers/http/src/runner/metrics/opentelemetry_metrics.ts` builds an exporter and calls `metrics.setGlobalMeterProvider()` **at import time**, with an ungated `/metrics` route in `HttpTrigger.ts`, force-loaded via `--preload` in the trigger Dockerfiles.

There is no way to opt out, opt in selectively, or retrofit a module later. This couples every project to heavy monitoring infra.

## 2. Goals

1. Make all 7 observability concerns (obs-stack, tracing, trace-store, metrics, logging, alerting, error-sink) **selectable at create** and **retrofittable** via `blokctl observability add`.
2. **Zero footprint** for unselected modules.
3. **Backward-compatible default**: metrics stay ON; the only behavior change (create default obs-stack = none) is documented with a one-command restore path.
4. **Minimal core change**: only the metrics gate touches the runner.

## 3. Architecture

### 3.1 The descriptor (owned by MO-CLI)

`packages/cli/src/commands/observability/descriptor.ts` defines the ONE `ObservabilityModuleDescriptor` interface (id, label, description, dependencies, envBlock, infraFiles, composeServices, packageDeps, optional scaffold/setup/verify/validate/cleanup). A registry maps the 7 module ids to descriptor constants. The three drifted shapes (`ObservabilityModuleDescriptor` / `ObservabilityModule` / `TierSpec`) are collapsed into this one. Module epics only *fill in their descriptor's values + hooks* — they never re-declare the interface or the CLI framework.

### 3.2 Config + remove contract

`.blok/config.json` gains `observability?: Record<string, { enabled; addedAt; version? }>`. The **remove contract** (defined up-front in M1): config entry + env block reversed; infra files left in place with a printed note unless the descriptor's `cleanup()` removes them.

### 3.3 CLI (cloned from `runtime/`)

`blokctl observability add|remove|list|status`, cloned from the proven `packages/cli/src/commands/runtime/{add,index,list,remove,shared}.ts` retrofit pattern (idempotent `resolveProjectRoot`→`readConfigSafe`→picker→scaffold→config/env merge, `isNonInteractive`, `parseCommaSeparated`, `--force`, `--yes`). Create-time `--observability=a,b` multi-select wires the same descriptors.

### 3.4 Env convention

**`BLOK_METRICS_DISABLED=1`** is the canonical metrics opt-out (default unset = ON). Matches the existing `BLOK_TRACING_DISABLED` / `BLOK_GRACEFUL_SHUTDOWN_DISABLED` / `BLOK_SCHEDULING_DISABLED` / `BLOK_JANITOR_DISABLED` family. The drifted `BLOK_METRICS_ENABLED` is rejected everywhere. Existing live vars `BLOK_METRICS_PORT` / `BLOK_METRICS_PER_KEY` are untouched. Module env blocks are **inert by default** (e.g. tracing's OTLP endpoint is written commented out) so adding a module never silently turns it on against a dead backend.

## 4. The metrics gate (the one core change)

1. Move exporter + MeterProvider + `setGlobalMeterProvider()` out of import-time into a gated `bootstrapMetrics()` returning `null` when `BLOK_METRICS_DISABLED=1` — **no import-time side-effect**.
2. `HttpTrigger.listen()` calls it; `/metrics` registered only when non-null.
3. Remove `--preload` from the **4 real** Dockerfiles (`triggers/http/Dockerfile` + `.dev`, `triggers/sse/Dockerfile` + `.dev`).
4. SSE has no metrics source (`triggers/sse/src/runner/` does not exist) → its preload line is already dead, just delete it. The gRPC metrics file (`triggers/grpc/src/opentelemetry_metrics.ts`) is unimported and gRPC has no Dockerfile → **delete** it.
5. Gate the **scaffolded** project too: `create/project.ts:521` copies the runner metrics file and `:442` copies the trigger Dockerfile into user projects — the copied Dockerfile must drop the preload and the copied runner file must be the gated version, or `--obs-stack=none` drops them.

**Keystone test:** importing the module with `BLOK_METRICS_DISABLED=1` registers **NO** global MeterProvider — not merely 'no /metrics route' (removing preload alone is cosmetic).

## 5. Module surfaces

| Module | Core change | What scaffolds |
|---|---|---|
| obs-stack | none | tiered `infra/metrics` copy (none/lite/full) |
| tracing | none (already wired) | inert env + optional `tempo.yaml` |
| trace-store | none (sqlite already default) | inert env; Postgres compose/Helm; Studio SSE completeness |
| metrics | **the gate** | env note; the gated bootstrap |
| logging | none (DefaultLogger already structured) | `alloy-config.alloy` + alloy compose service + env |
| alerting | none | rules + Alertmanager + Helm PrometheusRule (promtool-verified) |
| error-sink | one hook line | generic `ErrorSink` + Sentry adapter behind `SENTRY_DSN` |

## 6. Trace-store / Studio completeness (rides on M2)

- `createStore.ts:42-44` already defaults to sqlite outside test — verification + tests only.
- Studio `EVENT_TYPES` (`apps/studio/src/lib/sse.ts:40`) is 9 of the 21 `RunEventType` members — expand to a type-checked `readonly RunEventType[]`.
- `TraceRouter.ts` per-run auto-close leaks its heartbeat/listener — clear the interval + remove the listener before `res.end()`.
- Helm sqlite default must stay **implicit** (never emit `BLOK_TRACE_STORE=sqlite`) so read-only-rootfs operators fall back to memory-with-warning instead of a hard throw.

## 7. Out of scope

Custom non-Sentry error-sink adapters (interface is generic, only Sentry ships); per-module split compose files (single compose, services trimmed by tier); logger-implementation swap in core (DefaultLogger stays). Already-created projects stay always-on (documented — they opted in implicitly).

## 8. Acceptance (capstone)

`blokctl create --obs-stack=lite --observability=tracing,error-sink` builds and contains ONLY those modules' files/services/env; unselected modules leave no footprint; `BLOK_METRICS_DISABLED` round-trips; a `none` project emits no `/metrics` and ships no `infra/metrics`.