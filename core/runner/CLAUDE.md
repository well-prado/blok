# @blokjs/runner — Internals

## Key Files

| File | Purpose |
|------|---------|
| `src/defineNode.ts` | `defineNode()` API — function-first node definition with Zod |
| `src/Blok.ts` | `BlokService` base class — `run()` orchestrates config→validate→handle→output |
| `src/RunnerSteps.ts` | `runSteps()` — core step execution loop, flow node handling |
| `src/Configuration.ts` | Loads workflow JSON, resolves nodes, initializes RuntimeRegistry |
| `src/RuntimeRegistry.ts` | Singleton managing all RuntimeAdapter instances |
| `src/RuntimeAdapterNode.ts` | Bridge: wraps RuntimeAdapter into RunnerNode interface |
| `src/TriggerBase.ts` | Base class for triggers — creates Context, runs workflow, handles tracing |
| `src/adapters/grpc/GrpcRuntimeAdapter.ts` | gRPC adapter for all non-NodeJS SDKs (default since Phase 6) |
| `src/adapters/HttpRuntimeAdapter.ts` | HTTP adapter — **deprecated**, removed in v0.4.0. Resolves only via `RUNTIME_TRANSPORT=http` opt-in (see `transport.ts:resolveTransportForKind`); emits a once-per-process stderr warning. |
| `src/adapters/NodeJsRuntimeAdapter.ts` | In-process adapter for NodeJS/TypeScript nodes |
| `src/adapters/transport.ts` | Resolves which transport a runtime kind uses. Default `grpc`; `RUNTIME_TRANSPORT=http` and per-kind `RUNTIME_<K>_TRANSPORT=http` are honored with a deprecation warning. |
| `src/tracing/RunTracker.ts` | Trace recording (SQLite/Postgres/In-Memory) |
| `src/tracing/registerTraceRoutes.ts` | `/__blok/*` REST API for Blok Studio |

## Step Execution Flow (RunnerSteps.ts)

```
runSteps(ctx, steps)
  for each step:
    if step.active === false → skip
    if step.stop === true → break
    if step.flow === true:
      → call step.processFlow(ctx) → returns NodeBase[]
      → recursively runSteps(ctx, [...flowSteps, ...remainingSteps], deep=true)
      → break (flow takes over)
    else:
      → call step.process(ctx, step)
      → ctx.response = result.data (OVERWRITES previous)
      → if error: throw GlobalError
```

## Node Resolution (Configuration.ts)

```
nodeTypes() returns:
  "module"           → moduleResolver() — loads from GlobalOptions.nodes
  "local"            → localResolver()  — dynamic import from NODES_PATH
  "runtime.python3"  → runtimeResolver() — RuntimeRegistry → GrpcRuntimeAdapter (HTTP via opt-in)
  "runtime.go"       → runtimeResolver()
  "runtime.rust"     → runtimeResolver()
  "runtime.java"     → runtimeResolver()
  "runtime.csharp"   → runtimeResolver()
  "runtime.php"      → runtimeResolver()
  "runtime.ruby"     → runtimeResolver()
```

Transport selection lives in `src/adapters/transport.ts`. The default is `grpc`
since Phase 6 (master plan §11/§14). `RUNTIME_TRANSPORT=http` and per-kind
`RUNTIME_<KIND>_TRANSPORT=http` overrides remain functional **until v0.4.0**;
they emit a once-per-process stderr warning on resolve.

## Persistence model (v2)

Step output flows through `src/workflow/PersistenceHelper.ts:applyStepOutput`.
Rules in order:

1. `step.ephemeral === true` → no-op. Available only via `ctx.prev`.
2. Legacy `step.set_var === false` → also no-op (back-compat).
3. `step.spread === true` AND data is a plain object → shallow-merge into `ctx.state`.
4. Default → `ctx.state[step.as ?? step.name] = result.data`.

