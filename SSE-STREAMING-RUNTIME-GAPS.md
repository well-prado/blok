# BLOK Framework Gaps — Cross-Process SSE Streaming from a Runtime Node

**Status:** Proposal / requirements for a dedicated BLOK work session
**Author:** discovered while implementing a chat-streaming workflow on a downstream product (Tetrix-BLOK)
**Audience:** a Claude Code session working *only* in this BLOK repo (`/Users/wellingtonprado/Projects/Deskree/blok`). No downstream-product context is assumed — everything needed is in this doc.

---

## 0. TL;DR — what to build

A very common real-world pattern is **broken / not expressible** in BLOK today:

> An HTTP/SSE client opens a stream. The workflow runs a **long task in a non-JS runtime** (`runtime.python3` / `runtime.rust`) — e.g. an LLM agent. That task emits **incremental events while it runs** (tokens, tool-calls, progress). The workflow must **forward those events to the SSE client live**, then run a few finalization steps, then close the stream.

Two framework gaps block it, plus two smaller ones:

| # | Gap | Severity |
|---|---|---|
| **G1** | The SSE event bus is **in-process only**. A producer in another process (a `runtime.python3` sidecar, another service) cannot feed it. There is **no Redis/NATS backplane** and **no Redis pub/sub *subscribe* node**. | **Blocker** |
| **G2** | There is **no concurrency primitive** to run a *blocking* producer step **alongside** a consumer/pump step. Steps are sequential; the only concurrency is `forEach mode:"parallel"` (homogeneous iterations) and fire-and-forget `subworkflow`. | **Blocker** |
| **G3** | `runtime.*` gRPC **`ExecuteStream`** exists and *can* carry intermediate events, but they are only routed to the **tracer/log sink** — they are **not consumable** as workflow data or forwardable to SSE. The elegant fix to G1+G2 is to surface them. | **High (the north-star fix)** |
| **G4** | There is **no one-shot "emit a single SSE event" node**. Emitting `message_ids` / `complete` inline currently requires publishing to the bus and having a *blocking* `sse-stream` pump pick it up. | **Medium** |

**Recommended outcome of the session:** implement **G3** (native runtime→SSE streaming) as the primary, clean solution — it dissolves G1 and G2 for this use case — and add **G4** for ergonomics. If G3 is too large for one pass, ship the **G1 (Redis backplane) + G2 (parallel/detached step) + G4** combination as the tactical unblock. Both paths are specced below.

---

## 1. Background — the driving use case

The workflow (an SSE-triggered chat endpoint) must, **in order**, emit a fixed SSE event vocabulary to the browser:

```
message_ids → workflow_start → synthesis(started)
→ [ workflow_step | text(thinking|content|tool_call) | workflow_source | quota_exceeded ]*  ← LIVE, while the agent runs
→ synthesis(complete) → sources → workflow_end → complete   (or → error on failure)
```

The middle block streams **live** from a **`runtime.python3`** node (the "agent") that:
- runs for many seconds,
- emits reasoning/content/tool-call **deltas** and discovered **sources** *as it works*,
- returns **once** at the end with the final answer + sources + token usage.

Today that Python node publishes its deltas to **Redis pub/sub** (`agno:deltas:{id}`, `agno:sources:{id}`) because that's the only cross-process channel available to it. The TS workflow has **no supported way** to consume them and forward to the SSE client. That's the gap this doc is about.

> This is not a niche need. "Run a long task in another runtime and stream its progress to the client" is the canonical agent/LLM/ETL streaming pattern. BLOK should express it first-class.

---

## 2. How the relevant machinery works today (evidence)

### 2.1 SSE trigger + `ctx.stream` — GOOD, keep
- `core/workflow-helper/src/types/TriggerOpts.ts:752-760` — `SSETriggerOptsSchema` (`path`, `heartbeatInterval`, `retryInterval`, `maxConnections`, `events`, `channels`).
- `triggers/sse/src/SSETrigger.ts:245-293` — one workflow run per open connection; runs steps sequentially; `finally` closes the stream.
- `triggers/sse/src/SSETrigger.ts:319-327` + `:347-402` — builds `ctx.stream` (a `StreamContext`) before running the workflow.
- `core/shared/src/types/Context.ts:146-160` — `ctx.stream?: StreamContext` (optional, present only under the SSE trigger).
- **Any `defineNode` can call `ctx.stream.writeSSE(...)`/`.subscribe(...)`/`.signal`** — confirmed by `nodes/utility/helpers@1.0.0/src/sseStream.ts:40-45`. ✅ This is the lever everything else builds on.

