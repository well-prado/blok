# Elixir/BEAM runtime conformance

This page records the executable evidence for `runtime.elixir`. The runtime
uses the same `NodeRuntime` v1 protocol as the other sidecars; it does not
reimplement workflow semantics.

| Contract | Evidence | Expected invariant |
| --- | --- | --- |
| Typed input/output | `sdks/elixir/test/schema_test.exs`, `node_test.exs` | JSON wire maps become declared structs; invalid input/output has stable paths/codes. |
| Atom safety | `schema_test.exs`, `beam_failure_modes_test.exs` | Unknown JSON keys, adversarial node names, headers, and run ids do not increase the atom table. |
| Discovery/reflection | `Blok.Node.descriptor/1`, `Blok.Runtime.list_nodes/0` | Node name, descriptions, JSON Schema, tags, and capability JSON are discoverable. |
| Supervision/admission | `sdks/elixir/lib/blok/admission.ex`, `admission_test.exs`, `beam_failure_modes_test.exs` | Active work and queue are bounded; overload is deterministic; a failed task does not kill the endpoint. |
| Configuration | `sdks/elixir/lib/blok/config.ex`, `test/config_test.exs` | Port, message size, keepalive, connections, TLS/mTLS, concurrency, queue, grace, and log level are env-configured and validated at startup. |
| Telemetry | `sdks/elixir/lib/blok/telemetry.ex`, `test/telemetry_test.exs` | Start/stop/exception carry duration and queue time; metadata is identity-only. |
| Errors/deadlines | `sdks/elixir/lib/blok/runtime.ex`, `Blok.Context`, `beam_failure_modes_test.exs` | Validation, timeout, cancellation, crash, drain, and overload map to `NodeError`. |
| Claim-check | `sdks/elixir/lib/blok/blob.ex` | `blob-v1` is advertised only when configured; ids and read sizes are bounded. |
| Proto drift | `bun scripts/sync-proto.ts --check` | Elixir’s source proto copy matches `proto/blok/runtime/v1/runtime.proto`. |
| Runner integration | `core/runner/src/Configuration.ts`, `core/runner/src/adapters/grpc/types.ts` | `runtime.elixir` resolves through the shared gRPC adapter at port 10010 unless env-overridden. |

## BEAM failure modes

`sdks/elixir/test/beam_failure_modes_test.exs` covers, deterministically:

| Failure mode | Assertion |
| --- | --- |
| Concurrent request isolation | Twelve interleaved executions: crashing nodes fail alone, healthy ones return correct output. |
| Bounded process creation | A 20-request burst against a 2+2 admission keeps exactly two live tasks. |
| Queue saturation | The same burst yields exactly four accepted and sixteen `{:error, :overloaded}` results. |
| Mailbox/queue growth | Sampled during a 30-caller burst: active ≤ 2, queued ≤ 2, admission mailbox bounded by the caller count. |
| Deterministic overload | Over the real `Execute` path: `max_concurrency + max_queue` succeed, the surplus gets `RUNTIME_OVERLOADED` (`RATE_LIMIT`, retryable, `retry_after_ms > 0`). |
| Node raise/throw/exit | `NODE_ERROR`, `NODE_THROW`, `NODE_EXIT` with unchanged supervisor children. |
| Node process crash | An externally killed execution becomes `NODE_PROCESS_CRASH`; the endpoint keeps serving. |
| Sparse request | A request without trigger/state/workflow submessages executes instead of raising into the endpoint. |
| Descendant cleanup | A node's `Task.start_link` child is dead after the node's deadline kills it. |
| Deadline propagation | A 10s node with a 200ms deadline returns `NODE_DEADLINE_EXCEEDED` in under 2s. |
| Cancellation token | `Blok.Context.cancelled?/1`, `check_cancelled!/1`, and `remaining_ms/1` honour token and deadline. |
| Supervisor recovery | Killing `Blok.Admission` restarts it; the gRPC endpoint pid is unchanged and execution resumes. |
| Graceful drain | In-flight work completes, new requests get `RUNTIME_DRAINING`, `Health` reports `NOT_SERVING`. |
| Drained queue | Queued work is answered with `:draining` instead of being stranded until the call timeout. |
| Atom-table safety | 100 executions with adversarial node names, JSON keys, headers, run ids and workflow names leave `:erlang.system_info(:atom_count)` unchanged. |
| Secret redaction | Env values and `authorization` headers appear in no log line, error message, or `details_json`; secret-shaped metadata keys are `[REDACTED]`; oversized values are truncated. |