`set_var` is **passed through verbatim** by `Configuration.getSteps`,
`Configuration.getFlow`, and `Configuration.runtimeResolver` — they never
default it to `false`. NodeBase initializes `set_var` to `undefined` so the
default-store rule can fire. Defaulting to `false` here would silently
disable persistence for every step that didn't explicitly set the field
(which is every v2 step) — that exact regression broke
cross-runtime-chain in Phase 6 and is now covered by
`__tests__/unit/RuntimeAdapterNode.test.ts`.

## Idempotency caching (Tier 1)

Step authors opt in by setting `idempotencyKey` on the step:

```ts
{ id: "fetch", use: "@blokjs/api-call", inputs: { url: "..." }, idempotencyKey: $.req.body.requestId }
```

The runner consults the cache **before** `step.process()`. On hit, it
calls `PersistenceHelper.applyStepOutput(ctx, step, { data: cached.data })`
to populate state through the same `ephemeral`/`spread`/`as` rules as a
fresh run, marks the node `cached` for tracing, emits a `NODE_CACHED`
event, and continues to the next step — `step.process()` is never
called.

Cache namespace: `(workflowName, step.id, resolvedKey)`. The triple
prevents collisions across workflows and across same-id steps in
different workflows. Resolved key is either the literal string or the
result of evaluating a `js/ctx....` expression against the live ctx.

Cache TTL: 24h default (`DEFAULT_IDEMPOTENCY_TTL_MS`); override per
step via `idempotencyKeyTTL: <ms>`. A TTL of 0 marks an entry as
immediately expired (kill-switch).

Cache backend: same store as run tracing — `SqliteRunStore` migration
v4 added the `idempotency_cache` table; `InMemoryRunStore` keeps a
parallel `Map`. `BLOK_TRACE_ENABLED=false` disables caching too (the
store backs both).

**Caching layers ABOVE `PersistenceHelper.applyStepOutput`, never
within it.** A cache hit feeds data through the same persistence rules
a fresh result would. This is the contract that makes the v2
`set_var=undefined` default safe to coexist with caching.

## Retry (Tier 1)

Step authors opt in:

```ts
{
  id: "flaky",
  use: "@blokjs/api-call",
  retry: { maxAttempts: 3, minTimeoutInMs: 500, maxTimeoutInMs: 10000, factor: 2 },
}
```

`RunnerSteps` wraps `step.process()` with a `for attempt 1..maxAttempts`
loop and capped exponential backoff:
`delay = min(maxTimeoutInMs, minTimeoutInMs * factor^(attempt-1))`.
Defaults: min=1000, max=30000, factor=2. No jitter — matches Trigger.dev.

Per-attempt failures emit `NODE_ATTEMPT_FAILED` and append to
`NodeRun.attempts[]` (capped at 10 entries by `MAX_STORED_ATTEMPTS`).
The terminal `NODE_FAILED` only fires after all attempts are
exhausted. Default `maxAttempts: 1` preserves pre-Phase-4 behaviour
exactly.

Retry composes with idempotency caching: a cache hit short-circuits
`step.process()` entirely, so retry never enters the picture. A cache
miss on attempt N writes the cache only on success of the final
successful attempt.

## Replay (Tier 1)

`POST /__blok/runs/:runId/replay` re-dispatches the original HTTP
trigger with the captured payload. The endpoint sets the
`X-Blok-Replay-Of: <originalRunId>` header on the dispatched request;
`TriggerBase.run()` reads it from `ctx.request.headers` and passes
`replayOf` into `tracker.startRun()`, which persists onto
`WorkflowRun.replayOf`. Studio renders a "replay of #..." breadcrumb
on the new run that links back to the source.

Replay is a thin re-trigger, not a checkpoint resume — the new run
starts from scratch, runs the current code, and produces a new trace.
This is intentional: combine replay with idempotency caching to skip
expensive steps on the new run while still picking up code changes.

## Sub-workflows (Tier 2 #4)

Any v2 workflow can invoke another named workflow as a step:

