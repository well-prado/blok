# ADR 0012 - Persist-all state growth ceiling

Date: 2026-06-28

## Status

Accepted for M1 planning.

## Context

Risk R5 in `Core-Redesign-Validation.md` called out an unmeasured ceiling for the v2 persist-all rule. The live runner keeps one mutable `ctx.state` for the whole run and writes every successful non-ephemeral step through `applyStepOutput()`. A regular step stores at `state[as ?? name]`; `spread: true` shallow-merges top-level output keys; `ephemeral: true` skips the write.

The important implementation facts are:

- `core/runner/src/workflow/PersistenceHelper.ts` mutates `ctx.state` in place and does not prune old slots.
- `core/runner/src/ForEachNode.ts` clones the parent state per iteration, then writes `state[as]` and `state[as + "Index"]` into that child state. The loop aggregate is stored once at the parent loop id.
- `core/runner/src/RunnerSteps.ts` snapshots `ctx.state` before `WaitDispatchRequest`. The default `BLOK_STATE_SNAPSHOT_MAX_BYTES` cap is 1 MiB; over cap logs a warning and skips the snapshot.
- `triggers/http/src/runner/HttpTrigger.ts` caps durable scheduled-dispatch payloads with `BLOK_DISPATCH_PAYLOAD_MAX_BYTES` at 1 MiB by default. Overflow throws `PayloadTooLargeError` and the HTTP transport returns 413.
- `node_runs` persistence is per executed node. A forEach with one inner step writes one `node_runs` row per item when tracing is active.

## Measurement

One-off local harness, not committed: Node v24.16.0 with `--expose-gc` for heap deltas, plus a Bun import of `SqliteRunStore` for actual SQLite writes. Payloads used small JSON objects with ASCII strings so serialized byte counts are deterministic. Heap deltas are approximate and useful only for order of magnitude.

### Sequential persisted steps

Each step stored `{ ok: true, index, payload: "x" * 64 }`.

| Steps | `ctx.state` JSON bytes | Heap delta |
|---:|---:|---:|
| 1,000 | 111,781 | 126,400 |
| 5,000 | 567,781 | 567,488 |
| 10,000 | 1,137,781 | 1,036,144 |

The 1 MiB serialized-state ceiling arrives at roughly 9.2k small persisted slots.

### forEach growth

Model: one inner step per item, result `{ ok: true, id, payload: "y" * 32 }`.

| Items | Per-item child state bytes | Parent loop results bytes | `node_runs` JSON bytes | Heap delta |
|---:|---:|---:|---:|---:|
| 1,000 | 172 to 176 | 65,903 | 372,451 | 343,200 |
| 5,000 | 172 to 178 | 333,903 | 1,884,451 | 1,674,376 |
| 10,000 | 172 to 178 | 668,903 | 3,774,451 | 3,364,944 |
| 50,000 | 172 to 180 | 3,388,903 | 19,094,451 | 16,789,016 |

Conclusion: the per-iteration `state[as]` write is O(1) relative to item count. The parent aggregate `ctx.state[loopId]` and trace rows are O(N).

### Spread-heavy pipeline

Each step spread 100 numeric keys into state.

| Steps | State keys | `ctx.state` JSON bytes | Heap delta |
|---:|---:|---:|---:|
| 1,000 | 100,000 | 1,369,001 | 8,694,104 |
| 5,000 | 500,000 | 7,289,001 | 37,645,928 |
| 10,000 | 1,000,000 | 14,689,001 | 65,931,752 |

Spread is the sharp edge. It crosses the 1 MiB serialized ceiling before 1,000 steps when fanout is 100 keys per step, and object-key heap overhead dominates.

### Durable dispatch cap

For an HTTP scheduled dispatch whose body is `{ state: <sequential-state> }`, using the same 64-byte slot shape:

| Cap | Last pass | First fail |
|---|---:|---:|
| `BLOK_DISPATCH_PAYLOAD_MAX_BYTES=1,048,576` | 9,214 slots / 1,048,500 bytes | 9,215 slots / 1,048,614 bytes |
| `BLOK_STATE_SNAPSHOT_MAX_BYTES=1,048,576` on raw `ctx.state` | 9,217 slots / 1,048,519 bytes | 9,218 slots / 1,048,633 bytes |