`StreamContext` API (from `core/shared/src/types/StreamContext.ts`):
```ts
interface StreamContext {
  readonly id: string;
  writeSSE(opts: { event?: string; data: unknown; id?: string; retry?: number }): Promise<void>;
  writeComment(text: string): Promise<void>;
  close(): void;
  readonly closed: boolean;
  readonly signal: AbortSignal;        // fires on client disconnect
  readonly lastEventId: string | null; // Last-Event-Id header (reconnect)
  subscribe(channels: string[], lastEventId?: string | null): AsyncIterableIterator<BusEvent>;
}
```

### 2.2 The bus — IN-PROCESS ONLY (G1)
- `triggers/sse/src/bus.ts:1-32` — header comment: *"In-process only for v0.7 PR 3. Multi-process backplane (Redis Streams / NATS JetStream) is a follow-up."*
- `triggers/sse/src/bus.ts:58-194` — pure in-memory `Bus`: `publish()` fans out to local subscribers + a 100-event ring buffer per channel; `subscribe()` returns an async iterator with `Last-Event-Id` replay from the ring buffer.
- `nodes/utility/helpers@1.0.0/src/ssePublish.ts:34-63` — `@blokjs/sse-publish` calls `_getSSEBus().publish(...)` — **in-process only**; a different OS process cannot reach this bus.
- `nodes/utility/helpers@1.0.0/src/sseSubscribe.ts` — `@blokjs/sse-subscribe` calls `ctx.stream.subscribe(channels)` → the in-process bus. Returns `{ iterator }`.
- `nodes/utility/helpers@1.0.0/src/sseStream.ts:40-98` — `@blokjs/sse-stream` loops the iterator, calls `ctx.stream.writeSSE(...)` per event; breaks on iterator-done / `ctx.stream.signal.aborted` / `maxEvents`.
- **No Redis pub/sub subscribe anywhere.** `nodes/utility/helpers@1.0.0/src/redisKv.ts` is **KV only** (`get/set/delete/list`). A grep for `.subscribe(`/`psubscribe` across the repo finds only `ioredis.scan` (a cursor, not pub/sub).

**Consequence:** a producer outside the Node process (the Python sidecar) cannot publish into the bus, and no node can subscribe to the external Redis channel it *does* publish to.

### 2.3 No concurrency for heterogeneous steps (G2)
- `core/runner/src/ForEachNode.ts:48-54` + `core/workflow-helper/src/components/forEach.ts:28-32` — `forEach` supports `mode:"parallel"` + `concurrency` (worker pool, `Promise.allSettled`). But it runs the **same sub-pipeline per item** — wrong shape for "run branch A (agent) and branch B (pump) concurrently."
- `branch` → compiles to `@blokjs/if-else` (sequential): `core/workflow-helper/src/components/branch.ts:30-32`.
- `loop` → always sequential: `core/runner/src/LoopNode.ts:84-208`.
- **Fire-and-forget** exists **only** for `subworkflow` steps with `waitForCompletion:false` (`core/workflow-helper/src/types/StepOpts.ts` — "dispatch is fire-and-forget … the child runs asynchronously via setImmediate"). There is **no** `parallel([...])` / `fork` / detached-step primitive for regular module/runtime steps.

**Consequence:** a blocking `runtime.python3` agent step and an SSE pump step cannot run at the same time inside one workflow.

### 2.4 Runtime gRPC streaming exists but isn't consumable (G3)
- `proto/blok/runtime/v1/runtime.proto:33-46` — the service has `ExecuteStream(ExecuteRequest) returns (stream ExecuteEvent)`. `ExecuteEvent` (`:164-172`) is a oneof of `NodeStarted | LogLine | Progress | PartialResult | ExecuteResponse`. **`PartialResult` already exists in the contract.**
- `core/runner/src/adapters/grpc/GrpcRuntimeAdapter.ts:200-308` — `executeStream()` opens the server-streaming call and exposes an `AsyncIterable<DecodedExecuteEvent>` + a final-result promise.
- `core/runner/src/RuntimeAdapterNode.ts:59-66` (`canStream()` at `:131-135`) — streaming is used **only when `streamLogs===true`**, and the drained events are routed to **`tracker.addLog` / progress** (`:157-180`) — i.e. **observability/Studio only**. `PartialResult` payloads are **not** surfaced as node output and **not** forwarded to `ctx.stream`.
- Python SDK side: `apps/.../runtimes/python3/.../blok/server/grpc_server.py:98-150` — `ExecuteStream` is implemented but only emits `NodeStarted` + `LogLine`s (captured from the node logger) + the terminal `ExecuteResponse`. It does **not** emit `PartialResult` data events.