```ts
{
  id: "send-receipt",
  subworkflow: "send-receipt-email",
  inputs: { user: $.state.user, order: $.state.order },
  // wait: true (default) — synchronous, parent blocks on child
  // wait: false — fire-and-forget; parent returns {runId, workflowName, scheduledAt}
}
```

The child workflow is looked up by name in `WorkflowRegistry`
(`src/workflow/WorkflowRegistry.ts`), gets its own `Context`, runs
through the same `RunnerSteps` machinery as a top-level run, and
returns its `ctx.response` as the parent step's output (so it lands on
`state[<id>]` like any other step). Mirrors HTTP function-call
semantics — sub-workflow inputs become the child's `request.body`.

**Workflow registration**: triggers feed the registry at boot. The
HTTP trigger's `buildFileBasedRoutes()` calls
`WorkflowRegistry.getInstance().registerAll(...)` after scanning
workflows. Future trigger types (worker, cron) feed the same registry.
Sub-workflow lookup is decoupled from any particular trigger.

**Lineage**: child's `WorkflowRun.parentRunId` carries the parent's
run id; `parentNodeRunId` carries the specific NodeRun (the
sub-workflow step). Studio renders a "called from #..." breadcrumb on
the child and a "Sub-runs (N)" strip on the parent's run header.
Endpoint: `GET /__blok/runs/:runId/subruns` returns the child runs
sorted oldest-first.

**Wait modes**:

- `wait: true` (default) — synchronous. Parent step `await`s
  `childRunner.run()` to completion. Child's `ctx.response` becomes
  the parent step's `model.data` and lands on `state[<id>]` via
  `applyStepOutput`. Errors propagate to the parent step (and its
  `retry` loop, if configured).
- `wait: false` — fire-and-forget. Parent step returns IMMEDIATELY
  with `{runId, workflowName, scheduledAt}`. Child runs
  asynchronously via `setImmediate(() => childRunner.run(...).then(completeRun).catch(failRun))`.
  Errors are caught + routed to `tracker.failRun(childRunId, err)` +
  `console.error`, NOT propagated to the parent (which has already
  returned). `parentRunId`/`parentNodeRunId` lineage is preserved
  for both modes — the child appears in Studio's Sub-runs strip
  with status transitioning `running → completed | failed`
  independently of the parent.

**Composition with Tier 1**:
- Parent step's `idempotencyKey` caches the parent step output:
  - With `wait: true`: cache holds the **whole child result**. Cache
    HIT means the child workflow is NEVER invoked — including any
    side effects. This is the headline pattern AND the primary
    footgun. Document prominently for sub-workflows that have
    unconditional side effects (sends emails, charges cards, etc.).
  - With `wait: false`: cache holds the **dispatch metadata**
    (`{runId, workflowName, scheduledAt}`). Cache HIT returns the
    SAME runId regardless of child outcome — Trigger.dev / Stripe
    at-most-once dispatch dedup semantics. To retry on child
    failure, use a new idempotency key. The cached `runId` points
    at the original (possibly long-completed or long-failed) child
    run; caller polls `/__blok/runs/<runId>` for the current state.
- Parent step's `retry` retries the dispatch step (registry lookup,
  recursion guard) on failure. With `wait: true`, the retry covers
  the full child execution (failed children re-trigger fresh).
  With `wait: false`, the retry only covers the dispatch itself
  (the async child's failure does NOT trigger parent retry; the
  parent step has already returned successfully with the runId).
- Replay creates fresh sub-run lineage automatically.

**Recursion guard**: hard-coded cap at 10 levels of nesting,
overridable via `BLOK_MAX_SUBWORKFLOW_DEPTH`. Throws a clear error
when exceeded — bounds blast radius of accidental cycles
(workflow A calls B calls A).

**Sqlite**: migration v6 adds `workflow_runs.parent_run_id` +
`workflow_runs.parent_node_run_id` columns + index on parent_run_id.
Additive; pre-existing rows get NULL.

