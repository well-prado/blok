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
| `src/adapters/NodeJsRuntimeAdapter.ts` | In-process adapter for NodeJS/TypeScript nodes |
| `src/adapters/transport.ts` | gRPC has been the sole runtime transport since v0.5. `assertGrpcOnlyTransport()` runs at trigger boot and throws if `RUNTIME_TRANSPORT=http` (or any `RUNTIME_<K>_TRANSPORT=http`) is still set, so stale operator config surfaces loudly. |
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

gRPC has been the sole runtime transport since v0.5 — `HttpRuntimeAdapter`
and the `RUNTIME_TRANSPORT=http` / `RUNTIME_<KIND>_TRANSPORT=http` env-var
opt-ins were removed together. `assertGrpcOnlyTransport()` runs from
`Configuration.initializeRuntimeRegistry` at trigger boot and throws with a
migration hint if stale operator config is still pointing at HTTP.

## Persistence model (v2)

Step output flows through `src/workflow/PersistenceHelper.ts:applyStepOutput`.
Rules evaluated in order:

0. **Errored result → no-op (v0.5.1 fix).** A step whose result envelope
   carries any error indicator — `success: false`, a non-null `error`
   (ResponseContext / `BlokResponse` shape), or a non-null `errors`
   (`ExecutionResult` shape from runtime adapters) — does NOT write state.
   That makes `ctx.state[<step-id>] === undefined` a truthful "did this
   step actually succeed?" check inside a `tryCatch.catch` arm. The guard
   is centralized so all three call sites (`Blok.run`,
   `RuntimeAdapterNode.run`, `SubworkflowNode.dispatchSync`) inherit
   identical behaviour without each re-implementing the check.
1. `step.ephemeral === true` → no-op. Available only via `ctx.prev`.
2. `step.spread === true` AND data is a plain object → shallow-merge into `ctx.state`.
3. Default → `ctx.state[step.as ?? step.name] = result.data`.

The legacy `set_var` field was removed in v0.5. `WorkflowNormalizer.assertNoSetVar`
walks the raw step tree (top-level + every nested sub-pipeline) and throws at
load time with a migration hint if the field is still present. `blokctl
migrate workflows` converts v1 workflows in bulk — `set_var: false` becomes
`ephemeral: true`; `set_var: true` is simply dropped (default-store handles
it). Coverage: `__tests__/unit/workflow/WorkflowNormalizer.test.ts` and the
two regression tests in `__tests__/unit/RuntimeAdapterNode.test.ts`.

### Why Rule 0 had to be centralized

Pre-fix: `Blok.run` always called `applyStepOutput` after `defineNode.handle()`,
even on the failure path. `BlokResponse.setError()` resets `data` to `{}`,
so the helper persisted that empty object as the step's state slot. Authors
relying on `state['<step>'] !== undefined` got false positives — every
attempted step looked successful in retrospect. `RuntimeAdapterNode` and
`SubworkflowNode` had the same shape. Putting the guard inside
`applyStepOutput` rather than at each caller means future call sites
(replay, sub-workflow async dispatch follow-ups, etc.) inherit the
contract automatically. See `__tests__/unit/workflow/PersistenceHelper.test.ts`
"error guard (Rule 0)" for the regression coverage.

## Error envelope (`$.error`) inside tryCatch.catch

`TryCatchNode.toErrorEnvelope` walks the `.cause` chain at the moment of
catch entry to construct what authors see as `$.error`. Fields:

