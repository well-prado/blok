# Changelog

All notable changes to Blok are recorded here.

The project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html);
the monorepo's git tag (`vX.Y.Z`) is the canonical version. Individual
packages on npm version independently within each release line.

## [Unreleased]

### Added

- **Runtime-boundary payload safety (ADR 0014).** Non-NodeJS runtime nodes now
  fail fast with a `GRPC_REQUEST_TOO_LARGE` error naming the node and a per-blob
  byte breakdown when a request would exceed the gRPC message limit — instead of
  an opaque `RESOURCE_EXHAUSTED`. New opt-in `BLOK_GRPC_STATE_DIET=1` stops
  shipping the accumulated workflow state + previous-step output on every remote
  call (keeps `env` + trigger body); use it only when runtime nodes follow the
  v2 ABI and never read `ctx.vars` / `ctx.response.data`. New docs page:
  *Reliability → Large payloads across the runtime boundary*.

### Behavior changes

- **Workflow `input` Zod is now enforced at the trigger boundary (ADR 0015).**
  A workflow that declares `input` on `workflow({ input })` now has each request
  validated in `TriggerBase.run` before the body reaches any step: the body is
  `safeParse`d and **replaced with the parsed value**, so declared `.default()`s
  and coercions apply and unknown keys are stripped. A malformed request returns
  `400` (HTTP), an `isError` result (MCP), or an error status (gRPC) — instead of
  running with `undefined` fields. Workflows that declared a schema *and* relied
  on undeclared body fields must switch to `z.object({...}).passthrough()`. Kill
  switch: `BLOK_VALIDATE_WORKFLOW_INPUT=0`. Undeclared `input` → unchanged.

## [v0.6.0] — 2026-05-14

The headline shift since v0.4.0. Adds the reliability primitives that
let production workloads opt into idempotency, retries, timeouts,
rate-limit gates, scheduling (delay / ttl / debounce), durable
sub-workflows, and cross-process coordination — without changing v1
workflow behaviour by default. Also lands the new trigger surface
(WebSocket, SSE, Webhook, Pub/Sub, expanded worker adapters) on a
shared Hono server, the wait-inside-primitives primitives
(forEach/loop/switch/tryCatch + wait), and a substantially richer
Studio UI.

### Breaking changes

- `BLOK_FILE_BASED_ROUTING` default flipped to **ON**. JSON workflows under `workflows/json/` auto-register at their `trigger.http.path`. Opt out with `BLOK_FILE_BASED_ROUTING=false` or `BLOK_ROUTING_LEGACY=1`. Codemod: `bunx blokctl migrate paths`.
- `set_var` field removed from v2 workflow schema. `WorkflowNormalizer.assertNoSetVar` throws at workflow load if still present. Codemod: `bunx blokctl migrate workflows`.
- `RUNTIME_TRANSPORT=http` and `HttpRuntimeAdapter` removed — gRPC is the sole runtime transport since v0.5. Stale env values throw at trigger boot.

### Reliability primitives (Tier 1 + Tier 2)

- `idempotencyKey` on any step caches results against `(workflow, step.id, key)` with a 24h default TTL. Cache hit short-circuits `step.process()` entirely. `idempotencyKeyTTL` overrides per step.
- `retry: { maxAttempts, minTimeoutInMs?, maxTimeoutInMs?, factor? }` for capped exponential backoff. Per-attempt failures emit `NODE_ATTEMPT_FAILED`; final exhaustion emits `NODE_FAILED`.
- `maxDuration` on any step — each retry attempt gets its own timeout. Final-attempt timeout flips the run to the new **`"timedOut"`** state. `StepTimeoutError` exported from `@blokjs/runner`.
- Cooperative cancellation: `ctx.signal: AbortSignal` flows through to nodes. `POST /__blok/runs/:runId/cancel` fires the signal and flips status to `"cancelled"`. Sub-workflow children inherit a chained signal.
- Crash auto-flip: `uncaughtException` + `unhandledRejection` handlers flip every in-flight `running` run to **`"crashed"`** before the process dies. `recoverOrphanedRuns()` at boot flips stale `running` rows older than `BLOK_ORPHAN_THRESHOLD_MS`. Page-aware (drains all rows, not just the first page).

### Per-tenant concurrency gate (Tier 2 #6)

