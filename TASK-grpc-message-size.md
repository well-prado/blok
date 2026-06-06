# TASK (BLOK): env-configurable gRPC max message size (client + all server SDKs)

**Why:** The runtime gRPC transport hardcodes a 16 MB max message size on the TS client and
leaves the **Rust** server unconfigured (stuck at tonic's **4 MB** decode default). Pipelines that
pass a large intermediate dataset between `runtime.*` nodes (bulk indexing symbol arrays,
embedding/feature matrices, large document batches) exceed it. Downstream (Tetrix-BLOK) worked
around it with a private-field monkeypatch (`RuntimeMessageSize.ts`, reaches into
`adapter.config`/`adapter.pool` via `as unknown`) **plus** a gitignored `.blok/` rust edit — both
fragile: the monkeypatch silently no-ops if the adapter is refactored; the `.blok` edit is **lost on
every `blokctl` re-provision** (reverts Rust to 4 MB → silent breakage).

The cap itself is a **sane, deliberate default** (gRPC's own default is 4 MB; messages are fully
buffered in memory on both ends; protobuf hard-ceilings at 2 GiB). This task does NOT change the
default — it adds the **missing knob** and fixes the **unset Rust server limit**, so the workaround
can be deleted. The durable answer for genuinely-bulk data is still the claim-check pattern (write to
MinIO/S3, pass a handle) — documented below as guidance, not implemented here.

## Required outcome (acceptance)
1. A single env var, **`BLOK_GRPC_MAX_MESSAGE_BYTES`** (bytes, integer), read by **all three**
   processes — TS client, Python sidecar, Rust sidecar — and applied **symmetrically** (send+recv /
   encode+decode) so client and server limits always move together.
2. **Default unchanged at 16 MB.** Unset env ⇒ byte-identical to today.
3. Validation: parse int; invalid (NaN / ≤ 0) ⇒ fall back to default; **clamp to ≤ 256 MB** (well
   under protobuf's 2 GiB ceiling) with a warn.
4. Each process **logs the effective limit at boot** so asymmetry is visible in logs, not as a
   mid-run `RESOURCE_EXHAUSTED`.
5. After this lands, `RuntimeMessageSize.ts` and the `.blok` rust edit are **deleted** downstream.

## Evidence / current behavior (confirm before changing)
- TS client: `core/runner/src/Configuration.ts:118` hardcodes `maxMessageBytes:
  GRPC_DEFAULTS.MAX_MESSAGE_BYTES` (16 MB). `GrpcChannelOptions.ts:25-26` maps it to
  `grpc.max_send/receive_message_length`. **No env read.**
- Python server: `sdks/python3/blok/server/grpc_server.py:306` `serve_grpc(... max_message_bytes=16MB)`
  applies send+recv (`:315-316`); caller `sdks/python3/bin/serve.py:59` does NOT pass it.
- Rust server: `sdks/rust/src/grpc_server.rs:176` `Server::builder().add_service(NodeRuntimeServer::new(service))`
  — **never calls** `.max_decoding_message_size()` → tonic 4 MB default. The generated
  `NodeRuntimeServer` DOES expose `.max_decoding_message_size()` / `.max_encoding_message_size()`.
- The runtime contract is `Execute(ExecuteRequest)` (unary) + `ExecuteStream(ExecuteRequest) returns
  (stream ExecuteEvent)` — **unary request, server-streamed response**. The big payload rides in the
  *request* (`inputs` + `previous_output`); there is **no client-streaming/bidi RPC**, so the input
  cannot be chunked without a proto change (out of scope; note as future option).

## Implementation (touch points)
**TS client (2 files):**
- `core/runner/src/adapters/transport.ts` — add `resolveMaxMessageBytes(env = process.env): number | undefined`
  mirroring `resolveHealthCheckIntervalMs` (`:62`): read `BLOK_GRPC_MAX_MESSAGE_BYTES`, parse, ignore
  NaN/≤0, clamp > 256 MB to 256 MB + warn.
- `core/runner/src/Configuration.ts:118` — `maxMessageBytes: resolveMaxMessageBytes() ?? GRPC_DEFAULTS.MAX_MESSAGE_BYTES`
  (+ import). Add a one-line boot log of the effective limit. (`GrpcChannelOptions.ts` unchanged.)

**Rust sidecar (3 files):**
- `sdks/rust/src/config.rs` — add `grpc_max_message_bytes: usize` (default 16 MB), read in `from_env()`
  (mirror `grpc_port` at `:54`: `env::var("BLOK_GRPC_MAX_MESSAGE_BYTES").ok().and_then(|s| s.parse().ok()).unwrap_or(16*1024*1024)`).
- `sdks/rust/src/grpc_server.rs:166` — `serve_grpc` gains a `max_message_bytes: usize` param; builder
  (`:176`) → `NodeRuntimeServer::new(service).max_decoding_message_size(n).max_encoding_message_size(n)`.
- `sdks/rust/src/main.rs:54` — pass `config.grpc_max_message_bytes` to `serve_grpc`. **Replaces the `.blok` edit.**

**Python sidecar (1 file):**
- `sdks/python3/bin/serve.py:59` — `max_message_bytes=int(os.environ.get("BLOK_GRPC_MAX_MESSAGE_BYTES", 16*1024*1024))`
  into `serve_grpc(...)` (server already applies send+recv).

**Orchestrator:** `blokctl dev` must propagate `BLOK_GRPC_MAX_MESSAGE_BYTES` into the sidecar process
envs (verify the spawn inherits the parent env). This is the one cross-cutting requirement — the
asymmetry trap lives here.

## Optional fast-follow (separate change): gzip compression
`BLOK_GRPC_COMPRESSION=gzip` (default off) — client `grpc.default_compression_algorithm`, python
`compression=grpc.Compression.Gzip`, rust `.accept_compressed/.send_compressed(Gzip)`. JSON payloads
shrink ~5–10×, often keeping them under 16 MB with **no raise at all**. Caveat (grpc-js CVE-2024-37168):
the decompressed size must still be bounded by `max_*_message_size` (the size knob enforces this).

## Tests
- TS: unit-test `resolveMaxMessageBytes` (valid / empty / NaN / negative / over-cap-clamped / default);
  assert `buildChannelOptions` reflects the resolved value.
- Python: assert `bin/serve.py` passes the env through to `serve_grpc`.
- Rust: `Config::from_env()` reads the var (default + override).
- Cross-SDK smoke (manual/CI): env set to 64 MB on all ends → a ~20 MB payload through a `runtime.rust`
  and `runtime.python3` node succeeds; env unset → same payload fails at the documented limit (proves
  default-unchanged + symmetry).

## Risk
- **Additive, opt-in, default-unchanged, wire-compatible.** Existing deployments unaffected.
- **Net safer** — deletes the private-field monkeypatch + the re-provision-fragile `.blok` edit.
- **The one real footgun = asymmetry** (client raised, a sidecar not): the under-configured end rejects
  with `RESOURCE_EXHAUSTED`. Mitigated by: one var read by all three ends + boot-time effective-limit
  log + the cross-SDK smoke test. Memory: a higher ceiling allows `concurrency × ceiling` peak (forEach
  parallel default concurrency = 10) — bounded by the 256 MB clamp + docs. It's a ceiling, not an
  allocation; normal small-message traffic is unaffected.

## Ships where
`@blokjs/runner` ships via npm (the lockstep release). The Rust/Python changes ship as **SDK runtime
images** (rebuilt by consumers), not npm — note the version in the design note. Default stays 16 MB.

— Filed from the Tetrix-BLOK gRPC-message-size investigation (2026-06-04), backed by a deep-research
pass on gRPC large-payload best practices (claim-check, streaming, the 4 MB default rationale).