The caps are adjacent but have different failure modes. Dispatch payload overflow becomes a 413 from `HttpTrigger`. State snapshot overflow logs a warning and skips the snapshot; a wait still defers, but cross-process recovery becomes best-effort for that run.

### SQLite node_runs amplification

Actual `SqliteRunStore` writes for one run, one inner node per iteration, small inputs and outputs:

| Node runs | `saveNodeRun` ms | `updateNodeRun` ms | SQLite file bytes |
|---:|---:|---:|---:|
| 1,000 | 35.9 | 26.4 | 446,464 |
| 5,000 | 178.0 | 132.9 | 1,667,072 |
| 10,000 | 363.0 | 267.5 | 3,170,304 |

Postgres was not measured because no live server is required for this spike. Source inspection shows the same two-write shape: `saveNodeRun()` enqueues one INSERT, then `completeNode()`/`updateNodeRun()` enqueues one UPDATE with `outputs_json`. PG also keeps an in-memory mirror before the async write, so write amplification is at least the SQLite shape plus queue/mirror overhead.

## Decision

Do not ship compile-time state-slot GC in v1.

The normal case is linear and tolerable: about 9k small persisted slots before the 1 MiB wait/dispatch boundary. The dangerous cases are author-visible shapes: large outputs, high-fanout `spread`, and large loop aggregates. A hidden GC pass would make `ctx.state` less explainable, complicate replay/debugging, and create new correctness questions around dynamic `js/ctx.state[...]` reads that are not statically visible in the handle graph.

Instead, ship authoring warnings first:

1. Warn when `spread` is used on wide or unknown object outputs.
2. Warn when a large forEach aggregate feeds a wait, deferred dispatch, or http-self subworkflow body.
3. Warn when a step output has no downstream handle/reference and looks side-effect-only, recommending `ephemeral: true`.
4. Warn when projected `ctx.state` or scheduled payload size approaches the default 1 MiB cap.

State-slot GC remains a post-v1 optimization. If added, it must be opt-in and compile from the handle graph, with an escape hatch that disables pruning whenever a workflow contains dynamic raw state reads that cannot be proven safe.

## http-self attribution

`dispatch: "http-self"` only sends the parent step's resolved inputs, not `ctx.state` by default. The blowout happens when the parent maps large state into the subworkflow inputs and the child later enters a durable scheduling path.

For `wait: true`, the child `HttpTrigger` returns 413 and the parent `SubworkflowNode.dispatchHttpSelf()` throws an error that includes the status and response body. This is attributable enough for v1.

For `wait: false`, the current code fires `fetch()` and only catches network rejection. A 413 HTTP response does not reject, so it can be silently ignored by the parent side. That is an observability bug, but not a persist-all design blocker. Follow-up: inspect non-2xx responses in the fire-and-forget path and increment the existing subworkflow async failure metric.

## Edge cases

- Long-lived wait/re-entry keeps `ctx.state` resident in-process and tries to serialize `state_snapshot` before throwing the wait. Above the state snapshot cap, restart recovery loses the snapshot and resumes best-effort.
- Spread with hundreds of keys is the main practical hazard and should be linted early.
- Nested subworkflows keep state isolated per run, but a wait-chain can sum multiple large snapshots and scheduled payload rows across parent and children.
- forEach item scope is O(1) per iteration for `state[as]`, but the final `results[]`, `node_runs`, and wait cursor `completedResults` remain O(N).
- SQLite and Postgres both persist node runs with an INSERT plus completion UPDATE. PG's async queue changes latency, not the number of writes.

## Consequences

- M1 can keep the current persist-all semantics.
- The handle graph should be built for validation and linting first, not pruning.
- `ephemeral: true` stays explicit. Do not auto-ephemeral side-effect nodes in v1 because that would change state/tracing semantics and make success checks ambiguous.
- The product ceiling to document is simple: keep serialized `ctx.state` and scheduled dispatch payloads under 1 MiB by default, or raise the caps deliberately.