- `concurrencyKey` + `concurrencyLimit` + `onLimit: "throw" | "queue"` on any HTTP / Worker trigger.
- `onLimit: "queue"` defers the run via `DeferredRunScheduler` with capped exponential backoff (`queueRetry: { minBackoffMs, maxBackoffMs, factor }`). New run state **`"queued"`**.
- Cross-process backends: `BLOK_CONCURRENCY_BACKEND=nats-kv` (revision-based CAS) or `redis` (server-side Lua, no OCC retry loop). FW-5 production refusal on default bucket / key-prefix names.
- New OTel counters: `blok_concurrency_acquired_total`, `denied_total{mode}`, `released_total`, `occ_retries{outcome}`, `backend_install_total`.
- New REST endpoints: `GET /__blok/concurrency/health`, `GET /__blok/concurrency/state` (powers Studio's `ConcurrencyTile`).
- D6 — `BLOK_METRICS_PER_KEY=1` opts in to per-`concurrency_key` labels (default OFF strips the high-cardinality label).

### Scheduling gates (Tier 2 #5 + #7)

- `delay` + `ttl` on triggers — HTTP returns `202 Accepted` immediately. New run states **`"delayed"`** and **`"expired"`**.
- `debounce: { key, mode, delay, maxDelay? }` — trailing (default) or leading. Latest-payload-wins via captured closure. One run record per ping (coalesce losers get **`"debounced"`** terminal with `intoRunId` pointing at the active run).
- Durable scheduler: HTTP `delay` and `queue` writes to `scheduled_dispatches` table (sqlite v9 / PG v3). `recoverDispatches()` at boot re-registers timers + marks past-TTL rows as expired.
- Cross-process scheduler claim coordination — sqlite v13 / PG v6 add `claimed_by` + `claimed_at` so multi-process deployments don't double-fire dispatches. Heartbeat every 20s (tunable).
- Cross-process debounce backend: `BLOK_DEBOUNCE_BACKEND=nats-kv` or `redis`. Shared doc per `(workflow, debounceKey)` bucket with owner-lease attribution. Owner-local payload semantic.

### Sub-workflows (Tier 2 #4)

- `subworkflow: "<name>"` step invokes another workflow function-call-style. `wait: true` (default) waits for child completion; `wait: false` fires-and-forgets with `{runId, workflowName, scheduledAt}`.
- G3 — polymorphic dispatch: `subworkflow:` accepts `$.<path>` / `js/...` expressions resolved at dispatch time. Pair with `allowList: [...]` to constrain caller-supplied names.
- G2 — cross-process dispatch: `dispatch: "in-process" | "http-self"`. `http-self` dispatches the child as a fresh HTTP request to `BLOK_SELF_BASE_URL`. Lineage crosses the HTTP boundary via `X-Blok-Parent-Run-Id` / `-Node-Run-Id` / `-Subworkflow-Depth` headers.
- Recursion cap: `BLOK_MAX_SUBWORKFLOW_DEPTH` (default 10).
- AbortSignal cascade — parent abort fires children's signals. Listener-leak fix (#A3) lands here.

### Workflow primitives (v0.5 → v0.6)

- `branch` primitive (replaces v1's `AddIf` / `AddElse`).
- `forEach` — collection iteration with optional `as` binding. Sequential and parallel variants.
- `loop` — while-condition with `maxIterations` cap.
- `switch` — N-way branch; first matching `when` wins.
- `tryCatch` — JS-like try/catch/finally with structured `$.error` envelope (`message`, `name`, `stack`, `code`, `stepId`).
- `wait` primitive — `wait: { for, until }` defers the run via the durable scheduler and resumes from a per-run snapshot of `ctx.state`. Composes with **all** primitives:
  - wait inside `tryCatch` (Phase 1)
  - wait inside `forEach` — sequential (Phase 2) and parallel (Phase 3b)
  - wait inside `loop` (Phase 3)
  - wait inside `switch` (Phase 4)

### Triggers

- **HTTP** — shared Hono server architecture refactor; constructor accepts an external Hono app for multiplexing.
- **WebSocket** — new trigger on the shared Hono port (`@blokjs/trigger-websocket`).
- **SSE** — new trigger on the shared Hono port (`@blokjs/trigger-sse`, Pattern A).
- **Webhook** — new trigger with built-in providers + polymorphic dispatch (`@blokjs/trigger-webhook`). Includes raw-body capture for byte-exact HMAC verification.
- **Worker** — adapter extension: 5 new adapters (BullMQ, RabbitMQ, SQS, NATS JetStream variants); polymorphic `provider` field.
- **Pub/Sub** — new trigger (`@blokjs/trigger-pubsub`); 3 adapters (Kafka, Google Cloud Pub/Sub, NATS) + provider field + ctx-level `publish()`.
- **Cron** — middleware chain applied (consistent with HTTP / Worker).

### Middleware

- Process-global middleware via `WorkflowRegistry.setGlobalMiddleware([...])` or `BLOK_GLOBAL_MIDDLEWARE=name1,name2` env var. Resolution order: process-global → workflow-level → trigger-level → workflow body.
- `mw:<name>` origin badge in Studio's StepRail surfaces which middleware produced each nested step.

### Workflow shape (v2)

- Inline inputs on the step itself; `id` + `use` replace the legacy `name` + `node` + separate `nodes{}` map.
- Default-store-on-success: every step's output lands at `ctx.state[<id>]` automatically. Opt out per step with `ephemeral: true`. `as: "<name>"` renames the storage slot; `spread: true` flattens `result.data` keys into `state` (mutually exclusive with `as`).
- Mapper: `$.state.<id>` proxy (TS DSL) compiles to `js/ctx.state.<id>` strings. New `BLOK_MAPPER_MODE=strict` env var fails fast on resolution errors (recommended for production).

### Studio

- E1 — scheduled-runs view + cancel action for `delayed` / `queued` / `debounced` runs.
- E2 — saved filters server-side (replaces localStorage). New `trace_saved_filters` table.
- E3 — sub-workflow depth badge `↳ sub (N)` for nested invocations.
- E4 — static workflow DAG view (xyflow + dagre flowchart) on each workflow's detail page. Powered by `GET /__blok/workflows/:name` returning the raw `definition`.
- F1 — indexed metadata generated columns via `BLOK_INDEXED_METADATA_KEYS=tier,region`.
- F2 — metadata filter operators (`__ne`, `__gt`, `__lt`, `__in`, `__like`, etc.).
- Sample-body trifecta — empty-state curl resolves through 3 tiers: **author** (`trigger.http.examples.body`) > **recorded** (real first successful run when `recordSample: true`) > **inferred** (static analysis of `ctx.request.body` refs). Operator escape hatch: "Re-record sample" button + `DELETE /__blok/workflows/:name/sample`.
- Sidebar lists registered-but-never-run workflows (merges `WorkflowRegistry.list()` into the run-derived summaries).
- Routing diagnostics — `RoutingDiagnostics` singleton + `GET /__blok/routing` + Studio banner surface boot-time route-build problems (collisions, missing paths).
- G2 follow-up — sky-blue `http` chip in StepRail when sub-workflow dispatched via HTTP self-call (alongside the existing `↳ async`/`↳ sub`).
- Iteration grouping — consecutive sibling rail rows that share `iterationIndex` collapse under an "iteration N" header.
- Live progress + partial-result streaming surfaces in NodeDetail.
- StepRail flag persistence (`flags_json` JSON column on `node_runs`) — `wait`, `dispatch`, `subworkflowDepth`, `middleware`, `iterationIndex` now survive sqlite/PG round-trip.

### Observability

- OTel counters for the concurrency gate + scheduling dispatcher (`blok_concurrency_*`, `blok_scheduling_dispatch_*`).
- OCC retry depth histogram (`blok_concurrency_occ_retries`).
- Backend install attempts counter (`blok_concurrency_backend_install_total`) for misconfiguration visibility.
- Graceful shutdown: SIGTERM / SIGINT drain order `trigger.stop()` → `Janitor.stop()` → `DeferredRunScheduler.clear()` → `backend.disconnect()`. Kill-switch: `BLOK_GRACEFUL_SHUTDOWN_DISABLED=1`.
- Janitor singleton — periodic sweep of expired `idempotency_cache`, `concurrency_locks`, `scheduled_dispatches` rows. Default 5min interval; kill-switch `BLOK_JANITOR_DISABLED=1`.

### Persistence

- SQLite migrations v3 → v16 (additive; existing DBs upgrade transparently).
- Postgres migrations v3 → v9 (mirror of SQLite where applicable).
- `state_snapshot` column for wait-resume across process restart.
- `iteration_context` discriminated union for sequential / parallel forEach + wait cursors and switch + wait cursors.

### Docs

- New migration guide: [v1 → v2 · Reliability primitives](docs/c/migration-guides/v1-to-v2-reliability.mdx) — 5-minute recipes for every primitive + composition reference table.
- v0.4 explicit-paths migration guide and `MissingExplicitPathError` UX.
- Per-feature reference docs for every reliability primitive under `docs/d/reliability/`.
- Scheduling overview + per-feature docs under `docs/d/scheduling/`.
- Comprehensive observability page including REST + counter reference and Prometheus query recipes.
- Wait-inside-primitives implementation spec + ctx.error lifecycle.

### Testing infrastructure

- Phase 2.1 — real-broker integration tests for 5 deferred adapters (NATS / Kafka / Redis / Pub/Sub / SQS).
- Docker-compose CI brings up the full broker fleet for each PR run.
- Benchmarks for concurrency snapshot, durable scheduler scans, Janitor sweeps, crash auto-flip, sub-workflow listener cascade.

---

## [v0.4.0] — earlier 2026

Explicit-path-only routing (preview). See
[`docs/c/migration-guides/v0.4-explicit-paths.mdx`](docs/c/migration-guides/v0.4-explicit-paths.mdx)
for the full migration recipe. Set `BLOK_ROUTING_LEGACY=1` to keep v0.3
behaviour (removed in v0.6).

---

[v0.6.0]: https://github.com/well-prado/blok/releases/tag/v0.6.0
[v0.4.0]: https://github.com/well-prado/blok/releases/tag/v0.4.0