| Field | Source |
|---|---|
| `message` | The deepest error in the cause chain — strips the framework's `[step N/M] X failed: …` wrap. |
| `name` | `Error.name` of the deepest error. |
| `stack` | `Error.stack` when present. |
| `code` | `GlobalError.context.code` (the first `GlobalError` encountered while walking — handles both `@blokjs/throw inputs.code` and `defineNode.mapErrorToGlobalError`'s ZodError-→-400 mapping). |
| `stepId` | `_blokStepId` attached to the wrap layer in `RunnerSteps.ts:463`. The wrap is the *outer* error, so the envelope captures it before unwrapping past it. The id is preserved across the outer unwrap-to-GlobalError step in `RunnerSteps.ts:551` so it survives back to `TryCatchNode`. |

Authors use `$.error.stepId` for failure-routing logic ("payment failed →
notify billing", "inventory failed → notify warehouse") and `$.error.code`
to re-throw with the upstream HTTP status or to branch on 4xx vs 5xx. Both
fields are optional — non-`GlobalError` throws yield `code: undefined`,
and pre-v0.5.1 throws (or thrown values that bypass `RunnerSteps`'
inner-try wrap) yield `stepId: undefined`.

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

Cache backend: same store as run tracing.
- `SqliteRunStore` migration v4 added the `idempotency_cache` table.
- `InMemoryRunStore` keeps a parallel `Map` (cleared on restart).
- `PostgresRunStore` is hybrid: sync reads hit an in-memory mirror;
  writes async-persist to PG via the `idempotency_cache` table
  (migration v3, shipped in commit `f735efe`). `loadRecent()`
  rehydrates the mirror on boot so cache entries survive restarts
  within a single PG-backed process.

`BLOK_TRACE_ENABLED=false` disables caching too (the store backs both).

**Caching layers ABOVE `PersistenceHelper.applyStepOutput`, never
within it.** A cache hit feeds data through the same persistence rules
a fresh result would. This is the contract that makes the v2
default-store rule safe to coexist with caching.

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
workflows. Worker and cron triggers feed the same registry via
`TriggerBase.registerWorkflowsFromNodeMap` (shipped F6). Sub-workflow
lookup is decoupled from any particular trigger.

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

**Polymorphic workflow names (G3 — shipped in v0.5)**:

`subworkflow:` accepts a `js/...` or `$.<path>` expression that the
runner evaluates against the live ctx at dispatch time. Webhook routers
and other "one trigger → N handlers" patterns can dispatch dynamically
without a switch step:

```ts
{
  id: "dispatch",
  subworkflow: "$.req.body.kind",
  inputs: { event: $.req.body },
  allowList: ["handler.payment", "handler.shipping"],
}
```

`allowList` is the safety guard. When set, the **final** resolved name
(after the polymorphic resolution AND any `namespace` prefix applied by
the parent's trigger config) must be in the array — otherwise dispatch
is rejected at run time with a structured error. Strongly recommended
when the expression depends on caller-supplied data (request body,
headers, etc.) so a malicious value can't escalate the workflow surface
accessible to a request. Literal names skip the registry-lookup ambiguity
but can still set `allowList` for defence-in-depth audit. See
`SubworkflowNode.resolveSubworkflowName` and the G3 test suite in
`__tests__/unit/SubworkflowNode.test.ts` for the contract.

**Cross-process dispatch (G2 — shipped in v0.6):**

`subworkflow:` steps accept a `dispatch` field that picks the
execution strategy:

```ts
{
  id: "send-receipt",
  subworkflow: "send-receipt-email",
  inputs: { user: $.state.user, order: $.state.order },
  dispatch: "http-self",  // default is "in-process"
}
```

- `"in-process"` (default) — child runs in the SAME Node process.
  Synchronous when `wait: true`; `setImmediate`-based when
  `wait: false`. Cheapest, no extra hops.
- `"http-self"` — child is dispatched as a fresh HTTP request to
  the deployment's own base URL (`BLOK_SELF_BASE_URL`, defaults to
  `http://localhost:${PORT || 4000}`). Each child can land on a
  different process in a horizontally-scaled deployment, or you
  can use it to fully isolate child execution from the parent's
  call stack.

Requirements + behaviour for `http-self`:
- The child workflow MUST have an HTTP trigger
  (`trigger.http.path` set). A runtime error is thrown otherwise.
- The request URL is `${BLOK_SELF_BASE_URL}${child.trigger.http.path}`.
- The request method is `child.trigger.http.method` (defaulting to
  `POST`).
- The request body is the parent step's resolved `inputs`
  (post-mapper, mirroring the in-process dispatch).
- Lineage crosses the HTTP boundary via headers:
  `X-Blok-Parent-Run-Id`, `X-Blok-Parent-Node-Run-Id`,
  `X-Blok-Subworkflow-Depth`. `TriggerBase.run` reads them when
  the request lands + threads them into `tracker.startRun(...)`.
- `wait: true` awaits the HTTP response (non-2xx → throw,
  propagating to the parent step's `retry` loop if configured).
- `wait: false` fires-and-forgets the fetch (`.catch + console.error`).
  Parent gets back `{runId: null, workflowName, scheduledAt, dispatch:
  "http-self", url}` — the actual child runId isn't known on the
  parent side; the receiver creates the run record when the request
  lands. Studio's Sub-runs strip surfaces the child once it appears.

Trade-offs vs. in-process:
- HTTP roundtrip adds latency (~few ms locally, more across
  network).
- The deployment must be reachable at `BLOK_SELF_BASE_URL` from
  the dispatching process — in Docker / Kubernetes, set the env
  var to the service DNS name (e.g. `http://blok-svc:4000`)
  rather than relying on the default `localhost`.
- Idempotency caching still wraps the WHOLE dispatch (the cache
  hit short-circuits the HTTP call too — for `wait: true` the
  cached child response is replayed; for `wait: false` the cached
  dispatch metadata is returned).

**Not yet shipped**:
- Studio `↳ async` indicator distinguishing sync vs async sub-
  workflow steps in StepRail. Currently both show `↳ sub`; the
  Sub-runs strip on the parent surfaces the actual status.
- Cancellation API for fire-and-forget children
  (`POST /__blok/runs/:childId/cancel`).
- Cross-process latest-payload-wins for the `wait: false`
  http-self path — today the parent's resolved inputs are
  serialized as the body once; if the parent re-runs (replay),
  the body comes from the new run's inputs.

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
- SQLite (default for production; single-process via SQLite locks).
- InMemory (dev / tests).
- Postgres is hybrid: sync reads from an in-memory mirror; writes
  async-persist to the `concurrency_locks` table (migration v3,
  shipped in commit `f735efe`). `loadRecent()` rehydrates the mirror
  on boot so leases survive process restart within a single
  PG-backed process. **Cross-process** coordination still requires
  the dedicated `BLOK_CONCURRENCY_BACKEND=nats-kv` backend (see
  below) — PG persistence here is for crash-recovery only.

**Cross-process backend (Tier 2 #6 follow-up + Tier C #4)**:
- Set `BLOK_CONCURRENCY_BACKEND=nats-kv` (or `redis`) to switch the
  gate from local store to a backend with cross-process semantics.
  Default unset / `"memory"` preserves single-process behavior with
  zero overhead.
- **NATS KV** (default cross-process option since Tier 2 #6) — Storage
  model: one JSON document per `(workflowName, concurrencyKey)` bucket
  with revision-based compare-and-swap (OCC). Acquire = read + filter
  expired + check limit + CAS update; bounded retry (10) + fail-closed
  on retry exhaustion. Per-bucket lazy-purge inside acquire. Env vars:
  `BLOK_CONCURRENCY_NATS_SERVERS` (comma-separated URLs),
  `BLOK_CONCURRENCY_NATS_TOKEN`, `BLOK_CONCURRENCY_NATS_USER`,
  `BLOK_CONCURRENCY_NATS_PASS`, `BLOK_CONCURRENCY_NATS_KV_BUCKET`
  (default `"blok-concurrency"`).
- **Redis** (Tier C #4) — Same storage shape (`{leases:[…]}` per
  bucket) but atomicity comes from server-side **Lua scripts** —
  acquire/release/purge each run as a single `EVAL`, so there is no
  OCC retry loop (Lua runs single-threaded against the keyspace).
  Connection defaults `connectTimeout: 5s`, `maxRetriesPerRequest: 0`,
  `enableOfflineQueue: false`, `lazyConnect: true` — fail-fast on
  broker outage instead of buffering. Env vars:
  `BLOK_CONCURRENCY_REDIS_URL` (preferred — `redis://...`), or
  `BLOK_CONCURRENCY_REDIS_HOST`, `_PORT`, `_USERNAME`, `_PASSWORD`,
  `_DB`, `_TLS=1`, and `BLOK_CONCURRENCY_REDIS_KEY_PREFIX` (default
  `"blok-concurrency"`).
- `RunTracker.acquireConcurrencySlot` and `releaseConcurrencySlot`
  become async — when a backend is set, calls are awaited; when null
  (default), the existing sync store impl is wrapped in `Promise.resolve`.
  `TriggerBase.run`'s gate already runs in async context; release in
  the finally block is fire-and-forget.
- `HttpTrigger.listen()` and `WorkerTrigger.listen()` instantiate the
  backend via `createConcurrencyBackend()` and install it via
  `RunTracker.setConcurrencyBackend()` before serving traffic. Connect
  errors log + fall back to the in-process behavior.
- Trade-offs: NATS KV pays an OCC round-trip per acquire and caps
  retries at 10 under contention; Redis pays one Lua eval per acquire
  with no retry (atomic on the server). For very high-cardinality
  buckets (>50 active leases each) both backends will scale better
  with a per-lease key model — revisit when a real workload demands it.
- **FW-5 production refusal**: both backends refuse to start in
  production with the default bucket name / key prefix
  (`blok-concurrency`). Two deployments sharing one broker would
  silently corrupt each other's `(workflow, key)` buckets — operators
  MUST set `BLOK_CONCURRENCY_NATS_KV_BUCKET` /
  `BLOK_CONCURRENCY_REDIS_KEY_PREFIX` per deployment.

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

**Cross-process debounce backend (Tier C #1)**:
- Set `BLOK_DEBOUNCE_BACKEND=nats-kv` or `BLOK_DEBOUNCE_BACKEND=redis`
  to coordinate debounce windows across processes. Default unset / `"memory"`
  preserves the in-memory `DebounceCoordinator` fast path with zero overhead.
- Storage model: one shared document per `(workflowName, debounceKey)`
  bucket holding `{mode, delayMs, maxDelayMs?, maxDelayDeadline?,
  firstPingAt, lastPingAt, pingCount, activeRunId, ownerProcessId,
  ownerLeaseExpiresAt, scheduledAt}`. Atomicity via Lua (Redis —
  single round-trip, no OCC retry loop) or revision-based CAS
  (NATS KV — bounded 10-retry loop, over-coalesce on exhaustion).
- Protocol: each ping calls `backend.registerPing()` → one of three
  outcomes:
  - **owner-new**: fresh window OR owner-lease expired handoff. Caller
    is the new owner; starts a local timer to fire at `scheduledAt`.
  - **owner-extend**: caller IS the existing owner; refresh lease +
    scheduledAt; replace local timer + closure.
  - **coalesce**: another process owns the window; this ping just
    bumps `pingCount` + pushes `scheduledAt`. Caller marks the run
    `debounced` with `intoRunId = activeRunId`.
- Owner-death recovery: `ownerLeaseExpiresAt` bounds how long a dead
  owner blocks ownership. Next ping after the lease expires takes
  over. Janitor sweep purges expired buckets.
- Local timer fire: owner calls `backend.finalize()` → atomic
  `{fire, reschedule, abandoned}`. Coalesce pings from other
  processes pushing `scheduledAt` forward trigger reschedule;
  lease-handoff while the timer was pending triggers abandon.
- **Owner-local payload semantic** (the cross-process trade-off):
  only the owning process's captured `onFire` closure fires. Coalesce
  pings on other processes write to the shared doc but their
  payloads are dropped — cross-process latest-payload-wins is a
  deferred follow-up that would require persisting each ping's
  payload to the shared doc (subject to a size cap mirroring
  `BLOK_DISPATCH_PAYLOAD_MAX_BYTES`).
- Env vars: `BLOK_DEBOUNCE_BACKEND`, `BLOK_DEBOUNCE_OWNER_LEASE_MS`
  (default 60s), `BLOK_DEBOUNCE_NATS_*` (servers/token/user/pass + bucket
  `BLOK_DEBOUNCE_NATS_KV_BUCKET`, FW-5 production refusal on default
  `"blok-debounce"`), `BLOK_DEBOUNCE_REDIS_*` (URL or discrete host/
  port/credentials + `BLOK_DEBOUNCE_REDIS_KEY_PREFIX`, FW-5 production
  refusal on default `"blok-debounce"`).
- Wired in: `HttpTrigger.listen()` and `WorkerTrigger.listen()` call
  `createDebounceBackend()` + `DebounceCoordinator.getInstance().setBackend()`
  on boot. Connect errors log + fall back to in-memory windows.
- Backend failure mode: `registerPing` errors → fail-open (admit the
  ping via local-in-memory window) rather than dropping it. Debounce
  is not a safety gate; over-coalesce is preferable to a missed run.

**Not yet shipped**:
- Long delays (>24h) — recommend cron trigger + external scheduler
  for those use cases.
- `mode: "throttle"` (rate-cap, fire every N ms regardless of pings).
- Dispatch-time payload merging (each ping CONTRIBUTES to the final
  payload, not just OVERWRITES). v1 ships "latest wins".
- Cross-process latest-payload-wins (payload-persisted variant of
  Tier C #1 above).

**Kill-switch**: `BLOK_SCHEDULING_DISABLED=1` short-circuits all
gates → runs proceed synchronously even if configured with delay/
ttl/debounce.

**NATS adapter consumer-side x-delay**: shipped in commit `6caa7df`
(Tier 2 polish bundle). `NATSAdapter.computeXDelayHoldMs` enforces
the `x-delay` header on the consumer side via setTimeout-based hold
before invoking the handler. Single-process trade-off: a long delay
holds one consumer slot for its duration. For long delays prefer the
trigger-level `delay` (sqlite-backed durable scheduler) over a
queue-level delay header.

## Cancellation, crashes, janitor, observability (Tier 2 follow-ups)

A bundle of operational primitives shipped in commits `f828631`,
`7ae309d`, `7624e49`, `8d998fb`, `6caa7df`.

**Cooperative cancellation** — every ctx now carries `ctx.signal:
AbortSignal` (created by `TriggerBase.createContext` and stashed on
`ctx._PRIVATE_.abortController`). `POST /__blok/runs/:runId/cancel`
fires the signal via `tracker.abortRunningRun(runId)` AND flips run
status to `"cancelled"`. `RunnerSteps` checks `ctx.signal.aborted`
between steps and throws `RunCancelledError`. Nodes performing
long-running work should consult `ctx.signal.aborted` periodically
or pass the signal to fetch: `await fetch(url, { signal: ctx.signal })`.
Sub-workflow children inherit a chained AbortSignal — parent abort
cascades to in-flight children automatically.

**Cancellation across re-entry** (was BACKLOG A2 — SHIPPED `7605bb7`):
the deferred-dispatch reentry branch re-registers the AbortController
on `tracker.abortControllers`, so `tracker.abortRunningRun(runId)` now
fires the signal correctly after a `delayed` / `debounced` / `queued`
run resumes. `RunCancelledError` also passes through `RunnerSteps`'s
outer `GlobalError` wrapper unwrapped so `TriggerBase.run`'s
`instanceof` discrimination works in production.

**Crash auto-flip + orphan recovery** —
`TriggerBase.installCrashHandlers()` registers `uncaughtException` +
`unhandledRejection` handlers that synchronously flip every in-flight
`running` run to `"crashed"` before the process dies (re-throws so
Node still exits). `TriggerBase.recoverOrphanedRuns()` is a boot
scan that flips runs older than `BLOK_ORPHAN_THRESHOLD_MS` (default
2min) to `"crashed"`. Both wired into HTTP + Worker `listen()`.
Kill-switch: `BLOK_CRASH_AUTOFLIP_DISABLED=1`.

**Orphan recovery is page-aware** (was BACKLOG A1 — SHIPPED `7605bb7`):
`markAllRunningRunsAsCrashed` loops `store.getRuns({status: "running"})`
in pages until drained instead of inheriting the default `LIMIT=50`.
Page-aware short-circuit: exits early when a page returns fewer rows
than the page size. A process that died with N orphaned `running` runs
no longer leaves N-50 stuck.

**Janitor** — periodic background sweep (`Janitor` singleton in
`src/tracing/Janitor.ts`). Default 5min interval (override via
`BLOK_JANITOR_INTERVAL_MS`); kill-switch `BLOK_JANITOR_DISABLED=1`.
Sweeps three lazy-purge methods on schedule: `purgeExpiredIdempotencyCache`,
`purgeExpiredConcurrencySlots`, `purgeExpiredScheduledDispatches`.
`unref()`'d so it doesn't keep the event loop alive on its own.
`inFlight` flag prevents overlapping sweeps under slow stores.

**Observability endpoints** —
- `GET /__blok/concurrency/health` returns `{backend, disabled, leaseMs}`.
- `GET /__blok/concurrency/state` returns
  `{totalBuckets, totalLeases, buckets[]}` with active leases per
  `(workflow, key)` bucket. Powers Studio's `ConcurrencyTile`.

**OTel counters** (via `ConcurrencyMetrics` singleton):
- `blok_concurrency_acquired_total`
- `blok_concurrency_denied_total{mode}` (mode: `"throw"` | `"queue"`)
- `blok_concurrency_released_total`
- `blok_scheduling_dispatch_recovered_total`
- `blok_scheduling_dispatch_expired_total`
- `blok_scheduling_dispatch_fired_total`

No-op cleanly without an exporter; surfaced via the Prometheus
exporter automatically.

**Graceful shutdown** —
`TriggerBase.installShutdownHandlers(trigger, logger?)` registers
SIGTERM + SIGINT handlers. Drain order: `trigger.stop()` →
`Janitor.stop()` → `DeferredRunScheduler.clear()` (in-memory only;
persisted rows survive for next-boot recovery) →
`backend.disconnect()` (NATS drain) → `process.exit(0)`. Best-effort
errors caught + logged. Idempotent + opt-out via
`BLOK_GRACEFUL_SHUTDOWN_DISABLED=1`.

## On `wait.for("3 days")` and similar long-pause patterns

Blok does NOT yet ship a built-in `wait.for(duration)` step
primitive (Trigger.dev v3+ has one). The original ROADMAP framed
this as "needs CRIU or full state-machine rewrite — out of scope".
That framing was accurate when written but is no longer true after
the Tier 2 follow-ups. The composable building blocks now exist:

- **Durable scheduler** — `scheduled_dispatches` (migration v9) +
  `DeferredRunScheduler.schedule(..., persist={...})` persists a
  dispatch to sqlite BEFORE the timer fires. `recoverDispatches()`
  re-registers timers on boot.
- **Re-entry pattern** — `dispatchDeferred(ctx, traceRunId, expiresAt)`
  flips `_blokDispatchReentry = true` and re-enters `run(ctx)` with
  the same `traceRunId`. The re-entered run skips scheduling gates
  and reuses the existing run record.
- **Per-step checkpoint** — `idempotencyKey` per step caches the
  result against `(workflowName, stepId, key)`. On hit, the cached
  result replays through `applyStepOutput` and `step.process()` is
  never called. This is the de-facto checkpoint mechanism — re-runs
  from step 0 short-circuit completed steps.
- **Step-output persistence** — every NodeRun's inputs+outputs are
  persisted in `node_runs`.
- **Cooperative cancellation** — `ctx.signal` flows through to nodes
  that opt in.

What's missing is just the **step shape**: a `wait: { for, until }`
field that, on first invocation, schedules + throws
`DeferredDispatchSignal`; on re-entry, recognizes "I've already
waited" (via a sentinel idempotency cache hit OR a `lastCompletedStep`
field on the run) and continues to the next step.

Effort estimate: ~2-3 days. Matches the Tier 2 #4 (sub-workflow)
plan structure. Tracked in [BACKLOG.md](../../BACKLOG.md).

Until that ships, compose the same effect with sub-workflows:

```ts
// Workflow A — pre-wait
{ id: "queue-continuation", subworkflow: "post-wait-half",
  inputs: { state: $.state }, wait: false }

// Workflow B — has delay on its trigger
{ name: "post-wait-half",
  trigger: { http: { method: "POST", path: "/internal/...", delay: "3d" } },
  steps: [ /* the post-wait steps */ ] }
```

Author has to manually split the workflow at the wait boundary.
Less ergonomic than `wait.for()` but durable + crash-safe today.

## Input resolution (Mapper)

`@blokjs/shared`'s `Mapper` resolves `${path}` interpolations and
`js/...` expressions inside step `inputs` against the live `ctx`
(see `core/shared/src/utils/Mapper.ts`). Called from
`NodeBase.process` → `blueprintMapper` before every step runs.

**Failure mode is configurable** via the `BLOK_MAPPER_MODE` env var:

| Mode | Behavior on resolution failure |
|---|---|
| `warn` | Log a structured warning via `ctx.logger.logLevel("warn", ...)` (routes to console + Studio's log viewer via `TracingLogger`) and pass the literal expression string through to the node. The pre-fail-fast v1 behavior; opt-in. |
| `strict` | Throw `MapperResolutionError` with full context (workflow name, step name, expression, underlying cause + heuristic hint). The step fails fast. **Recommended for production.** |
| `silent` | Pre-v0.3.x behavior — full suppression (no log, no throw). Opt-out for tests / workflows that intentionally use undefined-tolerant resolution. |

`strict` is now the default (fail-fast) —
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
bun run test:dev                   # Watch mode
bun run test                       # Single run
bun run test:integration           # Integration tests
bun run test:all                   # Unit + integration
```
