# REVIEW — Tier 2 follow-up commits on `feat/grpc`

**Date**: 2026-05-04
**Range**: `d895eb0^..feat/grpc` (the brief's stated range `c40a4f8^..feat/grpc` actually only catches 8 of the 11 — the three earliest follow-ups land before c40a4f8)
**Commits in scope** (chronological):
`d895eb0` `6caa7df` `84f7bb9` `c40a4f8` `f828631` `7ae309d` `f735efe` `25d5ee4` `7624e49` `8d998fb` `6d5035a`
**Reviewer**: critical-review agent (Claude Opus 4.7)
**Working-tree note**: an unrelated Tailwind class rename in [apps/studio/src/components/trace/ActiveStepPanel.tsx](apps/studio/src/components/trace/ActiveStepPanel.tsx) (`break-words` → `wrap-break-word`) sits unstaged. Not part of this review.

---

## 1. Executive summary

- **Two real correctness bugs**:
  1. **Cancellation broken for re-entered runs** (commit `7624e49`): cooperative cancellation does not work for runs that came from `delayed`/`debounced`/`queued` state. The first-pass `finally` in `TriggerBase.run` unregisters the AbortController before the deferred timer re-enters; the re-entered run never re-registers. `abortRunningRun` finds no controller, the in-flight step keeps running, and `completeRun` happily overwrites `cancelled` → `completed`. Visible to operators who cancel post-delay runs.
  2. **Orphan recovery only flips 50 runs per boot** (commit `f828631`): `recoverOrphanedRuns` calls `tracker.markAllRunningRunsAsCrashed(...)` exactly once, which calls `store.getRuns({status: "running"})` with no explicit limit. `SqliteRunStore.getRuns` defaults `opts?.limit ?? 50` ([SqliteRunStore.ts:810](core/runner/src/tracing/SqliteRunStore.ts#L810)). So a process that died with 1000 orphaned `running` runs leaves 950 stuck forever; subsequent boots only ever flip 50 more (the bound is staled rows ageing past `BLOK_ORPHAN_THRESHOLD_MS`). Silent data inconsistency. Confirmed by benchmark: 10K seeded `running` runs, single call flips 50.
- **One quiet listener leak**: `createChildContext` attaches `{once: true}` listeners to the parent's AbortSignal but never removes them when the child completes. A long-lived parent that fires N sub-workflows accumulates N listeners; Node's `MaxListenersExceededWarning` fires at the 11th. Memory pressure not severe, but observability noise.
- **Two architectural watch-outs**: PG `loadRecent` reads `idempotency_cache` / `concurrency_locks` / `scheduled_dispatches` without LIMIT, and `extractDispatchPayload` captures the full request body. Both will bite at scale: 1M cache rows × no limit = OOM on boot; 50MB request × delayed dispatch = 50MB sqlite write.
- **Several deferred items still deferred**: NATS KV is mock-only in tests, no real-NATS integration test exists. No crash-recovery integration test for the durable scheduler. The HTTP cancel test verifies the API returns 200 but not that the in-flight step actually aborts.
- **Documentation is mostly current** but missing four env vars (`BLOK_JANITOR_*`, `BLOK_GRACEFUL_SHUTDOWN_DISABLED`) and the new observability endpoints in `core/runner/CLAUDE.md`.

The work is well-structured: shared abstractions are clean, error paths are mostly conservative, and test coverage at the unit level is solid (3052 tests, parity 34/34). The bug list is short. The riskier areas — NATS KV correctness under contention and PG boot under load — need real-environment validation, which the load tests below cover.

---

## 2. Per-commit review

### `d895eb0` · Tier 2 #6 follow-up — `onLimit: "queue"`
Defers run via `DeferredRunScheduler` instead of throwing on concurrency-gate denial.

- ✓ Reuses existing `DeferredDispatchSignal` + transport translation cleanly. No new error class.
- ✓ Schema validation rejects `onLimit` without `concurrencyKey`.
- ⚠ Fixed 1s retry delay → thundering-herd risk when a slot frees and N queued runs all wake on the next 1s tick. Documented in `core/runner/CLAUDE.md` under "Not yet shipped". Load test #4 below quantifies.
- ⚠ Indefinite re-defer with `expiresAt: undefined` ([TriggerBase.ts:569](core/runner/src/TriggerBase.ts#L569)). A queued run loops forever 1s at a time until a slot frees. The trigger-level lease (default 1h) bounds slot leaks if a holder dies, but a permanent over-limit workflow leaks scheduled_dispatches rows + run records indefinitely. Recommend a `concurrencyQueueTimeoutMs` follow-up.
- 💡 The brief queued → running → queued flicker on re-defer (status flips on every retry) is observable in Studio's SSE stream. Not a bug, but each transition is an event-store write — multiplies storage cost for high-contention buckets.

### `6caa7df` · Tier 2 polish bundle — NATS x-delay, cancel API, async indicator
- ✓ `computeXDelayHoldMs` exported as a pure helper; tests cover the boundary cases.
- ⚠ Consumer-side hold blocks one worker slot for the full delay window ([NATSAdapter.ts:262](triggers/worker/src/adapters/NATSAdapter.ts#L262)). Documented; but for hour-long delays this is wasteful versus broker-native `nakWithDelay`.
- ✓ Cancel API correctly captures `previousStatus` before `cancelRun` mutates the in-memory run record (line ~handler in TraceRouter — fixes the in-place-mutation race).
- ✓ Cancel handler clears `DeferredRunScheduler` + `DebounceCoordinator` BEFORE `cancelRun` to avoid the timer firing into a cancelled run.
- ✓ `↳ async` (orange-300) vs `↳ sub` (zinc-300) Studio indicator with explanatory tooltip.

### `84f7bb9` · Tier 2 #5+#7 follow-up — sqlite-backed durable scheduler
- ✓ Migration v9 schema is additive; pre-v9 DBs upgrade transparently.
- ✓ Persist-before-timer ordering ([DeferredRunScheduler.ts:80-103](core/runner/src/scheduling/DeferredRunScheduler.ts#L80-L103)) so a crash between persist + setTimeout still leaves the row recoverable.
- ✓ Sensitive header denylist (`authorization`, `cookie`, `x-api-key`, `x-auth-token`, `proxy-authorization`, `set-cookie`, `proxy-authorization`).
- ✗ **No size cap on payload_json.** `extractDispatchPayload` ([HttpTrigger.ts:789-809](triggers/http/src/runner/HttpTrigger.ts#L789-L809)) captures `req.body` raw. A 50MB POST on a delayed trigger writes 50MB to sqlite per dispatch. Recommend a size cap (suggested: 1MB default, configurable via env). Load test #3 below probes the limit.
- ⚠ `HttpTrigger.recoverDispatches` skips rows whose workflow isn't in the registry, but does NOT delete the skipped row. In a multi-trigger process where a workflow gets migrated between triggers, stale rows accumulate. Recommend a TTL on skipped rows or a janitor sweep that purges rows for unknown workflows.
- ⚠ `restoreDispatch` calls `this.createContext(...)` which allocates a fresh AbortController. The reentered run skips re-registration (see bug below). Operator cancel after recovery is silently broken.

### `c40a4f8` · Tier 2 #6 follow-up — cross-process concurrency backend (NATS KV)
- ✓ `acquireConcurrencySlot` / `releaseConcurrencySlot` async transition is clean. Grep confirms ALL production callers `await` (TriggerBase:538) or use `void promise.catch(...)` (TriggerBase:802). The sync `getStore().acquireConcurrencySlot` calls in `TraceRouter.test.ts:1235-1237` use the sync store API intentionally — the async surface is on `tracker`, not `store`.
- ✓ OCC retry loop bounded at 10 with fail-closed-and-warn semantics.
- ✓ Bucket-deleted-between-get-and-update handled — `!entry` falls through to `kv.create()` which catches the create race.
- ✓ Release retry loop filters on the constant input `runId`, NOT on freshly-fetched data — correct.
- ⚠ **`safeGet` swallows ALL errors** ([NatsKvConcurrencyBackend.ts:304-310](core/runner/src/concurrency/NatsKvConcurrencyBackend.ts#L304-L310)). When NATS is unreachable, `kv.get` throws → `safeGet` returns null → `!entry` is true → `kv.create()` throws → caught at line 192 → continue. Spins 10× before fail-closing. 10× the latency hit on outages. Recommend distinguishing "no entry" from "fetch failed" so the OCC loop can short-circuit on network errors.
- ⚠ Backend-install errors during `listen()` log + fall back ([HttpTrigger.ts boot block]); fine for resilience but no observability metric counts these. An operator who misconfigures NATS won't notice the gate is silently in-process.
- ⚠ Hex-encoded keys (`encodeSegment` at line 159-164) work, but for high-cardinality tenant ids the round-tripped key gets long; KV key-length limits are 250 bytes by default — extreme keys could overrun.
- 💡 No metric for OCC retries. Worth a counter so operators can see a contention spike before fail-closing kicks in.

### `f828631` · Crash auto-flip + orphan recovery
- ✓ Idempotent install via static `crashHandlersInstalled` flag.
- ✓ `recoverOrphanedRuns` `maxStartedAt` filter prevents flipping runs from the current (live) process.
- ✓ Synchronous `markAllRunningRunsAsCrashed` is safe inside `process.on("uncaughtException")` (which can't await).
- ✓ Re-throws `uncaughtException` so Node still crashes; doesn't re-throw `unhandledRejection` (matches Node's warn-and-continue default).
- ✗ **CONFIRMED BUG: `markAllRunningRunsAsCrashed` only flips 50 runs per call.** ([RunTracker.ts:436-448](core/runner/src/tracing/RunTracker.ts#L436-L448)) calls `this.store.getRuns({ status: "running" })` with no `limit`. SqliteRunStore at [line 810](core/runner/src/tracing/SqliteRunStore.ts#L810) defaults `opts?.limit ?? 50`. Benchmark confirms: 10K seeded `running` rows + single call → flipped=50. `recoverOrphanedRuns` ([TriggerBase.ts:293-315](core/runner/src/TriggerBase.ts#L293-L315)) calls this ONCE per boot. Recommended fix: pass `limit: this.maxRuns` (or similar large value) when querying for crash recovery; OR loop until flipped=0; OR add a dedicated `getRunsByStatus(status)` method without the pagination cap.
- ⚠ `markAllRunningRunsAsCrashed` calls `markRunCrashed` per-run inside a loop. Even with the bug fixed (LIMIT raised), 100K row updates are O(N). Benchmark shows 7ms per pass at 50 rows; with `markRunCrashed` per-row writes that's ~140µs/run. 100K = 14s. Acceptable for a boot scan but flag it.
- 💡 Recovery does NOT touch sub-workflow `parentRunId` lineage — orphaned children (whose parent crashed but the child's process is still up) can stay in `running`. Acceptable for v1 but worth documenting.

### `7ae309d` · Periodic storage janitor
- ✓ Single setInterval, `unref()`d so it doesn't keep the event loop alive.
- ✓ `inFlight` flag prevents overlapping sweeps under slow stores.
- ✓ Per-purge errors caught individually.
- ✓ Singleton via `Janitor.getInstance(store, logger)` — first call wins.
- ⚠ No observability for janitor sweeps (durations, errors). Currently logs only when something's purged. Add OTel counters for durations / per-table-purged counts.
- ⚠ If a sweep takes longer than the interval (5min for 100K cache rows is realistic), the next interval tick is dropped. The bound is fine in steady state but observability would help operators tune `BLOK_JANITOR_INTERVAL_MS`.

### `f735efe` · Durable PG schema for cache/locks/dispatches
- ✓ Migration v3 is additive; pre-existing rows unaffected.
- ✓ Forward-compat: silently ignores `relation does not exist` so a pre-v3 PG schema doesn't crash the loader.
- ✓ Hybrid model preserves the sync `RunStore` interface contract.
- ✗ **`loadRecent` reads the new tables WITHOUT LIMIT.** With 1M+ idempotency_cache rows, boot becomes O(N) memory + load time. Recommend either:
  - LIMIT on a cutoff (e.g. last 7 days)
  - Lazy-loading only when the in-memory mirror misses
  - Mirror only un-expired rows (`WHERE expires_at > now() OR expires_at IS NULL`)

  Load test #2 below quantifies boot time at scale.
- 💡 Cross-process coordination via the gate itself still requires the dedicated `BLOK_CONCURRENCY_BACKEND=nats-kv`. The PG persistence here is purely for crash-recovery within a single PG-backed process. The session note clarifies this; double-check the docs (see Documentation drift below).

### `25d5ee4` · Durable debounce coalescing
- ✓ Latest-payload-wins via upsert keyed on the active runId.
- ✓ Persistence opt-in via `extractDispatchPayload` (matches Tier 2 #5+#7 pattern).
- ⚠ The `onFire` finally block ([TriggerBase.ts:874-883](core/runner/src/TriggerBase.ts#L874-L883)) calls `DeferredRunScheduler.cancel(traceRunId, true)` to delete the persisted row. But the row was upserted in TriggerBase.maybeDeferRun via `tracker.getStore().upsertScheduledDispatch`, NOT through `DeferredRunScheduler.schedule(persist:...)`. So the scheduler doesn't track this runId as "persisted" — `cancel(runId, true)` falls into the `cancelPersistedOnly` branch which does delete the row. Works, but the indirection is fragile; a future refactor could break it. Recommend inline `tracker.getStore().deleteScheduledDispatch(traceRunId)` or unify the persistence path.
- ⚠ Recovery on boot: `recoverDispatches` re-fires debounced rows via `setTimeout(0)` (no silence-window re-establishment). Documented; but live pings post-restart open a fresh window, so the recovered ping fires immediately + a separate window with the live pings forms — two firings instead of coalesced one. Acceptable as a v1 trade-off; document prominently.

### `7624e49` · Cooperative AbortSignal cancellation for running runs
- ✓ `RunnerSteps` between-step abort check fires `RunCancelledError` ([RunnerSteps.ts:101-103](core/runner/src/RunnerSteps.ts#L101-L103)).
- ✓ `TriggerBase.run` catch skips `failRun` for `RunCancelledError` (status already `cancelled`).
- ✓ `cancelRun` extended to accept `"running"` cleanly; previousStatus captured for the response.
- ✗ **REAL BUG · cancellation broken for re-entered (delayed/debounced/queued) runs.**
  - **Reproduction**:
    1. Trigger a workflow with `delay: "5m"`. POST returns 202; run status = `delayed`.
    2. TriggerBase.run's first pass: registers the AbortController at [TriggerBase.ts:489-495](core/runner/src/TriggerBase.ts#L489-L495), throws `DeferredDispatchSignal`, the `finally` block at [line 817-819](core/runner/src/TriggerBase.ts#L817-L819) calls `tracker.unregisterAbortController(traceRunId)`. The controller is now gone from `tracker.abortControllers`.
    3. 5min later, the timer fires `dispatchDeferred` → `run(ctx)` with `_blokDispatchReentry = true`.
    4. The re-entered run hits the reentry branch at [TriggerBase.ts:459-462](core/runner/src/TriggerBase.ts#L459-L462) which only sets `traceRunId`. The AbortController is **NOT re-registered**.
    5. Run is now in `running` status, executing steps, but `tracker.abortControllers` has no entry.
    6. Operator calls `POST /__blok/runs/:id/cancel`. `tracker.abortRunningRun(runId)` ([RunTracker.ts:581-599](core/runner/src/tracing/RunTracker.ts#L581-L599)) reads `controller = this.abortControllers.get(runId)` → `undefined`. The `controller.abort()` call is skipped. `cancelRun(runId)` flips status `running` → `cancelled`.
    7. The in-flight step's `ctx.signal.aborted` is still `false` (controller never fired). The step keeps running.
    8. Step completes; `RunnerSteps` proceeds to the next step. No `RunCancelledError` is thrown.
    9. Eventually the run finishes; TriggerBase.run's finally calls `completeRun` (line 760) which has NO status guard — it overwrites `cancelled` with `completed`.
  - **Same bug applies to**: queued runs (onLimit:queue path also goes through the same first-pass-finally → reentry pattern) and trailing-debounced runs.
  - **Recommended fix**: in `dispatchDeferred` (or in TriggerBase.run's reentry branch), re-register the existing AbortController via `tracker.registerAbortController(traceRunId, ctx._PRIVATE_.abortController)` before invoking `runner.run`. Or: keep the registration alive across re-entries and only unregister in the truly-terminal finally (after re-entry returns).
- ⚠ **Listener leak in createChildContext** ([createChildContext.ts:60-72](core/runner/src/utils/createChildContext.ts#L60-L72)). `parent.signal.addEventListener("abort", ..., { once: true })` only auto-removes on abort. A parent that runs N sub-workflows (sequential or fan-out) accumulates N listeners on its signal. Node's `MaxListenersExceededWarning` fires at 11. Recommended fix: store the listener reference, attach a "child completed" callback that calls `parent.signal.removeEventListener("abort", listener)`. Or: pass a child-scoped AbortSignal as the listener's signal so it auto-cleans on child completion.
- ⚠ **HTTP cancel test asserts only `200` status code.** No integration test verifies the in-flight step actually aborts mid-step (no `ctx.signal.aborted` observation, no `RunCancelledError` thrown, no step-output mid-flight teardown).

### `8d998fb` · Backend observability bundle
- ✓ Child-context AbortSignal cascading is correct: child gets a fresh controller, chains to parent's signal.
- ✓ `/__blok/concurrency/health` and `/__blok/concurrency/state` endpoints with new `getConcurrencySnapshot(now)` store method (native sqlite + InMemory walk; PG delegates to memory).
- ✓ OTel counters: `blok_concurrency_acquired_total`, `blok_concurrency_denied_total{mode}`, `blok_concurrency_released_total`, `blok_scheduling_dispatch_recovered_total`, `blok_scheduling_dispatch_expired_total`, `blok_scheduling_dispatch_fired_total`. No-op cleanly without an exporter.
- ✓ Graceful shutdown drain order: trigger.stop() → Janitor.stop() → DeferredRunScheduler.clear() → backend.disconnect().
- ⚠ `installShutdownHandlers` calls `DeferredRunScheduler.clear()` (cancels in-memory timers, persisted rows survive) — NOT `drainAll()` (which fires all pending dispatches). Documented; correct for the durable-scheduler case. But for non-persisted dispatches (workers without `extractDispatchPayload` override), pending dispatches are silently lost. Document prominently or expose drain mode as a config.
- ⚠ Backend `disconnect()` is `await`ed inside the SIGTERM handler. NATS drain can take many seconds on a slow broker; a process that's already received SIGTERM expects to exit quickly. Consider a hard deadline (e.g. 10s) before forcing exit.
- ✓ Inside `dispatchDeferred`, signal is NOT re-registered ([TriggerBase.ts:1052-1083](core/runner/src/TriggerBase.ts#L1052-L1083)) — confirms the bug above.

### `6d5035a` · Studio polish (saved filters + in-flight tile)
- ✓ Saved filters persisted to localStorage; per-browser semantics documented.
- ✓ ConcurrencyTile polls `/__blok/concurrency/state` every 5s.
- ⚠ ConcurrencyTile polling has no cancellation when navigating away — N tabs × 5s polls = O(N) load on the endpoint. With 1K active buckets per response, the endpoint shouldn't get expensive but should be measured. Load test #6 below.
- ⚠ Backend badge "nats-kv" hard-coded; if a future Redis backend lands, the tile won't surface it. Use `backend.name` from the health endpoint.

---

## 3. Cross-cutting concerns

### Concurrency / async hazards
- **acquire/release async transition** (commit `c40a4f8`): clean. ✓
- **NATS KV OCC**: bounded retry, idempotent re-acquire, correct release filter. The `safeGet` swallow-all-errors is the only quibble.
- **AbortController + `_PRIVATE_`**: the bug above is the primary concern. The listener leak in `createChildContext` is the secondary.
- **Crash auto-flip race**: handlers don't recurse, write paths are synchronous. ✓
- **Janitor + setInterval**: `unref()`'d, in-flight flag, per-purge error isolation. ✓
- **Durable scheduler payload bloat**: addressed below.
- **Shutdown ordering**: documented; the only sharp edge is `disconnect()` having no deadline.

### Architectural soundness
- **PG hybrid model under boot-load**: ✗ unbounded — see commit `f735efe` finding. Recommend adding LIMIT or expiry-aware loading.
- **In-memory mirror unbounded growth**: bounded by Janitor sweep (5min default). Acceptable for typical loads; worst case is bursty traffic with thousands of unique keys between sweeps.
- **`scheduled_dispatches` payload**: ✗ unbounded — see commit `84f7bb9` finding. Recommend size cap.
- **NATS KV bucket cardinality**: bounded-cardinality assumption (1-50 active leases per bucket) documented in source. For higher cardinality, consider per-lease-key model in a future iteration.

### Test coverage gaps
- **HTTP cancellation integration test** asserts API returns 200 but doesn't verify the in-flight step actually aborts. Should verify `ctx.signal.aborted` is true mid-step and step throws `RunCancelledError` between steps. **Severity: HIGH** — would have caught the bug above.
- **Re-dispatch cancellation path**: no test exercises cancel-after-redispatch (the bug above). **Severity: HIGH**.
- **NatsKvConcurrencyBackend real-NATS test**: all tests use a fake KV mock. No integration coverage against a real NATS instance. **Severity: MEDIUM** — the OCC contract is exercised via the mock, but real broker behavior (lazy compaction, key length limits, drain semantics) isn't.
- **Durable scheduler crash-recovery integration test**: tests verify writes are queued + load on init, but no full process-kill/restart test. Persisted rows could be wrong shape, restoreDispatch could mis-reconstruct ctx, and we wouldn't know. **Severity: MEDIUM**.
- **PG `loadRecent` performance test**: no test loads `idempotency_cache` / `concurrency_locks` / `scheduled_dispatches` at any meaningful scale. **Severity: MEDIUM** — load test #3 below addresses.
- **Janitor sweep performance test**: no test exercises `purgeExpiredIdempotencyCache` at 100K rows. **Severity: LOW** — load test #5 below addresses.
- **Sub-workflow signal cascade depth**: no test for the addEventListener leak. **Severity: LOW** — load test #10 below addresses.

### Documentation drift
- `core/runner/CLAUDE.md` does NOT cover:
  - `BLOK_JANITOR_DISABLED`, `BLOK_JANITOR_INTERVAL_MS`
  - `BLOK_GRACEFUL_SHUTDOWN_DISABLED`
  - The `Janitor` class itself (separate section recommended)
  - `/__blok/concurrency/health`, `/__blok/concurrency/state` endpoints
  - `RUN_CRASHED` event from the auto-flip path (only mentioned under quick-wins)
- Root `CLAUDE.md` Context Rule 12 mentions `BLOK_CRASH_AUTOFLIP_DISABLED` and `BLOK_ORPHAN_THRESHOLD_MS` but is silent on `BLOK_JANITOR_*` and `BLOK_GRACEFUL_SHUTDOWN_DISABLED`.
- Root CR12 says cooperative cancellation works for `running` runs; the bug above means the claim is too broad — doc should say "for `running` runs that started directly (not via deferred re-entry)".
- Studio Saved Filters + ConcurrencyTile not mentioned anywhere in the project-level docs.
- `CLAUDE.md` (project root) lists CR7-CR12 (Context Rules); missing prose for: cancellation API, Janitor, durable PG schema, NATS KV backend.

---

## 4. Test coverage gaps (consolidated, severity-ordered)

| # | Gap | Severity | Recommended action |
|---|---|---|---|
| 1 | HTTP cancel-running test verifies API returns 200 but not abort happens | HIGH | Add integration test that watches `ctx.signal.aborted` mid-step + asserts `RunCancelledError` |
| 2 | No test for cancel-after-redispatch (the AbortController bug) | HIGH | Add test: schedule delayed run → wait for re-entry → cancel → assert step actually aborts |
| 3 | NatsKvConcurrencyBackend has no real-NATS integration test | MEDIUM | Add env-gated integration test (`BLOK_BENCHMARK_REAL_NATS=1`) using docker-compose NATS |
| 4 | Durable scheduler has no crash-restart integration test | MEDIUM | Add test that persists rows, kills process, restarts, asserts dispatches re-fire |
| 5 | PG `loadRecent` not benchmarked at scale | MEDIUM | Load test #2 (10K-row scheduled_dispatches recovery) |
| 6 | Janitor sweep performance not benchmarked | LOW | Load test #5 (100K idempotency_cache rows) |
| 7 | No metric on backend connect failure | LOW | Add a counter; alert operators on silent-fallback |
| 8 | No metric on OCC retry depth | LOW | Add a histogram; surface in `/__blok/concurrency/state` |

---

## 5. Documentation drift (consolidated)

| File | Missing | Severity |
|---|---|---|
| `core/runner/CLAUDE.md` | `BLOK_JANITOR_*`, `BLOK_GRACEFUL_SHUTDOWN_DISABLED`, observability endpoints, Janitor class section | MEDIUM |
| `CLAUDE.md` (root) CR12 | `BLOK_JANITOR_*`, `BLOK_GRACEFUL_SHUTDOWN_DISABLED`, scope of cancel API limitation | MEDIUM |
| Project docs | Studio Saved Filters + ConcurrencyTile not mentioned | LOW |
| `core/runner/CLAUDE.md` "Backends" | Cross-process backend description doesn't link the metric counters from commit `8d998fb` | LOW |

---

## 6. Recommendations (prioritized)

1. **Fix the orphan-recovery LIMIT=50 bug** (commit `f828631`). `markAllRunningRunsAsCrashed` should either:
   - Pass an explicit `limit` (e.g., `this.maxRuns`) to `getRuns`.
   - Loop in chunks until `flipped === 0`.
   - Add a dedicated `RunStore.getRunsByStatus(status, opts?)` method without the pagination cap.
   Add a regression test that seeds 200+ running runs, calls `recoverOrphanedRuns` once, and asserts all 200 are flipped.

3. **Fix the cancel-after-redispatch bug** (commit `7624e49`). One-liner change to either:
   - Add `tracker.registerAbortController(traceRunId, ctxRecord._PRIVATE_.abortController)` to the reentry branch in `TriggerBase.run` (line ~459).
   - OR move the unregister out of the first-pass finally so the controller stays registered across the lifetime of the underlying logical run.
   - OR make `cancelRun` honor the controller via `ctx._PRIVATE_.abortController` directly when `tracker.abortControllers.get(runId)` is null (look up via the run's stored ctx — would need the ctx to be persisted, which it isn't, so option A or B preferred).
   - Add a unit test for cancel-after-delay-re-entry.

4. **Cap `payload_json` size** in `extractDispatchPayload`. Default 1MB; configurable via `BLOK_DISPATCH_PAYLOAD_MAX_BYTES`. Reject (or truncate + log a warning) on overflow.

5. **Bound PG `loadRecent` queries**. Add `LIMIT` + `WHERE expires_at IS NULL OR expires_at > now()` to the new tables. Document the boot semantics: only un-expired rows are mirrored; expired rows are GC'd by the Janitor on the next sweep.

6. **Fix the `createChildContext` listener leak**. Use `removeEventListener` in a child-scoped `complete` callback, OR pass an AbortSignal as the listener's `signal` so it auto-cleans when the child terminates.

7. **Add observability metrics** for: backend connect failures, OCC retry depth, Janitor sweep duration. Three counters/histograms; ~30 minutes of work each.

8. **Improve `safeGet`** in `NatsKvConcurrencyBackend` to distinguish "no entry" from "fetch failed". On fetch failure, propagate the error so the OCC loop short-circuits early instead of spinning 10× before fail-closing.

9. **Documentation passes**: update `core/runner/CLAUDE.md` and root `CLAUDE.md` for the env vars and endpoints listed in §5. Tighten the cancel-API claim in CR12.

10. **Real-NATS integration tests** behind `BLOK_BENCHMARK_REAL_NATS=1`. The fake-KV mock is a good unit-level abstraction but doesn't validate broker semantics.

11. **Crash-restart integration test** for the durable scheduler. Smoke-level only — kill the process, restart, assert N pending dispatches re-fire.

Items 1-6 are correctness / scaling concerns. Items 7, 8 are observability. Items 9-11 are robustness. The bug list ends here.
