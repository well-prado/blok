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

## Tests

```bash
pnpm test:dev                      # Watch mode
pnpm test                          # Single run
pnpm test:integration              # Integration tests
pnpm test:all                      # Unit + integration
```