**Not yet shipped**:
- Cross-process sub-workflow dispatch (HTTP self-call) — current
  implementation is in-process only. `wait: false` async dispatch
  is `setImmediate`-based, NOT cross-process. Horizontal-scale
  users with isolation needs may want this in a follow-up.
- Polymorphic workflow names (`subworkflow: $.req.body.kind`) —
  workflow names are static today.
- Studio `↳ async` indicator distinguishing sync vs async sub-
  workflow steps in StepRail. Currently both show `↳ sub`; the
  Sub-runs strip on the parent surfaces the actual status.
- Cancellation API for fire-and-forget children
  (`POST /__blok/runs/:childId/cancel`).

## Concurrency keys (Tier 2 #6)

Trigger authors opt in by adding `concurrencyKey` (with an optional
`concurrencyLimit`) to a trigger config block:

```ts
trigger: {
  http: {
    method: "POST",
    path: "/render",
    concurrencyKey: $.req.body.userId,  // literal or $-proxy
    concurrencyLimit: 5,                 // default 1 (Trigger.dev parity)
  },
}
```

The gate runs in `TriggerBase.run()` between `tracker.startRun()` and
`runner.run()`. At run-entry, the trigger resolves the key against ctx,
attempts `runStore.acquireConcurrencySlot(workflow, key, limit, runId,
leaseExpiresAt)`, and either:

- **Granted**: stashes the lock on a closure variable; releases it in
  the `finally` block (idempotent at the store layer).
- **Denied**: calls `tracker.markRunThrottled(...)` (sets run status
  `"throttled"`, emits `RUN_THROTTLED` event), throws
  `ConcurrencyLimitError` with structured info `{workflowName,
  concurrencyKey, concurrencyLimit, currentInFlight, retryAfterMs,
  runId}`. Trigger transports translate this:
  - HTTP → `429 Too Many Requests` with `Retry-After` header (seconds,
    rounded up) and structured JSON body.
  - Worker → NACK with redelivery; existing job-queue back-off handles
    spacing. Doesn't count against the workflow's retry budget.

**Lease semantics**: locks have a hard expires-at timestamp (default
1h). Happy path releases in `finally`. Crash safety: lazy-purged on
the next acquire to the same `(workflow, key)` bucket. Tunable per
trigger via `concurrencyLeaseMs`; process-wide via
`BLOK_CONCURRENCY_LEASE_MS`. Kill-switch: `BLOK_CONCURRENCY_DISABLED=1`
short-circuits the gate.

**Cache namespace + isolation**: locks are keyed `(workflowName,
resolvedKey)`. Different workflows + different keys never contend.

**Composition with Tier 1 / Tier 2 #4**:
- **Idempotency cache hits** still hold a slot for the duration of the
  cache fetch + persistence apply (~ms). Trade-off accepted; well
  under typical workflow runtime.
- **Sub-workflow steps** do NOT go through `TriggerBase.run()` — they
  invoke directly via `SubworkflowNode`. Children do NOT contend for
  the parent's concurrency slot. Step-level concurrency keys (a
  follow-up feature) would address inner-loop fairness.
- **Replay** picks up the lineage `replayOf` and goes through the gate
  on the new run. If the workflow is still over-limit, the replay
  throttles too (correct by design — the limit is dynamic state).

**Failure modes**:
- Key resolution fails (e.g. `js/ctx.bad.path` throws or returns
  null/undefined) → fail-open (skip the gate, run the workflow).
  Matches `idempotencyKey` semantics. Use `BLOK_MAPPER_MODE=strict`
  to fail-fast in production.
- Tracker inactive (`BLOK_TRACE_ENABLED=false`) → gate disabled.
  Same store backs both. Documented trade-off.

**Sqlite**: migration v7 adds the `concurrency_locks` table with PK
on `(workflow_name, concurrency_key, run_id)` plus indexes on
`expires_at` and `(workflow_name, concurrency_key)`. Additive; pre-Tier-2-#6
DBs upgrade transparently.

