---
"@blokjs/runner": minor
---

Remote runtime calls no longer ship the accumulated workflow state by default (#874).

`ctx.vars` is an alias of `ctx.state`, so it holds **every** completed step's output.
Every `runtime.*` (gRPC) call inlined that whole bag plus the previous step's output,
which made per-call cost linear in the run's accumulated state — a runtime node inside
a `forEach` re-serialized a payload that grew with the loop, for O(n²) over the loop,
with a slow crawl rather than an error as the failure mode. ADR 0014's opt-in
`BLOK_GRPC_STATE_DIET=1` is now the **default**, resolved in one place
(`isStateDietEnabled()` in `core/runner/src/adapters/transport.ts`).

Measured with `benchmarks/grpc-state-payload.ts` — 1200 calls over real gRPC against a
state that accumulates one 512 B step output per call: **384.79 MiB → 0.09 MiB** sent,
**4984 ms → 427 ms**, and per-call time goes from 1.07 ms → 6.88 ms across the deciles
to a flat ~0.25 ms.

**Unchanged:** mapped `inputs` (where a v2 node reads its data), `env`, the trigger
body, and the response `vars_delta` — so state still flows back out of a node.

**If a node reads `ctx.vars` or `ctx.response.data` inside its own body** it now sees
them empty. Set `BLOK_GRPC_STATE_DIET=0` to restore the old payload process-wide, or —
better, and per-node — map the value that node needs into that step's `inputs`.
