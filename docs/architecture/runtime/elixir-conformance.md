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

Then boot the release with `GRPC_PORT=10010`, call Health, ListNodes, and
Execute using the canonical proto client. CI should include the Elixir lane in
the complete cross-runtime chain when the toolchain is installed; a missing
toolchain is a reported platform limitation, never a passing silent skip.