## Required smoke lane

On a host with Elixir, OTP, Mix, and the generated SDK dependencies available:

```sh
cd sdks/elixir
mix deps.get
mix proto.generate
mix format --check-formatted
mix test
mix release
```

Elixir is required in both the scaffold smoke lane and the Docker cross-runtime
chain. `prepare-usernodes.ts` uses the actual CLI generator to register the
canonical `typed-greet`, `chain-test`, and scaffolded `e2e-user` nodes. The
harness checks canonical capability metadata, valid/invalid inputs, a 2 MiB
claim-check round trip, user-node execution, and chain data preservation.

Local evidence (Elixir 1.20.4 / OTP 29, macOS/Apple silicon): `mix test` passes
39 tests; `mix format --check-formatted` is clean; `bun scripts/sync-proto.ts
--check` reports 12 copies in sync. The real gRPC harness run against a
CLI-scaffolded sidecar (`bun tests/e2e/cross-runtime/prepare-usernodes.ts`, then
`ELIXIR_GRPC_PORT=… BLOK_E2E_USERNODES=1 bun
tests/e2e/cross-runtime/spec-b-typed-e2e.ts`) passed **26 checks, 0 failed**,
including the canonical capability manifest, a 2 MiB claim-check round trip, and
`e2e-user` discovery/execution. A `MIX_ENV=prod mix release` built, booted with
`BLOK_ELIXIR_MAX_CONCURRENCY=4`, passed 20 harness checks (no `BLOK_BLOB_DIR`, so
the claim-check leg self-skips), and `bin/blok stop` drained and exited cleanly.
These are single-runtime runs; the complete polyglot chain and the production
container still require the corresponding CI jobs.

## Performance artifact

`mix blok.bench` boots the sidecar, opens one gRPC channel per worker, and
drives the canonical `typed-greet` node over real gRPC:

```sh
cd sdks/elixir
GRPC_PORT=20010 mix blok.bench --concurrency 32 --duration 15
```

**Workload.** Unary `Execute` of `typed-greet` (`{"name":"bench","repeat":1}`),
30s deadline, one channel per client, 2s discarded warm-up, 15s measured.
Admission defaults: concurrency 16, queue 64.

**Environment.** Apple M1 Pro, 10 schedulers online, 16 GB RAM, macOS 26.6.2,
Elixir 1.20.4 / OTP 29, `MIX_ENV=dev`, client and sidecar in the same VM (so
these numbers exclude network latency and include the client's own CPU cost).

| Metric | 32 clients | 64 clients |
| --- | --- | --- |
| Requests | 167,746 | 164,623 |
| Throughput | 11,176 req/s | 10,970 req/s |
| Errors | 0 (0.00%) | 0 (0.00%) |
| Latency p50 | 2.28 ms | 4.66 ms |
| Latency p95 | 7.02 ms | 13.80 ms |
| Latency p99 | 11.46 ms | 19.99 ms |
| Latency max | 53.4 ms | 57.1 ms |
| Admission queue time p50 | 0.51 ms | 2.31 ms |
| Admission queue time p99 | 2.70 ms | 9.62 ms |
| Peak process count | 439 | 691 |
| Scheduler utilisation | 42.7% | 44.2% |
| Reductions (15s) | 1.06e9 | 1.04e9 |
| Memory total / processes | 109 / 43 MiB | 115 / 49 MiB |

Reading: throughput is flat between 32 and 64 clients while latency and
admission queue time roughly double — the bound is admission (16 concurrent
executions), exactly as designed, and process count stays proportional to
in-flight work rather than to offered load. Zero errors at both levels confirms
that queueing, not rejection, absorbs load below the queue ceiling.

The first measured run at 32 clients reported 0.06% `RUNTIME_OVERLOADED`. That
was a real defect: the execution `Task.Supervisor` shared its ceiling with the
admission bound, so a task that had already replied but not yet terminated
could make `start_child` fail and be reported as saturation. The supervisor
ceiling now sits above the admission bound
(`sdks/elixir/lib/blok/application.ex`), and the rerun is clean.