**Backends**:
- SQLite (default for production).
- InMemory (dev / tests).
- Postgres delegates to in-memory — durable PG schema for cross-process
  gating is a deferred follow-up. Same trade-off as Tier 1's
  idempotency cache.

**`onLimit: "queue"` (Tier 2 #6 follow-up)**:

Triggers can opt into queue-on-deny instead of reject-on-deny:

```ts
trigger: {
  http: {
    method: "POST",
    path: "/render",
    concurrencyKey: $.req.body.tenantId,
    concurrencyLimit: 5,
    onLimit: "queue",   // default "throw" (current behavior)
  },
}
```

When the gate denies AND `onLimit === "queue"`:
- `tracker.markRunQueued(traceRunId, {concurrencyKey, concurrencyLimit,
  currentInFlight, scheduledAt})` flips status to `"queued"` and
  persists `scheduledAt = now + 1000ms`.
- `DeferredRunScheduler.schedule(traceRunId, scheduledAt, dispatchFn)`
  registers a timer that calls `this.dispatchDeferred(ctx, traceRunId,
  undefined)` when it fires.
- `DeferredDispatchSignal` is thrown with `status: "queued"`. HTTP
  translates to `202 Accepted` + `Location`; Worker ACKs without retry.

When the timer fires, `dispatchDeferred` re-enters `run(ctx)` with the
existing `_blokDispatchReentry` flag. The reentered `run()` skips the
scheduling gates (existing behavior) and re-attempts the concurrency
gate. On grant, the run continues normally. On re-denial, the same
queue path executes again — `markRunQueued` updates `scheduledAt`,
`DeferredRunScheduler.schedule()` replaces the existing timer (the
scheduler's "replace on same runId" semantics), and the signal is
re-thrown. The `dispatchDeferred` swallows the signal so timer
callbacks don't crash on uncaught rejections.

Indefinite retry — there is no internal cap on how many times a run
can re-defer. The trigger-level lease (default 1h) bounds slot leaks
if a holder process dies, so queued runs eventually progress. Trade-
offs documented:
- Thundering herd: when a slot frees, all queued runs for the bucket
  wake up at the next 1s tick and contend; only one wins. Future
  improvement: capped exponential backoff with jitter, or a wakeup-
  on-release model. Single-process v1 ships fixed-1s.
- Each retry attempt counts as a brief in-flight request (~ms) and
  the inner re-entered `run()` increments `inFlightRequests`. Brief
  metric flicker only.

**Not yet shipped**:
- Capped exponential backoff for re-defer (fixed 1s today).
- Wakeup-on-release model (cross-process plumbing prerequisite).
- `concurrencyQueueTimeoutMs` (TTL on queued runs). Workaround: use
  the trigger-level `ttl` once the HTTP "TTL requires delay"
  restriction is lifted, or kill-switch + redeploy.
- Cross-process backend (NATS KV / Redis). Single-process semantics
  ship first.
- Step-level concurrency keys (different invariant set, separate
  plan).

## Delay / TTL / Debounce (Tier 2 #5 + #7)

Trigger authors opt in by adding `delay`, `ttl`, or `debounce` to a
trigger config block:

```ts
trigger: {
  http: {
    method: "POST",
    path: "/welcome",
    delay: "1h",                    // schedule for 1h from now
    ttl: "2h",                       // expire if not started within 2h
  },
}

trigger: {
  http: {
    method: "POST",
    path: "/save/:docId",
    debounce: {
      key: $.req.params.docId,      // per-doc coalescing
      mode: "trailing",              // default; or "leading"
      delay: "500ms",                // wait for silence
      maxDelay: "5s",                // tail-latency bound (trailing only)
    },
  },
}
```

The gates run in `TriggerBase.run()` BEFORE the concurrency gate
(Tier 2 #6). Order: debounce → delay. The debounce gate handles its
own scheduling (so `delay` is effectively ignored on debounced
triggers).

**Debounce semantics**:
- **Trailing** (default): each ping resets a `delayMs` timer; the run
  fires after `delayMs` of silence. Latest payload wins via the
  closure captured by `DebounceCoordinator.onFire`. `maxDelayMs`
  bounds tail latency — even with continuous pings, the first ping's
  run fires at `maxDelayMs`.
- **Leading**: first ping fires synchronously through the normal
  pipeline. Subsequent pings within `delayMs` are suppressed (status
  `debounced` terminal). Window closes after `delayMs` of silence.

**One run record per ping**. The first ping creates a `delayed` (or
`debounced` for trailing-fresh) run; coalesce losers get `debounced`
terminal status with `intoRunId` pointing at the active run. The
active run's `pingCount` is incremented for each absorbed ping (via
`tracker.recordDebouncePing`). Trade-off: 1000 pings = 1000 records.
Use `evictOldRuns` to bound storage.

**HTTP transport**: deferred runs return `202 Accepted` with
`Location: /__blok/runs/:id` and structured JSON. Caller polls the
detail endpoint OR consumes the SSE event stream to track dispatch.

**Worker transport**: deferred runs ACK without retry. The in-process
scheduler owns the eventual dispatch — re-queueing would create a
duplicate. Existing job-queue back-off doesn't apply.

**Re-entry**: when a deferred timer fires, the dispatcher
(`DeferredRunScheduler` for delay; `DebounceCoordinator.onFire` for
trailing-debounce) calls `dispatchDeferred(ctx, traceRunId, expiresAt)`
which:
1. Checks TTL — if past `expiresAt`, marks run `expired` + emits
   `RUN_EXPIRED`.
2. Transitions run to `running` (status flips from delayed/debounced
   → running).
3. Re-enters `run(ctx)` with `_blokDispatchReentry = true` on ctx so
   the scheduling gates are skipped on the second pass. The existing
   `traceRunId` is reused.

**Composition with prior tiers**:
- **Concurrency gate** (Tier 2 #6) runs AFTER scheduling gates. A
  delayed run that becomes throttled at dispatch flips status
  `delayed → throttled` cleanly.
- **Idempotency cache** (Tier 1) check happens INSIDE step execution,
  AFTER `dispatchDeferred` re-enters. So cache hits on a delayed run
  short-circuit the steps (no expensive work) but still hold a
  concurrency slot briefly.
- **Sub-workflows** (Tier 2 #4) don't go through `TriggerBase.run()`
  — they invoke directly via `SubworkflowNode`. Children DO NOT
  inherit the parent's delay/TTL/debounce.
- **Replay** picks up the lineage `replayOf` and goes through the
  scheduling gates on the new run (could re-defer if config still
  configures delay).

**Failure modes**:
- Debounce key resolution fails (`js/ctx.bad.path` throws or returns
  null) → fail-open (skip the gate). Use `BLOK_MAPPER_MODE=strict`
  for fail-fast in production.
- Tracker inactive (`BLOK_TRACE_ENABLED=false`) → all gates disabled
  (deferred dispatch needs persistence to survive within-process).

**Sqlite**: migration v8 adds `scheduled_at`, `expires_at`,
`debounce_key`, `debounce_mode`, `ping_count` to `workflow_runs` plus
indexes on `scheduled_at` and `(workflow_name, debounce_key)`.
Additive; pre-Tier-2-#5+#7 DBs upgrade transparently.

**Backends**:
- In-memory `DeferredRunScheduler` + `DebounceCoordinator` for the
  hot path (timers + closures live in process memory).
- **Sqlite-backed durability (Tier 2 #5+#7 follow-up)**: HTTP `delay`
  and `onLimit:queue` dispatches additionally write a row to the
  `scheduled_dispatches` table (migration v9) before registering the
  timer. The row carries `{runId, workflowName, triggerType,
  scheduledAt, expiresAt, dispatchStatus, payload}` where `payload`
  is a JSON-serializable subset of the request (method, path,
  headers, body, params, query) sufficient to reconstruct dispatch.
  Sensitive headers (authorization, cookie, x-api-key, etc.) are
  stripped before persistence. On `HttpTrigger.listen()`,
  `recoverDispatches()` scans the table and either marks past-TTL
  rows as `expired` or re-registers timers via `restoreDispatch(row)`
  which rebuilds a minimal `Context` and re-enters `dispatchDeferred`.
  Persistence is opt-in per trigger via the new
  `extractDispatchPayload(ctx)` virtual method on TriggerBase
  (returns `null` by default — workers don't override since their
  brokers handle delay durably).

**Not yet shipped**:
- Cross-process debounce keys (NATS KV / Redis).
- Long delays (>24h) — recommend cron trigger + external scheduler
  for those use cases.
- `mode: "throttle"` (rate-cap, fire every N ms regardless of pings).
- Dispatch-time payload merging (each ping CONTRIBUTES to the final
  payload, not just OVERWRITES). v1 ships "latest wins".
- NATS adapter consumer-side delay enforcement (currently NATS stores
  `x-delay` in headers but the consumer doesn't enforce it — pre-
  existing issue, not regressed by this PR).

**Kill-switch**: `BLOK_SCHEDULING_DISABLED=1` short-circuits all
gates → runs proceed synchronously even if configured with delay/
ttl/debounce.

## Input resolution (Mapper)

`@blokjs/shared`'s `Mapper` resolves `${path}` interpolations and
`js/...` expressions inside step `inputs` against the live `ctx`
(see `core/shared/src/utils/Mapper.ts`). Called from
`NodeBase.process` → `blueprintMapper` before every step runs.

**Failure mode is configurable** via the `BLOK_MAPPER_MODE` env var:

| Mode | Behavior on resolution failure |
|---|---|
| `warn` (default) | Log a structured warning via `ctx.logger.logLevel("warn", ...)` (routes to console + Studio's log viewer via `TracingLogger`) and pass the literal expression string through to the node. Backward-compatible with v1. |
| `strict` | Throw `MapperResolutionError` with full context (workflow name, step name, expression, underlying cause + heuristic hint). The step fails fast. **Recommended for production.** |
| `silent` | Pre-v0.3.x behavior — full suppression (no log, no throw). Opt-out for tests / workflows that intentionally use undefined-tolerant resolution. |

Production deployments should set `BLOK_MAPPER_MODE=strict` —
silent miscompiles (where a `js/ctx.bad.path` evaluation fails and
the literal string passes through to the node, producing wrong output
downstream) have historically been a major source of subtle bugs.

The structured warning includes:
- Which workflow + step the failure came from
- The literal expression that failed
- The underlying JS error message
- A heuristic **hint** (e.g., "the path `ctx.req.body` is undefined or
  doesn't have a `userId` field — check the trigger payload")
- The fix prompt ("set `BLOK_MAPPER_MODE=strict` to fail fast")

`MapperResolutionError` is exported from `@blokjs/shared` for
`instanceof` checks (e.g., a custom trigger may translate it into a
400-class HTTP response).

**Bug fixes shipped with the v0.3.x rewrite**:
- Falsy values (`0`, `false`, `""`) now correctly preserved in
  `${path}` resolution (was: `||` fell through to JS eval)
- Object values now JSON-encoded in interpolation (was: silent
  `[object Object]` coercion)
- `js/` prefix stripping uses `slice(3)` instead of `replace("js/", "")`
- `${...}` expressions get `func` and `vars` in scope (was: only
  `js/...` expressions did, asymmetric)

## Tests

```bash
pnpm test:dev                      # Watch mode
pnpm test                          # Single run
pnpm test:integration              # Integration tests
pnpm test:all                      # Unit + integration
```
