# ADR 0014 — Bulk data across the runtime boundary: payload diet, fail-fast guard, claim-check blob store

- **Status:** Accepted — Phase 0 + Phase 1 implemented; Phase 2 pending founder sign-off
- **Date:** 2026-07-21
- **Resolves:** [#677](https://github.com/well-prado/blok/issues/677)

> **Progress (2026-07-23):** **Phase 1 (fail-fast guard + docs) and Phase 0
> (payload diet) shipped.**
>
> - *Phase 1:* `GrpcRuntimeAdapter` fails an oversized call *before* dispatch with
>   a `GRPC_REQUEST_TOO_LARGE` BlokError naming the node + per-blob breakdown, on
>   both unary and streaming paths. Safe by construction (the size approximation
>   under-counts the wire → no false positives → no kill switch). Tests:
>   `GrpcRuntimeAdapter.test.ts` "preflight size guard". Constraint documented at
>   `docs/d/reliability/large-payloads.mdx`.
> - *Phase 0 — shipped as OPT-IN, deviating from the "flip the default" plan
>   below.* An SDK sweep found that **all 7 SDKs surface `state.vars` (→ `ctx.vars`)
>   and `state.previous_output` (→ `ctx.response.data`) to node code**, and some
>   example nodes read `ctx.vars` — so flipping the default is a breaking change to
>   a documented capability, not the pure optimization the plan assumed. Decision
>   (founder): keep full-state as the default and gate the diet behind
>   **`BLOK_GRPC_STATE_DIET=1`** (opt-in) rather than `BLOK_GRPC_FULL_STATE=1`
>   (opt-out). `env` + trigger body always sent; response `vars_delta` untouched.
>   Revisit the default-flip in a major release once the SDKs stop surfacing these
>   to v2 nodes. Tests: `GrpcCodec.test.ts` "state diet".
>
> **Phase 2** (claim-check blob store — runner + 7 SDKs + Helm) is not started,
> pending a scope decision.
- **Origin:** tetrix-blok indexing failure (its #138/#140) — an aggregate of every symbol *with full code bodies* was passed inline to a `runtime.*` node and blew the gRPC message ceiling. The app was at fault for not designing around the constraint, but the framework makes the failure easy to fall into and offers zero primitives to avoid it.

## Context

Every remote node call is one unary `Execute` message that inlines **four** JSON blobs
(`core/runner/src/adapters/grpc/GrpcCodec.ts:226-285`):

| Blob | Source | Encoded at |
|---|---|---|
| `inputs` | mapped inputs for this one node | `GrpcCodec.ts:234,248` |
| `state.vars` | the **entire accumulated `ctx.state`** (`ctx.vars` is an alias — `core/shared/src/types/VarsContext.ts:4-6`) | `GrpcCodec.ts:236,268` |
| `state.previous_output` | previous step's full output | `GrpcCodec.ts:235,267` |
| `trigger.body` | full raw trigger body, re-sent on every node call | `GrpcCodec.ts:240,256` |

Because auto-persist appends every step output to `ctx.state`
(`core/runner/src/workflow/PersistenceHelper.ts`), the `vars` blob grows
monotonically — per-call payload size grows with workflow length, re-serialized
via `Buffer.from(JSON.stringify(...))` with no size guard (`GrpcCodec.ts:427-430`).

The only backstop is the symmetric message-size limit:

- Default 16 MiB (`core/runner/src/adapters/grpc/types.ts:86-87`), hard ceiling
  256 MiB (`core/runner/src/adapters/transport.ts:91`), applied to send+receive
  (`GrpcChannelOptions.ts:25-26`).
- Not negotiated — a convention: runner and every sidecar independently read
  `BLOK_GRPC_MAX_MESSAGE_BYTES` (Python `bin/serve.py:65-83`, Rust
  `config.rs:15-19`, Go `grpc_server.go:291-292`). Mismatch → opaque
  `RESOURCE_EXHAUSTED` at the gRPC layer, naming no step and no remedy.
- The ceiling exists because unary messages are **fully buffered in memory on
  both ends**; peak ≈ `forEach`-concurrency × message size (`transport.ts:85-90`).

There is **no** bulk-data machinery anywhere: no compression on the channel, no
chunking (`ExecuteStream` at `proto/blok/runtime/v1/runtime.proto:40` is
server→client *events* only — unusable for request offload), no spill-to-disk,
no external-reference field in the proto. The claim-check pattern exists only
as a `console.warn` string and a doc comment (`transport.ts:105-106,113-118`).
The `RunStore` (memory/sqlite/postgres) is a relational trace store the
sidecars cannot reach; there is no blob store and no temp-file utility.

Deployment shapes that any fix must respect:

- **Dev:** runner + sidecars on one host, loopback, shared filesystem
  (`scripts/dev-full.ts`).
- **Prod (Helm):** runtimes are sidecar containers in the **same pod**
  (`infra/helm/blok/values.yaml:61-64`) — shared network namespace, no shared
  writable filesystem *by default*, but a shared `emptyDir` mount is a
  one-stanza chart change.
- **Cross-host:** `RUNTIME_<KIND>_HOST` can point anywhere, optionally TLS
  (`transport.ts:140-177`). No shared-filesystem assumption is safe here.

## Options

**A — Raise limits / enable channel compression.** Mitigation, not a fix: the
ceiling stays, per-call memory amplification stays, and gzip on JSON only buys
a constant factor. Compression also burns CPU on the 99% of calls that are
small. Rejected as the answer (channel compression remains available later as
an orthogonal opt-in knob).

**B — Chunked client-streaming `Execute` RPC.** Removes the message ceiling
with no storage. But: (i) both ends still buffer the full payload in memory —
the actual resource the ceiling protects; (ii) it requires implementing and
maintaining a new RPC in all seven SDK languages; (iii) it does nothing about
state re-shipping growth or trace-snapshot bloat, because the data still lives
inline in `ctx.state`. Deferred (Phase 3 candidate if streaming node APIs ever
land).

**C — External object-store claim-check (S3/minio), Temporal-style.** The
industry pattern, but it taxes every deployment with new infra, credentials in
every sidecar, and a GC story — absurd overhead for the dominant deployment
shape (runner + sidecars in one pod). Deferred to a pluggable backend behind
the same interface.

**D — Phased: diet → guardrail → runner-owned blob store with automatic
threshold offload.** Fix the self-inflicted payload growth first, make the
failure mode loud and actionable second, then add the minimal claim-check that
prevents the failure structurally — filesystem-backed, zero external infra,
additive on the wire. **Chosen.**

## Decision — Option D

### Phase 0 — payload diet (stop shipping what nodes must not read)

The v2 node contract is input-only: nodes receive mapped `inputs` and must
never read `ctx.state`/`ctx.vars` (`CLAUDE.md`, node ABI). Sending the full
accumulated state and the previous output to every remote node is legacy ABI
baggage — and it is the *monotonic growth* term.

- `encodeExecuteRequest` drops `vars` and `previous_output`. **Shipped as
  opt-in `BLOK_GRPC_STATE_DIET=1` (default off)**, not the default-flip
  originally drafted here — the SDK sweep showed all 7 SDKs surface both fields
  to node code (`ctx.vars` / `ctx.response.data`), so flipping the default is a
  breaking change. See the progress note above for the deviation and rationale.
  Flip the default in a major release once SDKs stop surfacing these to v2 nodes.
- `trigger.body` **stays** — `ctx.request` is an explicitly kept runtime ABI
  (headers/params/query/body) and nodes legitimately read it. It is bounded by
  trigger-level body limits and constant per run, not growing.
- No proto change: `bytes` fields are simply left empty (additive-compatible;
  old SDKs decode `{}`).

### Phase 1 — fail-fast preflight guard + document the constraint

The runner already computes `approximateRequestBytes`
(`GrpcRuntimeAdapter.ts:731-738`) — today only as a metric. Before dispatch:

- If the encoded request exceeds the configured limit, throw a `GlobalError`
  (413-class) **naming the workflow, step, per-blob byte breakdown
  (inputs/vars/previous/body), the configured limit, and the remedies** (raise
  `BLOK_GRPC_MAX_MESSAGE_BYTES` symmetrically; enable blob offload; restructure
  the pipeline). This turns tetrix's opaque `RESOURCE_EXHAUSTED` into a named,
  actionable failure at the offending step.
- New docs page `docs/d/reliability/large-payloads.mdx` — the 16 MiB/256 MiB
  constraint, the symmetric-env-var requirement, and the claim-check guidance
  currently living only in a code comment.

### Phase 2 — claim-check core (the primitive)

**Store.** A `BlobStore` interface in the runner: `put(runId, bytes) → BlobRef`,
`get(ref) → bytes`, `deleteForRun(runId)`. Default backend: filesystem rooted
at `BLOK_BLOB_DIR` (default `.blok/blobs/`). Pluggable (S3/GCS) later behind
the same interface — not now.

**Ref format.** A JSON sentinel that travels inside the *existing* `bytes`
fields — zero proto changes:

```json
{ "$blokBlob": { "id": "<runId>/<uuid>", "bytes": 297812344, "codec": "json" } }
```

**Offload points (automatic, threshold-based).** Declared-only offload would
still let naive pipelines blow up; automatic offload is what prevents the
failure *structurally*. Threshold `BLOK_BLOB_THRESHOLD_BYTES`, default 1 MiB
(precedent: `BLOK_STATE_SNAPSHOT_MAX_BYTES` = 1 MB).

- *Request direction:* after mapping, if encoded `inputs` exceed the threshold
  and the target runtime advertises blob support, the runner `put`s the value
  and sends the ref.
- *Response direction:* an SDK whose node output exceeds the threshold writes
  the blob to `BLOK_BLOB_DIR` and returns the ref in `data`; the runner keeps
  the **ref** in `ctx.state[id]` (lazy), which also shrinks trace-store
  `state_snapshot` rows and resume payloads for free.
- *Hydration:* the Mapper hydrates a ref transparently when a downstream read
  actually maps it (`$.state.index.field` → runner-side `get`, then field
  extraction). Local (Node) nodes see plain values; they never observe refs.

**Capability gating.** The runner sends refs only to runtimes that advertise
support — an additive `capabilities: ["blob-v1"]` field on the `ListNodes`
response (the runner already calls it at boot). Non-capable runtime → fall back
to inline, and Phase 1's guard fires with a clear error if too big. SDK-side
work per language is deliberately trivial: detect sentinel → read file before
`input.parse`; write file + return sentinel on oversized output.

**Lifecycle.** Blobs are owned by a run. The existing `Janitor`
(`core/runner/src/tracing/Janitor.ts`) gains `purgeExpiredBlobs`: delete a
run's blobs once the run is terminal plus `BLOK_BLOB_RETENTION_MS` (default:
match trace retention). Blobs survive `wait`/resume windows because retention
keys off *terminal* state.

**Deployment.** Helm chart mounts one shared `emptyDir` into the runner and
every runtime sidecar container, sets `BLOK_BLOB_DIR` on all of them. Dev
(`dev-full.ts`) sets it automatically. Cross-host runtimes without a shared
mount simply don't advertise the capability → inline fallback + Phase 1 guard.

### Phase 3 — deferred (explicitly not now)

Typed `BlobHandle` in the DSL (`{ payload: "blob" }` fourth-arg knob),
node-side streaming reads, S3/GCS backends, chunked `Execute` RPC, per-field
offload. Build when a real pipeline needs them; the tetrix class of failure is
fully covered without them.

## Consequences

- v2 remote calls stop growing with workflow length; the four-blob payload
  drops to ~`inputs` + `trigger.body` (Phase 0).
- Oversized payloads fail **before dispatch** with the step named and the
  remedy stated, instead of an unattributed `RESOURCE_EXHAUSTED` (Phase 1).
- With `BLOK_BLOB_DIR` configured, tetrix-class pipelines (huge arrays across
  `runtime.*`) work with **no app-level claim-check code** — the framework
  knock ("a first-class primitive would have prevented it structurally") is
  answered (Phase 2).
- Trace-store `state_snapshot` and `node_runs` rows shrink for blob-holding
  runs as a side effect of refs-in-state.
- Costs accepted: a blob GC lifecycle tied to the janitor; a shared-volume
  stanza in the Helm chart; one additive proto field; a small read/write helper
  in each of the seven SDKs (file I/O, not a new RPC).
- Risks: legacy runtime nodes that read `ctx.vars`/previous output break under
  Phase 0's default — mitigated by the `BLOK_GRPC_FULL_STATE=1` kill switch and
  a migration note; mapper hydration of a ref re-buffers the value in the
  runner (single process, no wire hop) — per-field offload stays a Phase 3
  option if this bites.
- Rollout: Phase 0 + 1 are small PRs, shippable immediately; Phase 2 is one
  runner PR + one SDK sweep + one Helm PR, gated entirely on env/capability so
  it is inert until configured.
