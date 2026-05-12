# BACKLOG — what's left to do on Blok

**Date**: 2026-05-04
**Branch**: `feat/grpc` (pushed)
**Companion docs**: [REVIEW.md](REVIEW.md), [LOAD-TESTS.md](LOAD-TESTS.md)
**Status of the original ROADMAP** (`cmokx9n1n00267gmfgq79lqoi`): **complete** for Tier 1 + Tier 2 + quick wins. Tier 3 (CRIU-style checkpoint) explicitly out of scope.

**Detailed PR plans** (in `/Users/wellingtonprado/.claude/plans/`):
- [pr1-tier2-bug-fixes.md](../../.claude/plans/pr1-tier2-bug-fixes.md) — A1+A2+A3+H1+H2 ✓ SHIPPED `7605bb7`
- [pr2-tier2-production-hardening.md](../../.claude/plans/pr2-tier2-production-hardening.md) — A4+A5+A6+I2 ✓ SHIPPED `7b0f5c8`
- [pr3-tier2-observability-metrics.md](../../.claude/plans/pr3-tier2-observability-metrics.md) — D1+D2+D3+D5 ✓ SHIPPED `e21f0e7`
- [pr4-wait-for-step-primitive.md](../../.claude/plans/pr4-wait-for-step-primitive.md) — B1 wait.for() ✓ SHIPPED `20d3be1`
- [pr5-tier2-smaller-followups.md](../../.claude/plans/pr5-tier2-smaller-followups.md) — B2+B3+G1+E3 ✓ SHIPPED (this commit)

**ALL 5 PRs COMPLETE.** Tier A bugs + Tier B new features + Tier D observability + Tier G/E polish all shipped. The reliability surface is now production-ready with the headline `wait.for()` Trigger.dev parity feature.

This is the post-ROADMAP backlog. It rolls up:

- Bugs surfaced in [REVIEW.md](REVIEW.md) (2 HIGH, 4 MED).
- Smaller items the SHIPPED Tier 2 sessions explicitly deferred.
- One newly-feasible feature the original ROADMAP wrote off: `wait.for()` as a step primitive.
- Test-coverage gaps.
- Documentation drift.

Everything is an **author-decision**; ship in whatever order the user pulls. Severity / effort estimates are calibrated against a developer-laptop pace.

---

## Tier A — Correctness bugs (all SHIPPED)

> **All Tier A items shipped** via PRs #50 / #52 — commits `7605bb7`
> (A1 + A2 + A3) and `7b0f5c8` (A4 + A5 + A6). The descriptions below
> are preserved as engineering history; file:line refs may have drifted
> as the surrounding code evolved.

### A1 · Orphan-recovery LIMIT=50 cap

