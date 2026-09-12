# Elixir/BEAM runtime conformance

This page records the executable evidence for `runtime.elixir`. The runtime
uses the same `NodeRuntime` v1 protocol as the other sidecars; it does not
reimplement workflow semantics.

| Contract | Evidence | Expected invariant |
| --- | --- | --- |
| Typed input/output | `sdks/elixir/test/schema_test.exs`, `node_test.exs` | JSON wire maps become declared structs; invalid input/output has stable paths/codes. |
| Atom safety | `schema_test.exs` | Unknown JSON keys do not increase the atom table. |
| Discovery/reflection | `Blok.Node.descriptor/1`, `Blok.Runtime.list_nodes/0` | Node name, descriptions, JSON Schema, tags, and capability JSON are discoverable. |
| Supervision/admission | `sdks/elixir/lib/blok/admission.ex`, `admission_test.exs` | Active work and queue are bounded; overload is deterministic; a failed task does not kill the endpoint. |
| Errors/deadlines | `sdks/elixir/lib/blok/runtime.ex`, `Blok.Context` | Validation, timeout, cancellation, crash, and overload map to `NodeError`. |
| Claim-check | `sdks/elixir/lib/blok/blob.ex` | `blob-v1` is advertised only when configured; ids and read sizes are bounded. |
| Proto drift | `bun scripts/sync-proto.ts --check` | Elixir’s source proto copy matches `proto/blok/runtime/v1/runtime.proto`. |
| Runner integration | `core/runner/src/Configuration.ts`, `core/runner/src/adapters/grpc/types.ts` | `runtime.elixir` resolves through the shared gRPC adapter at port 10010 unless env-overridden. |

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

Local evidence (Elixir 1.20.4 / OTP 29): SDK tests pass; the real gRPC harness
against the generated Elixir SDK passed 26 checks with zero failures, including
claim-check and user-node discovery. A production Mix release also built, booted,
and passed 23 gRPC checks. These are single-runtime runs; the complete
polyglot chain and production container still require the corresponding CI
jobs. Admission/cancellation, TLS, and resource baselines remain separate issue
#943 acceptance work and are not established by these checks.
