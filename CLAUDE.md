# Blok Framework — Claude Code Guide

Read `AGENTS.md` for full architecture, APIs, and patterns. This file contains Claude-specific operational guidance.

## Quick Commands

```bash
bun install                        # Install dependencies
bun run build                      # Build all packages
bun run test                       # Run all tests
bun run lint                       # Lint with Biome
bun run http:dev                   # Start HTTP trigger dev server
bun run runner:test                # Test runner in watch mode
bun run core:build:dev             # Watch-build all core packages
blokctl dev                        # Full dev server (spawns runtimes + runner)
blokctl create node <name>         # Scaffold a new node
blokctl create workflow <name>     # Scaffold a new workflow
blokctl trace                      # Open Blok Studio
```

## Context Rules (Memorize These) — Workflow v2

1. **Every step's output is auto-persisted to `ctx.state[id]`** — *on success only*. A step that throws does NOT write state. `ctx.state[<step-id>] === undefined` is a truthful "did this step actually succeed?" check inside a `tryCatch.catch` arm. (Pre-v0.5.1 the runner persisted an empty envelope on error; centralized fix in `core/runner/src/workflow/PersistenceHelper.ts:applyStepOutput`.) No `set_var` flag needed for success persistence — it's the default. Other steps reference it via `$.state.<id>` in their inputs.
2. **`ctx.prev` is the immediately previous step's output.** Overwritten on every step. Use for adjacent reads only; for cross-step access use `ctx.state[<id>]`.
3. **Blueprint Mapper resolves `$.<path>` and `js/...` expressions BEFORE node execution.** Authors write `$.state.users` (typed in TS, plain string in JSON); the runner resolves it.
4. **Opt out of persistence with `ephemeral: true`** on the step. Side-effect-only steps (logging, audit) typically do this.
5. **Multi-output nodes:** add `spread: true` to flatten `result.data` keys into `ctx.state` instead of nesting under the step's id. Useful in data-pipeline workflows.
6. **Rename outputs:** `as: "<name>"` stores the result at `ctx.state[<name>]` instead of `ctx.state[<id>]`. Mutually exclusive with `spread`.
7. **Cache expensive steps:** add `idempotencyKey: "<string>"` (literal or `$.<path>`). On rerun with the same triple `(workflow, step.id, key)`, the runner replays the cached result through the same persistence rules and skips `step.process()`. Default TTL 24h; override per step via `idempotencyKeyTTL: <ms>`. Caching layers ABOVE persistence — `ephemeral`/`spread`/`as` apply identically to cached and fresh results.
8. **Retry transient failures:** add `retry: { maxAttempts, minTimeoutInMs?, maxTimeoutInMs?, factor? }`. Per-attempt failures emit `NODE_ATTEMPT_FAILED` and surface in Studio. Default behaviour is no retry (`maxAttempts: 1`).
9. **Invoke another workflow as a step:** `{ id: "X", subworkflow: "<name>", inputs: {...} }`. Child runs in its own ctx with isolated `state`; parent step's `inputs` becomes child `ctx.request.body`. **`wait: true` (default)** — child's `ctx.response` lands on parent's `state[<id>]`; parent step blocks until child completes. **`wait: false`** — parent step returns immediately with `{runId, workflowName, scheduledAt}`; child runs asynchronously via `setImmediate`, errors caught + routed to `tracker.failRun` + `console.error`. Compose with `idempotencyKey`: with `wait: true`, cache the entire child result (skip side effects on hit); with `wait: false`, cache the dispatch metadata for at-most-once dispatch dedup (Trigger.dev / Stripe semantics — same `runId` returned regardless of child outcome; new key needed to retry on failure). Recursion capped at `BLOK_MAX_SUBWORKFLOW_DEPTH` (default 10).
10. **Per-tenant rate limiting on triggers:** add `concurrencyKey: $.<path>` (with optional `concurrencyLimit`, defaults to `1`) to the trigger config (HTTP or Worker). At run-entry the gate resolves the key against ctx, attempts to acquire a slot, and on denial: HTTP returns `429` with `Retry-After`; Worker NACKs with redelivery. Distinct run state `"throttled"` (NOT `"failed"` — no step ran). Default lease 1h (override via `concurrencyLeaseMs` per-trigger or `BLOK_CONCURRENCY_LEASE_MS` env). Sub-workflow steps DO NOT contend for the parent's slot. Kill-switch: `BLOK_CONCURRENCY_DISABLED=1`. **Backends**: default in-process (single-process via SQLite locks); set `BLOK_CONCURRENCY_BACKEND=nats-kv` for cross-process coordination via a NATS KV bucket (one JSON document per `(workflow, key)` with revision-based CAS; see `BLOK_CONCURRENCY_NATS_*` env vars), or `BLOK_CONCURRENCY_BACKEND=redis` for the Redis equivalent (same JSON-doc shape, server-side Lua scripts for single-round-trip atomic acquire — no OCC retry loop; see `BLOK_CONCURRENCY_REDIS_*` env vars). **`onLimit: "queue"` (Tier 2 #6 follow-up)**: instead of throwing on denial, defer the run via `DeferredRunScheduler` and re-attempt acquisition after a 1s delay. HTTP returns `202 Accepted` + `Location`, Worker ACKs without retry. New run state `"queued"` (transient — transitions to `running` when the timer fires and the gate grants; flips back to `queued` on re-denial). Indefinite retry; the trigger-level lease (default 1h) bounds slot leaks if a holder dies. `RUN_QUEUED` event carries `{concurrencyKey, concurrencyLimit, currentInFlight, scheduledAt}`.
11. **Schedule / TTL / debounce on triggers (Tier 2 #5+#7):** `delay: "1h"` (or ms number) defers the run; `ttl: "30m"` expires if not started in time; `debounce: { key, mode, delay, maxDelay? }` collapses rapid same-key triggers. HTTP returns `202 Accepted` + `Location: /__blok/runs/:id` for deferred runs. Worker ACKs without retry (the in-process scheduler owns the eventual dispatch). New run states `"delayed"`, `"expired"`, `"debounced"`. Debounce modes: `trailing` (default — wait for silence) and `leading` (fire immediately, suppress follow-ups). One run record per ping; coalesce losers get `debounced` terminal status pointing at the active run via `intoRunId`. Kill-switch: `BLOK_SCHEDULING_DISABLED=1`. **Durability (Tier 2 #5+#7 follow-up)**: HTTP delay/queue dispatches now persist to sqlite (`scheduled_dispatches` table, migration v9). On `HttpTrigger.listen()`, `recoverDispatches()` scans the table, marks past-TTL rows as `expired`, and re-registers timers for live rows. Persisted payload is the request subset (method/path/headers/body/params/query) with sensitive headers stripped (authorization, cookie, x-api-key). **Cross-process scheduler (Tier C #2)**: sqlite migration v13 + PG migration v6 add `claimed_by` + `claimed_at` columns to `scheduled_dispatches`; `RunStore.claimDispatches(processId, leaseMs, now)` atomically takes ownership during recovery so multi-process PG deployments don't double-fire. `DeferredRunScheduler` heartbeats `claimed_at` (default 20s; `BLOK_SCHEDULER_HEARTBEAT_INTERVAL_MS`) while ≥1 persisted entry is registered; dead-process claims expire after `BLOK_SCHEDULER_CLAIM_LEASE_MS` (default 60s) and a surviving process takes over. Opt-out: `BLOK_SCHEDULER_CLAIM_DISABLED=1`. **Cross-process debounce (Tier C #1)**: set `BLOK_DEBOUNCE_BACKEND=nats-kv` or `redis` to coordinate debounce windows across processes. One shared doc per `(workflow, debounceKey)` bucket with owner-lease attribution; Redis uses Lua, NATS KV uses revision-based CAS. Owner-local payload semantic — only the owning process's captured closure fires; coalesce pings on other processes bump `pingCount` + push `scheduledAt` but their payloads are dropped (cross-process latest-payload-wins is a deferred follow-up). Default unset = in-memory window coordination preserved.
12. **Per-step `maxDuration` + tags/metadata filters (Tier 2 quick-wins):** add `maxDuration: "30s"` (number ms or duration string) to any v2 step. Each retry attempt gets its own timeout; on final-attempt timeout, run auto-flips to `"timedOut"` (distinct from `"failed"` so SLA dashboards separate timeouts from logic failures). `StepTimeoutError` exported from `@blokjs/runner`. Two new run states `"crashed"` and `"timedOut"` plus matching `RUN_CRASHED` + `RUN_TIMED_OUT` events. **Crash auto-flip (follow-up)**: `TriggerBase.installCrashHandlers()` registers process-level `uncaughtException` + `unhandledRejection` handlers that flip every in-flight `running` run to `"crashed"` before the process dies. `TriggerBase.recoverOrphanedRuns()` is a boot scan that flips `running` runs older than `BLOK_ORPHAN_THRESHOLD_MS` (default 2min) to `"crashed"` — catches signal/OOM deaths where the handler never fired. Both wired into HttpTrigger + WorkerTrigger `listen()`. Kill-switch: `BLOK_CRASH_AUTOFLIP_DISABLED=1`. **Cooperative cancellation (follow-up)**: every ctx now carries `ctx.signal: AbortSignal`. `POST /__blok/runs/:runId/cancel` works on `running` runs by firing the signal via `tracker.abortRunningRun(runId)` AND flipping status to `"cancelled"`. `RunnerSteps` checks `ctx.signal.aborted` between steps and throws `RunCancelledError`. Nodes performing long-running work should consult `ctx.signal.aborted` periodically — or pass it to fetch: `await fetch(url, { signal: ctx.signal })`. Studio's runs list gains tags filter (comma-separated, AND semantics) + metadata filter (`metadata.<key>=<value>`, AND across keys). `RunQuery.metadata?: Record<string, string>` on the API; SqliteRunStore uses `json_extract`, InMemoryRunStore uses object lookup.
13. **Janitor + observability + graceful shutdown (Tier 2 follow-up + PR 2 hardening):** `Janitor` singleton runs a periodic background sweep that purges expired rows from `idempotency_cache`, `concurrency_locks`, and `scheduled_dispatches`. Default 5min interval (override via `BLOK_JANITOR_INTERVAL_MS`); kill-switch `BLOK_JANITOR_DISABLED=1`. Wired into `HttpTrigger.listen()` + `WorkerTrigger.listen()`. **Observability endpoints**: `GET /__blok/concurrency/health` returns `{backend, disabled, leaseMs}`; `GET /__blok/concurrency/state` returns `{totalBuckets, totalLeases, buckets[]}` with active leases per `(workflow, key)` bucket (powers Studio's `ConcurrencyTile`). **OTel counters** via `ConcurrencyMetrics` singleton: `blok_concurrency_acquired_total` / `denied_total{mode}` / `released_total` / `blok_scheduling_dispatch_recovered_total` / `expired_total` / `fired_total`. **Graceful shutdown**: `TriggerBase.installShutdownHandlers(trigger)` registers SIGTERM + SIGINT handlers that drain in order: `trigger.stop()` → `Janitor.stop()` → `DeferredRunScheduler.clear()` → `backend.disconnect()`. Best-effort errors caught + logged. Kill-switch: `BLOK_GRACEFUL_SHUTDOWN_DISABLED=1`. **Durable scheduler payload cap (PR 2 A4)**: `extractDispatchPayload` caps the JSON-serialized payload at `BLOK_DISPATCH_PAYLOAD_MAX_BYTES` (default 1MB). Overflow throws `PayloadTooLargeError` → HTTP 413 with structured info. Operators with media-upload workflows raise the cap or pre-strip the body before deferring.
14. **Process-global middleware (v0.5.4):** `WorkflowRegistry.getInstance().setGlobalMiddleware(["request-id", "audit-log"])` — applies to EVERY workflow run in the process, prepended before any workflow- or trigger-level chain. Used for ops concerns (request correlation, audit logging, tracing) that should wrap all workflows uniformly without per-file changes. Env-var fallback: `BLOK_GLOBAL_MIDDLEWARE=name1,name2`. Resolution order outer→inner: process-global → workflow-level (`workflow.middleware: [...]`) → trigger-level (`trigger.<kind>.middleware: [...]`) → workflow body. Snapshot is frozen; setter accepts repeated calls (last-wins); empty array clears. `clear()` (HMR re-scan) does NOT reset the global chain — operator state survives.

When a user has data flow issues, check these rules first.

### v1 → v2 mapping (legacy compatibility)

Old (v1) workflows keep working — the runner normalizes them at load time:

| v1 | v2 | notes |
|---|---|---|
| `steps[].name` + `nodes[name]{inputs}` | `steps[].id` + `steps[].inputs` (inline) | one source of truth for step identity |
| `steps[].node` | `steps[].use` | clearer intent |
| `set_var: true` | (default) | every step auto-stores |
| `set_var: false` | `ephemeral: true` | normalized 1:1 |
| `js/ctx.vars['x']` | `$.state.x` (or `js/ctx.state.x`) | `ctx.vars` aliases `ctx.state` for back-compat |
| `js/ctx.response.data` | `$.prev.data` (or `js/ctx.prev.data`) | `ctx.response` aliases `ctx.prev` |
| `js/ctx.request.body` | `$.req.body` | `ctx.req` aliases `ctx.request` |
| `addCondition + new AddIf().build()` | `branch({when, then, else})` | one primitive |
| `method: "*"` | `method: "ANY"` | normalizer warns + auto-converts |

## Debugging Workflows

### Step 1: Verify workflow structure
- v2: every step has an `id` and a `use` (node reference). `inputs` lives on the step itself.
- v1 (legacy): `steps[].name` must match a key in `nodes{}`. The runner normalizes this on load — but the v2 shape is preferred for new workflows.
- `type` is optional in v2: inferred from `use` when absent (defaults to `"module"`).

### Step 2: Trace data flow through ctx.state
- Every step's output lands in `ctx.state[id]` automatically. Reference it from a later step's inputs as `$.state.<id>` (TS) or `"$.state.<id>"` (JSON, plain string).
- Adjacent steps can read `ctx.prev.data` (the previous step's full envelope).
- If a step has `spread: true`, its `result.data` keys are merged INTO `ctx.state` directly — `state.foo`, `state.bar` instead of `state.<id>.foo`.
- If a step has `ephemeral: true`, it's NOT in `ctx.state` — only `ctx.prev` carries it to the immediately next step.

### Step 3: Check runtime connectivity
- Is the SDK container running? Check `GET http://localhost:{port}/health`
- Correct ports: Go:9001, Rust:9002, Java:9003, C#:9004, PHP:9005, Ruby:9006, Python3:9007
- Check env vars: `RUNTIME_{LANG}_HOST` and `RUNTIME_{LANG}_PORT`

### Step 4: Inspect Blok Studio traces
- Navigate to `http://localhost:{runner-port}/__blok/runs`
- Each run shows all steps with inputs, outputs, and errors
- Check `depth` field — nested steps come from flow nodes (if-else)

### Common Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `Node type X not found` | Missing runtime resolver | Add `runtime.X` to `nodeTypes()` in Configuration.ts |
| `Validation failed: field (...)` | Zod schema mismatch | Check input schema vs actual data passed to node |
| `Runtime execution error` | SDK container not running | Start runtime, verify health endpoint |
| `ctx.state['X'] is undefined` | Step X has `ephemeral: true`, OR the id doesn't match what's referenced in `$.state.<id>` | Remove `ephemeral`, or fix the id reference |
| `Node X not found` | Module not registered | Check GlobalOptions.nodes registration |
| `as and spread are mutually exclusive` | Step has both fields set | Pick one — `as: "name"` to rename, `spread: true` to flatten |
| `branch step is missing 'when'` | Branch with no condition string | Set `when: "..."` (or pass a `$` proxy expression) |
| `Two workflows claim GET /path` | Route collision in file-based routing | Set explicit `trigger.http.path` on one to disambiguate |
| `[blok][mapper] Failed to resolve ...` | A `js/...` or `${...}` expression in step inputs threw at run time (typo, undefined access, syntax error). Default mode logs + passes the literal string through (silent miscompile risk). | Read the hint in the warning. Set `BLOK_MAPPER_MODE=strict` to fail fast in production — the `MapperResolutionError` carries workflow + step + expression context. |

### Production env vars worth setting

- `BLOK_MAPPER_MODE=strict` — fail-fast on input expression resolution errors. Strongly recommended for production. Default `warn` preserves v1 silent-fallback behavior with diagnostics.
- `BLOK_TRACE_ENABLED=false` — disable Studio trace recording (also disables idempotency cache reads/writes since they share the store).
- `BLOK_MAX_SUBWORKFLOW_DEPTH=10` — recursion cap for sub-workflow steps. Bump if you have legitimate deep nesting.

## Generating Node Code

Always use `defineNode()`. Never create class-based BlokService nodes.

```typescript
import { defineNode } from "@blokjs/runner";
import { z } from "zod";

export default defineNode({
  name: "node-name",
  description: "What this node does",

  input: z.object({
    // Define all expected inputs with Zod
  }),

  output: z.object({
    // Define the output shape with Zod
  }),

  async execute(ctx, input) {
    // input is validated and type-safe
    // Return must match output schema
    return { /* output */ };
  },
});
```

### Checklist for generated nodes:
- Zod input schema covers all expected inputs
- Zod output schema matches what execute() returns
- Node name matches what workflows will reference
- Error cases throw Error (auto-wrapped to GlobalError with 500)
- No `any` types — use `z.unknown()` if truly dynamic

## Generating TypeScript Workflows (v2 — Preferred)

Always prefer TypeScript workflows over JSON. They live in `triggers/http/src/workflows/` and are organized in domain-specific subfolders.

### Simple Workflow

```typescript
import { workflow, $ } from "@blokjs/helper";

export default workflow({
  name: "Workflow Name",
  version: "1.0.0",
  description: "What this workflow does",
  trigger: {
    http: {
      method: "POST",          // Use "ANY" for all methods (not "*")
      path: "/api/endpoint",   // Optional — when omitted, URL is derived from the file path
    },
  },
  steps: [
    {
      id: "echo",
      use: "@blokjs/respond",
      inputs: { body: $.req.body },
    },
  ],
});
```

### Multi-step Workflow (using $.state to chain outputs)

```typescript
import { workflow, $ } from "@blokjs/helper";

export default workflow({
  name: "Fetch and Respond",
  version: "1.0.0",
  trigger: { http: { method: "GET" } },
  steps: [
    {
      id: "fetch",
      use: "@blokjs/api-call",
      inputs: { url: "https://countriesnow.space/api/v0.1/countries" },
    },
    {
      id: "respond",
      use: "@blokjs/respond",
      inputs: { body: $.state.fetch },   // $.state.<id> compiles to "js/ctx.state.fetch"
    },
  ],
});
```

### Conditional Workflow (branch primitive)

```typescript
import { workflow, branch, $ } from "@blokjs/helper";

export default workflow({
  name: "Method Router",
  version: "1.0.0",
  trigger: { http: { method: "ANY" } },
  steps: [
    branch({
      id: "route",
      when: '$.req.method === "POST"',
      then: [
        { id: "create", use: "@blokjs/api-call", inputs: { url: "..." } },
      ],
      else: [
        { id: "read",   use: "@blokjs/api-call", inputs: { url: "..." } },
      ],
    }),
  ],
});
```

### Data-pipeline pattern (spread)

When a node returns multiple named outputs and you want each at the top level of state:

```typescript
{
  id: "load",
  use: "fetch-user-and-profile",
  spread: true,  // result.data = { user, profile }  →  state.user + state.profile
}
```

### Persistence knobs (per-step declarative)

| Knob | Effect |
|---|---|
| (none) | Default: store at `state[id]` |
| `as: "name"` | Store at `state[name]` instead of `state[id]` |
| `spread: true` | Shallow-merge `result.data` keys into `state` (mutually exclusive with `as`) |
| `ephemeral: true` | Skip storage; only `ctx.prev` carries the result to the next step |

### Checklist for generated TypeScript workflows:
- Import `{ workflow, $, branch }` from `@blokjs/helper` (use `branch` for if/else)
- Default export is the result of `workflow({...})` — not a chained builder
- Use `"ANY"` for wildcard HTTP method (not `"*"`)
- Reference earlier outputs with `$.state.<id>` (typed proxy) or hand-written `"js/ctx.state.<id>"` strings
- `id` is required on every step; `use` replaces the legacy `node` field
- `as` and `spread` are mutually exclusive — pick one
- `path` is optional on the trigger — when omitted, URL is derived from the file path under `workflows/`
- Version follows semver (x.x.x)
- Workflow name is 3+ characters

### Legacy DSL (`Workflow`, `addTrigger`, `addStep`, `addCondition`, `AddIf`, `AddElse`)
Still supported and normalized at workflow load time. New workflows should use the v2 DSL above.

## Generating Workflow JSON (v2 — Mirrors TS exactly)

JSON workflows live in `triggers/http/workflows/json/` (recursively — subfolders are scanned). The JSON shape mirrors the TS DSL one-for-one so an LLM that learns one knows the other.

```json
{
  "name": "Workflow Name",
  "version": "1.0.0",
  "description": "What this workflow does",
  "trigger": {
    "http": { "method": "POST", "accept": "application/json" }
  },
  "steps": [
    {
      "id": "fetch",
      "use": "@blokjs/api-call",
      "inputs": { "url": "https://example.com/api" }
    },
    {
      "id": "respond",
      "use": "@blokjs/respond",
      "inputs": { "body": "$.state.fetch" }
    }
  ]
}
```

### Branch (if/else) in JSON

```json
{
  "id": "route",
  "branch": {
    "when": "$.req.method === 'POST'",
    "then": [{ "id": "create", "use": "@blokjs/api-call", "inputs": { "url": "..." } }],
    "else": [{ "id": "read",   "use": "@blokjs/api-call", "inputs": { "url": "..." } }]
  }
}
```

### File-based URL routing (recursive scan)

When `BLOK_FILE_BASED_ROUTING=true` is set, JSON workflows under `workflows/json/` are scanned recursively. The URL is derived from the file path:

| File path | URL |
|---|---|
| `workflows/json/health.json` | `/health` |
| `workflows/json/users/list.json` | `/users/list` |
| `workflows/json/users/index.json` | `/users` |
| `workflows/json/users/[id].json` | `/users/:id` |
| `workflows/json/users/[id]/orders.json` | `/users/:id/orders` |

Files/folders starting with `_` or `.` are skipped (utility files, drafts).

If `trigger.http.path` is set explicitly, it overrides the file-derived URL.

### Checklist for generated JSON workflows:
- `id` is required on every step (replaces v1 `name`)
- `use` is required on every step (replaces v1 `node`)
- `inputs` lives DIRECTLY on the step — no separate `nodes{}` map
- Reference earlier outputs as `"$.state.<id>"` strings (the runner converts `$.` to `js/ctx.` at load time; `js/ctx.state.<id>` also works)
- Use `"ANY"` for wildcard HTTP method (not `"*"`)
- For if/else: a single step with `id` + `branch: { when, then, else }`
- Subfolders work: organize by domain (`users/`, `orders/`, etc.)
- `path` on the trigger is optional — omit it to use file-based routing
- Version follows semver (x.x.x)

## Generating Worker Workflows

Worker workflows use the `worker` trigger to process background jobs from a queue. They follow the same pattern as HTTP workflows but with different trigger config.

```typescript
import { type Step, Workflow } from "@blokjs/helper";

const step: Step = Workflow({
  name: "Process Background Job",
  version: "1.0.0",
})
  .addTrigger("worker", {
    queue: "background-jobs",
    // concurrency: 5,     // Optional: max concurrent jobs
    // retries: 3,         // Optional: max retry attempts
    // timeout: 30000,     // Optional: job timeout in ms
  })
  .addStep({
    name: "process",
    node: "my-processor",
    type: "module",
    inputs: {
      payload: "js/ctx.request.body",         // Job data
      jobId: "js/ctx.request.params.jobId",   // Job ID
    },
  });

export default step;
```

### Worker context mapping:
- `ctx.request.body` → Job payload
- `ctx.request.params.queue` → Queue name
- `ctx.request.params.jobId` → Job ID
- `ctx.request.params.attempt` → Current attempt (0-based)
- `ctx.vars._worker_job` → Full job metadata

### Worker trigger adapters:
- **NATS JetStream** (`NATSWorkerAdapter`) — recommended for production
- **BullMQ** (`BullMQAdapter`) — Redis-based, supports priority/delayed jobs
- **InMemory** (`InMemoryAdapter`) — development/testing only

## Testing Nodes and Workflows

The `@blokjs/runner` package exports testing utilities. Use them with Vitest.

### Unit testing a node with NodeTestHarness:

```typescript
import { NodeTestHarness } from "@blokjs/runner";
import myNode from "../src/nodes/my-node";

const harness = new NodeTestHarness(myNode);

test("processes input correctly", async () => {
  const result = await harness.execute({ userId: "abc-123" });
  harness.assertSuccess(result);
  harness.assertOutput(result, { user: { id: "abc-123" } });
});
```

### Integration testing a workflow with WorkflowTestRunner:

```typescript
import { WorkflowTestRunner } from "@blokjs/runner";

const runner = new WorkflowTestRunner({ verbose: true, mockAllNodes: true });

runner.registerNode("validate", ValidateNode);
runner.mockNode("external-api", async (input) => ({ result: "mocked" }));

runner.loadWorkflow(myWorkflowDefinition);
const result = await runner.execute({ input: "data" });
expect(result.success).toBe(true);
expect(result.trace).toHaveLength(2); // Check execution trace
```

## Debugging Workers & NATS

### Step 1: Verify NATS connectivity
- Is NATS running? Check `nats-server` or Docker container
- Default URL: `localhost:4222`
- Health: `nats --server localhost:4222 server ping`

### Step 2: Check worker environment
- `NATS_SERVERS` set correctly?
- `WORKER_QUEUES` lists the queues the worker should consume?
- Standalone workers (Go/Rust/Python) connect directly to NATS, not through the TS runner

### Step 3: Verify job dispatch
- Jobs must be published to the correct NATS subject (queue name)
- Use `dispatch()` method or NATS CLI: `nats pub queue-name '{"data":"payload"}'`

### Common Worker Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `Failed to connect to NATS` | NATS server not running | Start NATS: `docker compose up nats` |
| `nats module not found` | Missing peer dependency | Install: `bun add nats` or `pip install nats-py` |
| `Job timed out` | Processing exceeded timeout | Increase `timeout` in trigger config or optimize node |
| `Max retries exceeded` | Job failing repeatedly | Check node error, job moves to DLQ after max retries |
| `Stream not found` | JetStream stream not created | Worker auto-creates streams on first subscribe |

## Helping Users with Blok Studio

- **Launch**: `blokctl trace` or navigate to `/__blok` on the running trigger
- **Run list**: Shows all workflow executions with status (running/completed/failed)
- **Run detail**: Expand to see each step's inputs, outputs, errors, and timing
- **Live updates**: SSE streaming updates runs in real-time
- **Metrics**: Shows execution count, duration, memory, CPU per workflow

Common user questions:
- "No output on step" → Node's execute() might not be returning data, or Zod output validation failed
- "Step shows error" → Expand error details, check if it's Zod validation (400) or runtime error (500)
- "Variables not passing" → Check that source step has `set_var: true` and target input uses `js/ctx.vars['name']`
- "Flow node skipping branches" → Check condition expression syntax in workflow JSON

## Do NOT

- Do NOT suggest class-based BlokService for new nodes — always use `defineNode()`
- Do NOT generate code with `any` types
- Do NOT assume `ctx.prev` (or `ctx.response.data`) persists across more than one step — use `ctx.state[<id>]` for cross-step access
- Do NOT write to `ctx.state` inside a node's `execute()` — return your output and let the runner persist it. If a node truly needs to publish a side-channel value, use `ctx.publish(name, value)`
- Do NOT use `set_var: true` in new workflows — the runner default-stores every step's output. Use `ephemeral: true` to opt out
- Do NOT use `"*"` for the HTTP wildcard method — use `"ANY"` (the runner accepts both for back-compat but warns)
- Do NOT skip Zod schemas when creating nodes
- Do NOT use ESLint/Prettier — this project uses Biome
- Do NOT edit files in `.blok/runtimes/` — they are auto-generated