**Status**: SHIPPED in commit `7605bb7`.
**Severity**: HIGH. Silent data inconsistency at scale.
**Effort**: ~30 minutes + 1 regression test.
**Where**: [`core/runner/src/tracing/RunTracker.ts:436-448`](core/runner/src/tracing/RunTracker.ts#L436-L448) calls `this.store.getRuns({ status: "running" })` with no `limit`. SqliteRunStore at [`SqliteRunStore.ts:810`](core/runner/src/tracing/SqliteRunStore.ts#L810) defaults `opts?.limit ?? 50`. `recoverOrphanedRuns` ([`TriggerBase.ts:293-315`](core/runner/src/TriggerBase.ts#L293-L315)) calls this exactly once per boot.

**Symptom**: a process that died with N>50 orphaned `running` runs leaves N-50 stuck forever. Subsequent boots flip another 50 each (until rows age past `BLOK_ORPHAN_THRESHOLD_MS`).

**Confirmed by benchmark**: 10K seeded `running` rows → single call flips 50.

**Three viable fixes** (pick one):

1. Pass an explicit `limit: this.maxRuns` (or `Number.MAX_SAFE_INTEGER`) when querying for crash recovery.
2. Loop in chunks until `flipped === 0`. Cleaner — preserves the LIMIT default for normal queries.
3. Add a dedicated `RunStore.getRunsByStatus(status, opts?)` interface method without the pagination cap. Most invasive but most correct semantically (orphan recovery and the user-facing list view want different defaults).

**Recommended**: option 2 (loop in chunks). Lowest blast radius.

**Test plan**:
- New test in `__tests__/unit/tracing/RunTracker.crashAutoflip.test.ts` that seeds 200 `running` runs and asserts `recoverOrphanedRuns()` flips all 200.
- Add a per-pass progress log (`flipped X this pass; total Y`) so operators have visibility on long boots.

---

### A2 · Cancel-after-redispatch broken

**Status**: SHIPPED in commit `7605bb7`.
**Severity**: HIGH. Operator can't cancel runs that came from `delayed`/`debounced`/`queued`.
**Effort**: ~30 minutes + 1 regression test.
**Where**:
- [`TriggerBase.ts:489-495`](core/runner/src/TriggerBase.ts#L489-L495) registers the AbortController only on the FIRST pass.
- [`TriggerBase.ts:817-819`](core/runner/src/TriggerBase.ts#L817-L819) unregisters it in the FIRST pass's finally — even when the run defers and re-enters.
- [`TriggerBase.ts:459-462`](core/runner/src/TriggerBase.ts#L459-L462) reentry branch does NOT re-register.
- [`RunTracker.ts:581-599`](core/runner/src/tracing/RunTracker.ts#L581-L599) `abortRunningRun` finds no controller, skips abort, but `cancelRun(runId)` still flips status. Step keeps running. `completeRun` (line 760, no status guard) then overwrites `cancelled` → `completed`.

**Three viable fixes** (pick one):

1. **(Cleanest)** Add `tracker.registerAbortController(traceRunId, ctxRecord._PRIVATE_.abortController)` to the reentry branch in `TriggerBase.run` (~line 459). One line, mirrors the first-pass register.
2. Move the unregister out of the first-pass finally so the controller stays registered across the lifetime of the underlying logical run. Slightly trickier — needs a guard so re-entry doesn't double-register.
3. Make `cancelRun` / `abortRunningRun` look up the controller via `ctx._PRIVATE_.abortController` directly when `tracker.abortControllers.get(runId)` is null. Requires the tracker to know the ctx, which it doesn't (storing ctx is dangerous — large + has secrets).

**Recommended**: option 1.

**Test plan**:
- Schedule a delayed run.
- Wait for `dispatchDeferred` to re-enter (use fake timers).
- Call `tracker.abortRunningRun(runId)`.
- Assert `ctx.signal.aborted === true` AND the in-flight step throws `RunCancelledError`.
- Assert run status stays `cancelled` (not overwritten by `completeRun`).

**Bonus fix**: also add a status guard to `tracker.completeRun` and `tracker.failRun` so terminal states are never overwritten. Small defensive add; would have caught the bug.

---

### A3 · `createChildContext` listener leak

**Status**: SHIPPED in commit `7605bb7`.
**Severity**: MEDIUM. Memory pressure + Node `MaxListenersExceededWarning` on long-lived parents that fire many sub-workflows.
**Effort**: ~1 hour + 1 test.
**Where**: [`createChildContext.ts:60-72`](core/runner/src/utils/createChildContext.ts#L60-L72) attaches `addEventListener("abort", ..., { once: true })` to the parent's signal. `{ once: true }` only auto-removes when abort fires — if the parent never aborts, listeners accumulate.

**Symptom**: a parent run that fires 11+ sub-workflows triggers `MaxListenersExceededWarning`. At thousands of children, real memory accumulation.

**Two viable fixes**:

1. **(Cleanest)** Pass an `AbortSignal` as the listener's `signal` option (modern AbortSignal API supports this — when the listener's signal aborts, the listener auto-removes). The listener's signal is just the child's own signal — when the child completes (or is GC'd), the listener detaches.
2. Store the listener reference; expose a `cleanup()` method on the child ctx; call it on child completion.

**Recommended**: option 1. Three-line change.

```ts
// Before:
parent.signal.addEventListener("abort", handler, { once: true });

// After:
const cleanup = new AbortController();
parent.signal.addEventListener("abort", handler, {
  once: true,
  signal: cleanup.signal,
});
// On child completion / cancellation, call: cleanup.abort();
```

The "child completion" hook lives in `SubworkflowNode.run`'s finally / catch.

**Test plan**:
- Spawn 50 child contexts against the same parent.
- Verify Node's `getEventListeners(parent.signal)` (Node 19+ debug API) shows zero listeners post-completion.
- Assert no `MaxListenersExceededWarning` is emitted.

---

### A4 · `payload_json` size cap

**Status**: SHIPPED in commit `7b0f5c8`.
**Severity**: MEDIUM. Storage bloat + boot recovery latency.
**Effort**: ~1 hour.
**Where**: [`HttpTrigger.ts:789-809`](triggers/http/src/runner/HttpTrigger.ts#L789-L809) captures `req.body` raw. SQLite TEXT column has no size cap; PG JSONB likewise.

**Symptom**: a 50MB POST on a delayed trigger writes 50MB to sqlite per dispatch. With N delayed runs, sqlite size blows up. Boot recovery via `recoverDispatches` becomes O(N × payload_size).

**Fix**:
- Add `BLOK_DISPATCH_PAYLOAD_MAX_BYTES` env var (default 1MB).
- Before persisting in `extractDispatchPayload`, check serialized size.
- On overflow: log a structured warning + either reject the dispatch (HTTP 413 Payload Too Large) OR truncate body to a fixed marker. Pick one based on contract preference.

**Recommended behavior**: reject (413) on overflow. Silent truncation is worse than failing the request — a workflow that depends on full body would silently misbehave.

**Test plan**:
- Persist a payload over the cap → expect rejection.
- Persist under the cap → expect normal flow.
- Verify the cap is configurable via the env var.

---

### A5 · PG `loadRecent` reads unbounded

**Status**: SHIPPED in commit `7b0f5c8`.
**Severity**: MEDIUM. OOM at boot for long-lived processes.
**Effort**: ~2 hours.
**Where**: [`PostgresRunStore.ts`](core/runner/src/tracing/PostgresRunStore.ts) — `loadRecent()` reads `idempotency_cache`, `concurrency_locks`, `scheduled_dispatches` without LIMIT.

**Fix**:
- Add `LIMIT` to each new-table query. Sensible defaults: 10K rows.
- Add `WHERE expires_at IS NULL OR expires_at > now()` so expired rows are excluded.
- Document boot semantics: only un-expired rows hydrate the in-memory mirror. Expired rows are GC'd by the Janitor on the next sweep.

**Recommended**: default LIMIT 10K, configurable via `BLOK_PG_LOADRECENT_LIMIT`.

**Test plan**:
- Seed 100K idempotency_cache rows → verify boot doesn't OOM and only the most-recent N are mirrored.
- Verify expired rows are skipped.

---

### A6 · NATS KV `safeGet` swallows ALL errors

**Status**: SHIPPED in commit `7b0f5c8`.
**Severity**: MEDIUM. 10× latency hit on NATS broker outage.
**Effort**: ~30 minutes.
**Where**: [`NatsKvConcurrencyBackend.ts:304-310`](core/runner/src/concurrency/NatsKvConcurrencyBackend.ts#L304-L310). On any error from `kv.get`, returns null. The OCC retry loop interprets null as "no entry" → `kv.create` → throws → caught → continue, 10× before fail-closing.

**Fix**: distinguish "no entry" (broker says nothing's there) from "fetch failed" (broker unreachable):

```ts
private async safeGet(kv: NatsKv, key: string): Promise<NatsKvEntry | null | "fetch-failed"> {
  try {
    const e = await kv.get(key);
    return e ?? null;
  } catch (err) {
    // NATS errors with `.code === "NotFound"` are legitimate misses.
    if ((err as { code?: string }).code === "NotFound") return null;
    return "fetch-failed";
  }
}
```

Caller (`acquireSlot` / `releaseSlot`) checks for `"fetch-failed"` and short-circuits early instead of spinning.

**Test plan**:
- Add a fake-KV variant that throws non-`NotFound` errors → assert acquire fail-closes after 1 attempt, not 10.

---

## Tier B — New step primitives (feature work; depends on user pull)

### B1 · `wait.for(duration)` and `wait.until(date)` step primitive

**Status**: SHIPPED in commit `20d3be1`.
**Severity**: FEATURE (not a bug — currently composable via sub-workflows).
**Effort**: ~2-3 days end-to-end.
**Why now**: the original ROADMAP wrote this off as "needs CRIU." After Tier 2 follow-ups, every load-bearing primitive exists: durable scheduler, re-entry, idempotency caching as checkpoint, persisted step outputs, cooperative cancellation. Just need to expose the step shape.

**Author surface** (mirrors `branch:` and `subworkflow:`):

```ts
// TS DSL
{ id: "wait-3d", wait: { for: "3d" } }
{ id: "wait-deadline", wait: { until: $.req.body.scheduledAt } }
{ id: "wait-flexible", wait: { for: "1h", maxDuration: "2h" } } // bounds upper edge
```

```json
// JSON mirror
{ "id": "wait-3d", "wait": { "for": "3d" } }
{ "id": "wait-deadline", "wait": { "until": "$.req.body.scheduledAt" } }
```

**Implementation sketch**:

1. **Schema** — new `V2WaitStepSchema` in `core/workflow-helper/src/types/StepOpts.ts`. Reuses `DurationSchema` from `TriggerOpts.ts`. `for` and `until` are mutually exclusive (Zod refinement).
2. **Normalizer** — `normalizeWaitStep` in `WorkflowNormalizer.ts`. Discriminator: `typeof step.wait === "object" && (step.wait.for !== undefined || step.wait.until !== undefined)`.
3. **Resume strategy** (the key decision):
   - **(A) Idempotency-cache sentinel** — when the wait step first runs, write a sentinel cache entry (e.g., `key = "__wait__:" + traceRunId + ":" + stepId`). On re-entry the cache hits, fires `markNodeCached`, advances. Pro: zero new infrastructure. Con: pollutes the idempotency cache with non-business entries.
   - **(B) `lastCompletedStepIndex` column on `workflow_runs`** — runner persists progress per step; on re-entry, skips past it. Pro: cleaner semantics, foundation for future "resume from any step" features. Con: new column, new migration (v10).
4. **Runner integration** — in `RunnerSteps.runSteps`, when a wait step is encountered:
   - First pass: compute `dispatchAt = now + duration`, mark run `delayed`, schedule via `DeferredRunScheduler.schedule(traceRunId, dispatchAt, fn, persist={...})`. The persisted payload includes the request subset plus `waitStepIndex`. Throw `DeferredDispatchSignal`.
   - Re-entry: detect the wait step has been satisfied (via strategy A or B), fire `NODE_CACHED` (or a new `NODE_RESUMED` event), continue.
5. **Studio surface** — new `↳ wait` indicator in StepRail. Run header shows "Resumes at <scheduledAt>" when the parent run is `delayed`.

**Recommended resume strategy**: (B) `lastCompletedStepIndex`. Cleaner long-term — the column also enables future features like "resume from step N after a manual fix".

**Composition with prior tiers**:
- Idempotency cache on the wait step's predecessors → first-pass execution caches; re-entry hits the cache, skips, hits the wait, defers. Combined behavior: no work re-runs, the run literally pauses at the wait step.
- Retry on the wait step itself → meaningless. Reject at workflow load.
- Cancellation → operator cancels a `delayed` run that's mid-wait → run flips to `cancelled`, the timer fires later but `dispatchDeferred` checks status and skips the re-entry.
- Sub-workflow with a wait step inside → works trivially. The child's deferral doesn't affect the parent (parent already returned for `wait: false`, or holds for `wait: true`).
- Concurrency keys → wait runs hold their slot for the duration of the wait. For long waits, this can starve. Recommend `concurrencyKey` workflows NOT use long waits — or, future feature, release-slot-during-wait.

**Plan-doc location**: `/Users/wellingtonprado/.claude/plans/tier3-wait-step-primitive.md` (write before starting).

---

### B2 · `concurrencyQueueTimeoutMs` (TTL on queued runs)

**Status**: SHIPPED in commit `a67d992`.
**Severity**: FEATURE.
**Effort**: ~1 day.
**Why**: today, `onLimit: "queue"` retries indefinitely (lease-bounded only). Operator who wants "give up after 30 min" has no surface.

**Author surface**:

```ts
trigger: {
  http: {
    method: "POST",
    path: "/render",
    concurrencyKey: $.req.body.tenantId,
    concurrencyLimit: 5,
    onLimit: "queue",
    concurrencyQueueTimeoutMs: 30 * 60 * 1000, // give up after 30min
  },
}
```

**Implementation**: at queue time, compute `expiresAt = now + concurrencyQueueTimeoutMs`. Store on the run record. On each re-defer, check `now > expiresAt` and flip to `expired` instead of re-queueing. Reuses the existing TTL machinery.

---

### B3 · Capped exponential backoff for `onLimit: "queue"`

**Status**: SHIPPED in commit `a67d992`.
**Severity**: NICE-TO-HAVE.
**Effort**: ~half day.
**Why**: when a slot frees, every queued run on the bucket wakes on the next 1s tick → thundering herd. Backoff with jitter spreads the wakeups.

**Sketch**: replace fixed-1s `retryAfterMs` with `min(maxBackoff, baseBackoff * 2^attempt)` plus jitter. Track attempts on the run record (one new column or piggyback on `pingCount`).

---

## Tier C — Cross-process scaling

### C1 · Cross-process debounce keys (NATS KV / Redis) — ✅ SHIPPED

**Status**: SHIPPED on `feat/c1-cross-process-debounce` (stacked on
`feat/c4-redis-concurrency-backend`).

**Implementation**:
- [`DebounceBackend.ts`](core/runner/src/scheduling/DebounceBackend.ts) — interface
- [`NatsKvDebounceBackend.ts`](core/runner/src/scheduling/NatsKvDebounceBackend.ts) — revision-CAS impl
- [`RedisDebounceBackend.ts`](core/runner/src/scheduling/RedisDebounceBackend.ts) — Lua-scripted impl
- [`createDebounceBackend.ts`](core/runner/src/scheduling/createDebounceBackend.ts) — factory
- [`DebounceCoordinator.ts`](core/runner/src/scheduling/DebounceCoordinator.ts) — async-aware coordinator

Each `(workflow, debounceKey)` has one shared doc per cluster holding
`{mode, delayMs, maxDelayMs?, maxDelayDeadline?, firstPingAt,
lastPingAt, pingCount, activeRunId, ownerProcessId,
ownerLeaseExpiresAt, scheduledAt}`. Three outcomes from `registerPing`:
**owner-new** (caller starts local timer), **owner-extend** (caller
refreshes its local timer + closure), **coalesce** (caller's run gets
`debounced` terminal status pointing at the existing `activeRunId`).
Owner-lease expiry enables takeover on owner death. Redis uses Lua
for single-round-trip atomicity; NATS KV uses bounded revision-CAS
with over-coalesce-on-exhaustion fallback. Both backends ship the
same FW-5 production-prefix refusal as the concurrency backends.

**Semantic ship**: owner-local payload — only the owning process's
captured `onFire` closure fires when the trailing window elapses.
Coalesce pings on other processes bump `pingCount` + push `scheduledAt`
but their payloads are dropped. Cross-process latest-payload-wins
remains a deferred follow-up (would require persisting each ping's
payload to the shared doc, with a size cap mirroring
`BLOK_DISPATCH_PAYLOAD_MAX_BYTES`).

**Opt in**: `BLOK_DEBOUNCE_BACKEND=nats-kv` or `redis`. Independent of
`BLOK_CONCURRENCY_BACKEND` — different connection, different prefix.
Connection pooling between C1 and C4 (when both target the same broker)
is a follow-up optimization, not shipped here.

**Deferred** (explicit, tracked alongside the broker-adapter
docker-compose backlog item): real-NATS / real-Redis integration tests.
Unit tests use fake backends mirroring the Lua / CAS semantics in
TypeScript — sufficient for contract coverage but not for catching
broker-version-specific encoding regressions. Same coverage deferral
as C4 + PRs #85, #86, #87, #88.

---

### C2 · Cross-process scheduler coordination

**Severity**: FEATURE.
**Effort**: ~2-3 days.
**Why**: today's `DeferredRunScheduler` is per-process. Multiple processes each have their own scheduled_dispatches recovery, which can double-fire if both recover the same row.

Actually wait — let me check this. Each `recoverDispatches()` reads from sqlite and re-registers timers. If two processes share the same sqlite file (uncommon — sqlite isn't great at multi-writer), they'd both fire. With separate sqlite files (the typical setup), each process owns its own dispatches.

For PG-backed deployments (multi-process sharing one DB), this IS a problem. Sketch:
- Add a `claimed_by` + `claimed_at` column to `scheduled_dispatches`.
- On boot, only claim rows that are unclaimed OR claimed by a stale process (lease expired).
- Heartbeat the claim while the timer is registered.

---

### C3 · Per-lease key model for high-cardinality NATS KV buckets

**Severity**: NICE-TO-HAVE.
**Effort**: ~1-2 days.
**Why**: today's NATS KV uses one document per `(workflow, key)` bucket holding all leases. With >50 leases per bucket, JSON document grows + CAS contention escalates. Per-lease keys (key-per-lease) would distribute contention.

Tracked but waiting for a real workload. Document the 1-50 leases assumption prominently.

---

### C4 · Redis backend (alternative to NATS KV) — ✅ SHIPPED

**Status**: SHIPPED on `feat/c4-redis-concurrency-backend`.
**Implementation**:
[`RedisConcurrencyBackend.ts`](core/runner/src/concurrency/RedisConcurrencyBackend.ts)
+ [unit tests](core/runner/__tests__/unit/concurrency/RedisConcurrencyBackend.test.ts).

Mirrors `NatsKvConcurrencyBackend` 1:1 modulo atomicity primitive —
Redis uses server-side **Lua scripts** for acquire / release /
per-bucket purge, so each operation is a single `EVAL` with no OCC
retry loop (Lua runs single-threaded against the keyspace). Same
`{leases:[…]}` JSON-document storage shape per `(workflow, key)`
bucket, same lazy-purge-on-acquire semantics, same FW-5 production
refusal for the default key prefix (`blok-concurrency`). Connection
defaults `connectTimeout: 5s`, `maxRetriesPerRequest: 0`,
`enableOfflineQueue: false`, `lazyConnect: true` — trigger startup
never hangs on broker reachability.

Opt in: `BLOK_CONCURRENCY_BACKEND=redis` plus
`BLOK_CONCURRENCY_REDIS_URL` (or discrete `_HOST`/`_PORT`/`_USERNAME`/
`_PASSWORD`/`_DB`/`_TLS`), and `BLOK_CONCURRENCY_REDIS_KEY_PREFIX`
(production refuses the default). Requires `ioredis` peer dep.

**Deferred** (explicit, tracked alongside the broker-adapter
docker-compose backlog item): real-Redis integration tests. Unit
tests use a fake ioredis client that mirrors the Lua semantics in
TypeScript — sufficient for contract coverage but not for catching
Lua-vs-cjson encoding regressions on real Redis. Same coverage
deferral as PRs #85, #86, #87, #88.

---

## Tier D — Observability + ops

### D1 · Backend connect-failure metric

**Status**: SHIPPED in commit `e21f0e7`.
**Severity**: NICE-TO-HAVE.
**Effort**: ~30 minutes.
**Why**: today, NATS KV connect failure logs + falls back to in-process silently. Operators who misconfigure the backend won't notice the gate is silently in-process.

Add a counter `blok_concurrency_backend_install_total{status="success" | "failure"}` in `ConcurrencyMetrics`. Surface in `/__blok/concurrency/health`.

---

### D2 · OCC retry depth histogram

**Status**: SHIPPED in commit `e21f0e7`.
**Severity**: NICE-TO-HAVE.
**Effort**: ~30 minutes.
**Why**: 95% fail-close rate at 200-way contention is invisible without a metric. See [LOAD-TESTS.md §2](LOAD-TESTS.md#2-nats-kv--occ-retry-distribution-at-higher-contention-200-limit10).

Add `blok_concurrency_occ_retries{outcome="success" | "fail-closed"}` histogram. Record from the `acquireSlot` retry loop.

---

### D3 · Janitor sweep duration metric

**Status**: SHIPPED in commit `e21f0e7`.
**Severity**: NICE-TO-HAVE.
**Effort**: ~30 minutes.
**Why**: operators tuning `BLOK_JANITOR_INTERVAL_MS` need to know how long sweeps actually take.

Histogram `blok_janitor_sweep_duration_ms{table}` for each of the three tables. Already-instrumented via the `JanitorStats` return value; just need the OTel binding.

---

### D4 · Backend health endpoint

**Severity**: ALREADY SHIPPED (commit `8d998fb`).

`/__blok/concurrency/health` exists. **Doc gap**: not documented in `core/runner/CLAUDE.md` until just now (this PR).

---

### D5 · Backend `disconnect()` deadline on shutdown

**Status**: SHIPPED in commit `e21f0e7`.
**Severity**: NICE-TO-HAVE.
**Effort**: ~30 minutes.
**Where**: [`TriggerBase.ts:253-260`](core/runner/src/TriggerBase.ts#L253-L260).
**Why**: NATS drain on a slow broker can take 30+ seconds. SIGTERM-to-exit window is typically 10s on managed platforms; the process gets SIGKILLed before drain finishes.

Wrap `backend.disconnect()` in `Promise.race([disconnect(), timeout(10s)])`. On timeout, log + skip.

---

### D6 · Per-bucket OTel labels on concurrency metrics

**Severity**: NICE-TO-HAVE.
**Effort**: ~30 minutes (high-cardinality risk → opt-in).
**Why**: today's counters are workflow-tagged. Per-tenant troubleshooting needs `concurrency_key` tag too.

**Risk**: high-cardinality (per-tenant) labels blow up Prometheus storage. Add behind `BLOK_METRICS_PER_KEY=1` opt-in.

---

## Tier E — Studio polish

### E1 · "Scheduled runs" dedicated view

**Severity**: NICE-TO-HAVE.
**Effort**: ~half day.
**Why**: today, `delayed` / `queued` / `debounced` runs show up in the All Runs list mixed with running and finished ones. A dedicated "Scheduled" tab sorted by `scheduledAt` ASC would make operator queue management cleaner.

Mirror the existing All Runs page. Filter `status IN (delayed, queued, debounced)`. Sort by `scheduledAt`.

---

### E2 · Saved filters server-side

**Severity**: NICE-TO-HAVE.
**Effort**: ~1 day.
**Why**: today, saved filters are localStorage-only. Per-browser. New browser → presets gone.

Move to server: new endpoint `POST /__blok/saved-filters`, `GET /__blok/saved-filters`, `DELETE /__blok/saved-filters/:id`. New sqlite table (or store on the existing `dashboards` table — they're conceptually similar).

---

### E3 · Sub-workflow async indicator nesting

**Status**: SHIPPED in commit `a67d992`.
**Severity**: NICE-TO-HAVE.
**Effort**: ~1 hour.
**Why**: today the `↳ async` badge shows on the immediate sub-workflow step. Nested fire-and-forget (parent fires-and-forgets child that fires-and-forgets grandchild) doesn't surface the depth.

Add a `↳ async (depth=N)` count to the badge. Read from the run's `_subworkflowDepth` field.

---

### E4 · Visual workflow graph

**Severity**: FEATURE.
**Effort**: ~3-5 days.
**Why**: tracked in `docs/d/composition/sub-workflows.mdx:556` Tip. React Flow (like n8n). Renders parent + child relationships as a graph. Until then, the Sub-runs strip provides drill-down.

---

## Tier F — Filters

### F1 · Indexed metadata filters

**Severity**: NICE-TO-HAVE.
**Effort**: ~1 day.
**Why**: today, metadata filter uses sequential scan via `json_extract`. At 100K+ rows, query time grows linearly.

**Sketch**: identify scalar metadata fields that authors frequently filter on (e.g., `tier`, `region`). Promote them to dedicated indexed columns. Operator-facing config via `BLOK_INDEXED_METADATA_KEYS=tier,region`.

Alternative: SQLite virtual columns + index expressions. Less invasive.

---

### F2 · Metadata filter operators beyond `=`

**Severity**: NICE-TO-HAVE.
**Effort**: ~1 day.
**Why**: today only equality. Operators want `tier!=free`, `count>10`, `region IN (us, eu)`.

**Sketch**: extend the query parser. URL grammar: `metadata.tier=premium`, `metadata.tier!=free`, `metadata.count>10`. Server: translate to `json_extract` SQL operators.

---

## Tier G — Sub-workflow polish

### G1 · Cancellation cascade to fire-and-forget children

**Status**: SHIPPED in commit `a67d992`.
**Severity**: NICE-TO-HAVE.
**Effort**: ~half day.
**Why**: today, cancelling a parent run does NOT propagate to async (`wait: false`) children — the parent step has already returned by the time the child runs.

**Sketch**: track child `runId` on the parent's NodeRun. When the parent is cancelled, walk children and fire `tracker.abortRunningRun(childRunId)` for each.

Trade-off: requires the parent-child link to persist. Already there via `parentRunId` on `WorkflowRun`. Just need a `getChildRunIds(parentRunId)` query.

---

### G2 · Cross-process sub-workflow dispatch

**Severity**: FEATURE.
**Effort**: ~3-4 days.
**Why**: today, sub-workflow dispatch is in-process (setImmediate or sync). Horizontal-scale users with strict isolation may want each child to run on a different process.

**Sketch**: add `dispatch: "in-process" | "http-self"` field on the sub-workflow step. `http-self` does an HTTP self-call to the registered workflow's URL, lifting child execution to the trigger layer.

---

### G3 · Polymorphic workflow names

**Severity**: NICE-TO-HAVE.
**Effort**: ~1 day.
**Why**: today `subworkflow: "X"` is static. `subworkflow: $.req.body.kind` would allow dynamic dispatch.

**Trade-off**: workflow name resolution becomes a runtime concern (typos surface late). Add behind a strict flag (`workflowName: { kind: "expression", value: "$.req.body.kind", allowList: [...] }`).

---

## Tier H — Testing gaps

### H1 · HTTP cancellation integration test

**Status**: SHIPPED in commit `7605bb7`.
**Severity**: HIGH (would have caught bug A2).
**Effort**: ~half day.
**Why**: existing test asserts API returns 200 but doesn't verify the in-flight step actually aborts.

**Sketch**: add to `core/runner/src/__tests__/tracing/TraceRouter.test.ts`. Spawn a workflow with a step that loops on `ctx.signal.aborted`. POST cancel mid-step. Assert the step exits, run flips `cancelled`, and downstream steps don't execute.

---

### H2 · Cancel-after-redispatch test

**Status**: SHIPPED in commit `7605bb7`.
**Severity**: HIGH (would catch the regression after fix A2).
**Effort**: ~1 hour.
**Why**: see bug A2.

---

### H3 · NatsKvConcurrencyBackend real-NATS integration test — ✅ SHIPPED

**Status**: SHIPPED on `feat/docker-compose-ci`. Tests at
[`core/runner/__tests__/integration/NatsKvConcurrencyBackend.real-nats.test.ts`](core/runner/__tests__/integration/NatsKvConcurrencyBackend.real-nats.test.ts).
Default-skip; run with `BLOK_INTEGRATION_NATS_SERVERS=nats://localhost:4223 bun run test`
after `bun run test:integration:up`.

Covers the contract end-to-end against the JetStream KV: first acquire,
limit/deny, idempotent re-acquire, release, two-instance contention,
lazy-purge, `purgeExpired` count. Bundled into the broader
docker-compose CI work that also closes #86 + #87 + C1 + C4 deferred
integration tests.

---

### H4 · Durable scheduler crash-restart integration test — ✅ SHIPPED

**Status**: SHIPPED on `feat/docker-compose-ci`. New tests at
[`core/runner/__tests__/integration/durable-scheduler-crash-restart.test.ts`](core/runner/__tests__/integration/durable-scheduler-crash-restart.test.ts)
complement the existing in-process simulation at
[`triggers/http/__tests__/unit/HttpTrigger.recoverDispatches.test.ts`](triggers/http/__tests__/unit/HttpTrigger.recoverDispatches.test.ts).

The new tests use a **real on-disk sqlite file** that survives a
simulated process tear-down (close store + reset singletons + reopen
against the same file). Covers: row survives crash + reopen; past-due
rows fire immediately on recovery; TTL-expired rows are deleted on the
recovery sweep.

---

## Tier I — Documentation

### I1 · Project-level docs updates (DONE in this PR)

- `docs/d/reliability/overview.mdx` — fixed the misleading `wait.for()` and PG cache claims.
- `docs/d/reliability/idempotency.mdx` — fixed the PG cache claim (durable since `f735efe`).
- `core/runner/CLAUDE.md` — fixed the PG cache claim, the NATS x-delay claim; added a comprehensive operations section (cancellation, crash auto-flip, Janitor, observability endpoints, OTel counters, graceful shutdown); added a `wait.for()` composability discussion.

### I2 · Add Janitor + observability mentions to root `CLAUDE.md`

**Status**: SHIPPED in commit `7b0f5c8`. Root `CLAUDE.md` Context Rule 13 now covers Janitor, observability endpoints, OTel counters, graceful shutdown, and the durable-scheduler payload cap.
**Severity**: LOW.
**Effort**: ~10 minutes.

### I3 · Migration guides for v1 → v2 + reliability primitives

**Severity**: LOW.
**Effort**: ~half day.
**Why**: user has previously said "not needed" but at some point external users will pull v2.

Single migration guide `docs/c/migration-guides/v1-to-v2-reliability.mdx`: covers the v2 step shape, `idempotencyKey`, `retry`, `maxDuration`, `concurrencyKey`, `delay`/`ttl`/`debounce`, sub-workflows. Each section a 5-minute migration recipe.

---

## Tier J — Out of scope (deliberately)

These are explicitly NOT planned:

| Item | Reason |
|---|---|
| **CRIU process-snapshot checkpointing** | Different architecture — Blok is a synchronous-leaning step runner, not a process-snapshot platform. The composable building blocks (Tier B1) cover the same use case without CRIU. |
| **Step-level concurrency keys** | Different invariant set — separate plan. The user can compose by extracting expensive work into a sub-workflow with its own `concurrencyKey`. |
| **Debounce `mode: "throttle"`** | Different from coalesce. Could compose with concurrency keys once it lands. Not pulled by users. |
| **Long delays >24h via setTimeout** | Recommend cron + external scheduler for day-scale schedules. The sqlite-backed durable scheduler survives restarts but Node `setTimeout` ceiling is implementation-defined. |

---

## Suggested next-PR ordering

If you ship in 1-day-each PRs:

1. **A1 + A2 + A3 + H1 + H2** as one PR — "fix: Tier 2 follow-up bug fixes + integration tests" (~1 day end-to-end). Closes the two HIGH bugs and the listener leak; adds the missing integration tests.
2. **A4 + A5 + A6 + I2** as one PR — "feat: Tier 2 follow-up production hardening" (~1 day). Caps payload size, bounds PG loadRecent, distinguishes NATS errors, plus the small doc fix.
3. **D1 + D2 + D3 + D5** as one PR — "feat: Tier 2 observability metrics" (~half day).
4. **B1 (`wait.for`)** as a single dedicated PR (~2-3 days). Mirror the Tier 2 #4 plan format. New step shape, new column (or sentinel cache), new Studio indicator, end-to-end tests.
5. **B2 (`concurrencyQueueTimeoutMs`)** as a small follow-up to #4 (~half day).
6. **C1 (cross-process debounce)** when a user reports they need it.
7. **C4 (Redis backend)** when a user reports they need it.
8. **E1 (Scheduled runs view)** as a 1-day Studio PR.
9. **F1 (Indexed metadata filters)** when load profiles demand it.
10. **G1 (Cancellation cascade)** as a small Tier 2 polish follow-up (~half day).

Total backlog at face value: **~3-4 weeks of work** if shipped sequentially. Most items are independent and could be parallelized.

---

## Out-of-band items

Things that aren't in any tier but are worth tracking:

- **`set_var` deprecation timeline.** v2 default-stores; `set_var: false` is normalized to `ephemeral: true`. The legacy field can be removed when no v1 workflows remain.
- **`@blokjs/runner` 0.4.0 release.** v0.3.x is the gRPC-default release; v0.4.0 should remove HTTP runtime adapter (already deprecated with warning).
- **Studio dark/light theme toggle.** Currently dark-only. Low priority.
- **CLI `blokctl trace` improvements.** Currently opens Studio at `/__blok`. Could ship a TUI mode for headless ops.

---

## Summary

| Tier | Items | Severity | Effort |
|---|---|---|---|
| A — Bugs | 6 | 2 HIGH, 4 MED | ~1-2 days total |
| B — New primitives | 3 | feature | ~3-4 days total |
| C — Cross-process scaling | 4 | feature | ~7-10 days total |
| D — Observability + ops | 6 | NICE-TO-HAVE | ~2 days total |
| E — Studio polish | 4 | NICE-TO-HAVE | ~5-7 days total |
| F — Filters | 2 | NICE-TO-HAVE | ~2 days total |
| G — Sub-workflow polish | 3 | feature | ~5-6 days total |
| H — Testing gaps | 4 | 2 HIGH, 2 MED | ~2 days total |
| I — Documentation | 3 | LOW | ~1 day total (1/3 done in this PR) |
| J — Out of scope | 4 | n/a | n/a |

**Total**: ~25-35 days of work organized into ~10 PRs.

The two HIGH-severity bugs (A1, A2) are the only items blocking production-readiness for the Tier 2 reliability surface. Everything else is polish, scaling, or feature-add at user pull.