**Consequence:** the clean answer — "the runtime node streams data events; the runner forwards them to SSE" — is *almost* wired but stops at the tracer. Closing this is G3.

### 2.5 No one-shot SSE emit (G4)
- The only way to write to the client is `ctx.stream.writeSSE` (inside a node) — there is no generic node that writes **one** SSE event from its inputs. `@blokjs/sse-stream` only pumps a *bus iterator* and **blocks**. So emitting a single `message_ids` event between steps forces an awkward publish→pump dance.

---

## 3. Proposed fixes

Two routes. **Route A (G3)** is the elegant, BLOK-native fix and is *recommended*. **Route B (G1+G2)** is the tactical unblock if G3 is too large for one session. **G4** applies to both.

### 3.1 Route A (recommended) — native runtime→SSE streaming via `PartialResult` (closes G3, dissolves G1+G2)

Make a `runtime.*` node able to **stream typed data events** that the workflow can forward to SSE, with **no Redis and no concurrency hack**, because the runner already consumes the gRPC stream concurrently with awaiting the final result.

**Work items:**

1. **Python (and Rust) SDK: emit `PartialResult`.** Give node handlers an API to emit intermediate events, e.g.:
   ```python
   def execute(self, ctx, config):
       ctx.emit({"type": "text", "value": "tok"})      # → ExecuteEvent.PartialResult
       ctx.emit({"type": "source", "value": {...}})
       ...
       return {"answer": ..., "sources": [...]}          # → terminal ExecuteResponse
   ```
   `grpc_server.py:ExecuteStream` already runs the handler on a worker thread while the generator yields — extend the per-call plumbing to also drain an **emit queue** and yield `PartialResult` protos (it already yields `LogLine`s this way; mirror it). File: `…/blok/server/grpc_server.py:98-150`.

2. **Runner: surface `PartialResult` to the workflow.** In `RuntimeAdapterNode.runStreaming` (`core/runner/src/RuntimeAdapterNode.ts:59-180`), stop discarding `PartialResult`. Two sub-options — **pick one and document it:**
   - **A1 (auto-forward to SSE):** if `ctx.stream` is present, each `PartialResult` is `ctx.stream.writeSSE({ event: p.event, data: p.data })` (and/or published to `ctx.stream`'s bus). The runtime node "just streams" to the client. Add a node config like `streamTo: "sse"` to opt in.
   - **A2 (consumable iterator):** expose the partials as an async iterator on the step result (e.g. `ctx.state.<id>.stream`) so a downstream `@blokjs/sse-stream`-style node pumps them with full control (mapping → the 12 event names, periodic DB flush, disconnect handling). More flexible; preferred if event mapping/finalization logic is non-trivial.
   - The terminal `ExecuteResponse` still becomes the node's normal return value (`ctx.state.<id>` = final `{answer, sources, ...}`), so finalization steps run after.

3. **Gate it** behind explicit opt-in (`type:"runtime.python3"` + `stream:true`/`streamTo`) so existing unary nodes are unaffected.

**Why this is best:** no external broker, no race, no fake concurrency. The runner *already* consumes the event stream concurrently with the final-result promise (`GrpcRuntimeAdapter.ts:194-198`) — A just stops throwing the data away.

### 3.2 Route B (tactical) — Redis backplane (G1) + parallel/detached step (G2)

If Route A can't land in one pass, deliver these two so the downstream product can pump a Redis-published stream.

**G1 — cross-process bus backplane + a Redis-subscribe node.** Either or both of:
- **B-G1a: pluggable bus backend.** Extend `triggers/sse/src/bus.ts` with a backend interface; default in-process; add a **Redis backend** (Redis Streams preferred — gives durable replay for `Last-Event-Id`; pub/sub acceptable for v1). `subscribe()` then receives events published by *any* process to the same Redis channel. Config via `REDIS_URL` (already used by `BLOK_CONCURRENCY_BACKEND=redis`). This makes `@blokjs/sse-subscribe`/`sse-stream` "just work" across processes — the cleanest G1 fix.
- **B-G1b: a `@blokjs/redis-subscribe` node** that opens an `ioredis` subscriber to given channels and returns `{ iterator }` shaped exactly like `@blokjs/sse-subscribe`, so it composes with `@blokjs/sse-stream` unchanged. Smaller blast radius; doesn't touch the bus. **Note the pub/sub ordering hazard:** messages published before `subscribe()` is active are lost — document that producers must start *after* the subscriber, or use Redis Streams (`XADD`/`XREAD`) for durability + replay.

**G2 — a real concurrency primitive.** Add one of:
- **B-G2a (preferred): a `parallel([...])` step** in `core/workflow-helper` (sibling of `branch`/`forEach`/`tryCatch`) that runs N **heterogeneous** sub-pipelines concurrently and joins after, each writing its own `ctx.state.<id>`. Implement on the runner with `Promise.allSettled` (reuse `ForEachNode`'s parallel pool internals at `core/runner/src/ForEachNode.ts:216-501`). This is broadly useful beyond SSE.
- **B-G2b (lighter): a `detached:true` step flag** that runs a step without blocking subsequent steps, plus a `join`/await point. Narrower; mainly the producer-while-pumping case.

With G1+G2 the downstream workflow becomes: `parallel([ agent (runtime.python3, publishes to Redis), pump (redis-subscribe → writeSSE) ])` → finalize.

### 3.3 G4 (both routes) — one-shot SSE emit node
Add **`@blokjs/sse-emit`**: input `{ event: string, data: unknown, id?: string, retry?: number }`; calls `ctx.stream.writeSSE(input)` once and returns `{ sent: true }`. Throws the same "only under trigger.sse" guard as `sse-stream` (`sseStream.ts:40-45`). Lets workflows emit `message_ids`/`workflow_start`/`complete`/`error` inline between steps without the bus.

---

## 4. Acceptance criteria

A new integration test under `triggers/sse/` (mirror `triggers/sse/src/SSETrigger.integration.test.ts:114-192`) must demonstrate:

**Route A:**
- A `runtime.python3` (or a fake runtime adapter) node that `emit()`s 3 partials then returns a final result.
- An SSE workflow with that node + `stream`/`streamTo` opt-in emits **3 live SSE frames** (the partials) followed by frames produced from the **final return**, in order, on one connection.
- Disconnect mid-stream (`ctx.stream.signal`) stops client writes but the node still runs to completion (final state still set).

**Route B:**
- `@blokjs/redis-subscribe` (or the Redis-backed bus): a publisher in a **separate process/connection** publishes 3 events to a Redis channel; an SSE workflow subscribed to it emits 3 SSE frames. Include the `Last-Event-Id` replay case if Streams-backed.
- `parallel([...])`: two heterogeneous branches run concurrently (assert wall-clock < sum, both `ctx.state` entries populated); a throw in one branch surfaces per the documented policy.

**G4:** `@blokjs/sse-emit` writes exactly one frame with the given `event`/`data`/`id`.

Run the existing suite green: `triggers/sse` tests + `core/runner` tests + `nodes/utility/helpers@1.0.0` tests.

---

## 5. Pointers / file index (start here)

- SSE trigger + stream context: `triggers/sse/src/SSETrigger.ts`, `core/shared/src/types/StreamContext.ts`, `core/shared/src/types/Context.ts:146-160`
- Bus: `triggers/sse/src/bus.ts`, exported via `triggers/sse/src/index.ts` (`_getSSEBus`)
- Helper nodes: `nodes/utility/helpers@1.0.0/src/{sseSubscribe,sseStream,ssePublish,redisKv}.ts` + registry in `…/src/index.ts` (`HELPER_NODES`)
- Trigger opts schema: `core/workflow-helper/src/types/TriggerOpts.ts` (`SSETriggerOptsSchema`)
- Control-flow primitives (where `parallel` would live): `core/workflow-helper/src/components/{branch,forEach,loop,tryCatch,switchOn}.ts` + step shapes in `core/workflow-helper/src/types/StepOpts.ts`
- Runtime adapter / gRPC streaming: `core/runner/src/RuntimeAdapterNode.ts`, `core/runner/src/adapters/grpc/GrpcRuntimeAdapter.ts`, `proto/blok/runtime/v1/runtime.proto`
- Python SDK gRPC server: the vendored `…/runtimes/python3/blok/server/grpc_server.py` (mirror its `LogLine` queue plumbing for `PartialResult`)
- Parallel-pool reference impl to reuse: `core/runner/src/ForEachNode.ts:216-501`
- Existing framework-fixes doc (conventions): `BLOK_FRAMEWORK_FIXES.md`

---

## 6. Notes / non-goals
- Don't change the **public SSE event shape** or the existing in-process bus default behavior — these are additive opt-ins.
- Multi-process **horizontal scale** of SSE (sticky sessions / fan-in across replicas) is out of scope here; G1's Redis backplane is the foundation for it but the full story is separate.
- The downstream product will adapt once any of the above lands; it does not require all of them. Minimum viable unblock = **G1b + G2a + G4**, or just **G3 (A2) + G4**.
