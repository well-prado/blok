# ADR 0001 — First-class WASI Component Model runtime

- **Status:** Accepted — first implementation slice
- **Date:** 2026-09-04
- **Issue:** #944

## Context

Blok already has a legacy `runtime.wasm` adapter. It executes core WebAssembly
modules through the JavaScript WebAssembly API and a custom pointer/JSON ABI.
That adapter is not a WASI implementation and cannot host a WebAssembly
Component Model component. Format guessing would make the boundary ambiguous
and would turn an incomplete legacy path into an unsupported security claim.

The Component Model needs a versioned interface, explicit authority, bounded
execution, immutable artifact identity, and a host lifecycle that the existing
runner can observe. This ADR defines the contract and the seams implemented in
the first slice. A Wasmtime host is deliberately a later implementation slice.

## Decisions

### Runtime identity and migration

`runtime.wasi` is the canonical Component Model runtime kind. `runtime.wasm`
remains a legacy core-module ABI during migration. The two kinds never infer or
convert formats: a component supplied to `runtime.wasm`, or a core module
supplied to `runtime.wasi`, is rejected by the eventual host. Existing
`WasmRuntimeAdapter` behavior is frozen; its no-op preview1 imports are not a
production WASI contract.

The v1 authoring shape is a `wasi` manifest on a `runtime.wasi` step. It pins a
SHA-256 digest, media type, exported node, `blok:runtime@1.0.0` world, WASI
0.2, capabilities, and limits. Local URIs are acceptable for development, but
the digest is always required and production policy must verify the bytes
against it before execution. Migration from `runtime.wasm` requires rebuilding
the guest as a component and adding this manifest; there is no transparent
adapter.

### Host topology and existing contracts

The target topology is:

```text
Blok runner -- canonical blok.runtime.v1 gRPC --> long-lived Rust/Wasmtime host
                                                       |
                                      digest cache + isolated Store/instance
                                                       |
                                              blok:runtime@1.0.0 world
```

The runner owns workflow scheduling, policy, tracing, and cancellation. The
long-lived host owns component validation, compilation, instantiation, WASI
linking, resource limits, and process recovery. A process is not spawned per
step, and mutable component instances are not shared between executions.

The TypeScript first slice exposes `WasiComponentHost`, an injectable seam with
`readiness`, `execute(request, signal)`, and `close`. The production
implementation will delegate to the existing `NodeRuntime/Health`,
`NodeRuntime/ListNodes`, and `NodeRuntime/Execute` gRPC protocol rather than
introducing a second runner protocol. Until that host exists, the registered
adapter reports unavailable and fails closed.

The JavaScript core WebAssembly API is insufficient because it does not
provide the Component Model type/linker API or a conforming WASI 0.2 host.
The Rust host is therefore the chosen production boundary. It can cache
verified compilation artifacts while allocating a fresh Store and instance per
call. Admission control and bounded queues belong to the host; readiness has
`ready`, `draining`, and `unavailable` states.

### Contract and version support

The canonical WIT package is [`wit/blok-runtime/1.0/world.wit`](../../../../wit/blok-runtime/1.0/world.wit):
`blok:runtime@1.0.0`, world `blok-node`. WIT owns the typed envelope,
structured error, logging, and mediated host imports. Arbitrary node data stays
inside bounded JSON strings because node schemas are author-defined. Raw
linear-memory pointers are not a public Blok ABI.

This baseline targets WASI 0.2 and the synchronous Component Model surface.
WASI 0.3, native async functions, futures, and streams require a separately
versioned world and conformance evidence. Patch releases are additive; a
component that requires an unknown optional interface is rejected with a
protocol error. A major contract change gets a new package/world.

### Capability and sandbox boundary

Capabilities are deny-by-default. The component manifest reuses the shared
Capability Manifest v1 for classification, effects, opaque secret names, and
resource metadata. The host/deployment supplies an approval allow-list; the
component cannot gain authority from the host process environment.

The initial boundary does not preopen directories or pass the host environment.
Filesystem, network/DNS, environment/config, secrets, clock/time zone,
randomness, HTTP, sockets, persistent state, subprocesses, and native host
extensions require explicit versioned host interfaces and policy approval.
Logging, tracing, and claim-check reads are mediated imports; logical secret
names and blob IDs cross the boundary, never host paths or credentials.

### Lifecycle, cancellation, and limits

The request seam carries the component digest, export name, resolved input,
request projection, content type, deadline, and traceparent. The host must
reject an unready or draining execution before admission and must honor the
provided `AbortSignal`/deadline. Workflow cancellation maps to
`WASI_COMPONENT_CANCELLED`; epoch/wall deadline interruption maps to
`WASI_COMPONENT_DEADLINE_EXCEEDED`; malformed responses map to a protocol
error. Component errors preserve stable code, category, message, retryability,
and bounded safe details.

The manifest can bound fuel, wall time, memory, input/output/log bytes,
host-call count, concurrency, and queue depth. Fuel is the deterministic
compute budget; epoch interruption is required for real wall-clock
cancellation. The host must also bound tables, instances, stack, compilation,
open resources, and copy volume. These are host obligations, not claims made
by the TypeScript seam.

### Artifact and tenancy policy

The cache key is at least `(tenant/project, artifact digest, WIT package/world
version, WASI version, engine/target configuration)`. Mutable tags are not
production identities. Cache corruption or an engine/config mismatch causes
eviction and recompilation, never execution of an unverified artifact.
Tenant/project cache namespaces and per-execution Stores are isolated. OCI
distribution, signatures, provenance, SBOMs, and a non-root host image are
future deployment slices; this ADR does not claim them implemented.

## Conformance evidence for this slice

- `core/shared/__tests__/unit/WasiComponentContracts.test.ts` covers manifest
  identity, digest and WASI version rejection, response invariants, and the
  schema-neutral execution envelope.
- `core/runner/src/adapters/__tests__/WasiComponentRuntimeAdapter.test.ts`
  covers unavailable/readiness, fail-closed host absence, capability denial,
  typed success/error mapping, cancellation propagation, and shutdown.
- `wit/blok-runtime/1.0/world.wit` and its README are the canonical contract
  and compatibility policy.

The first slice does not claim Wasmtime execution, component inspection,
signature verification, fuel enforcement, real filesystem/network mediation,
CLI component tooling, or cross-language guest conformance. Those remain
explicit follow-up slices.

## Consequences

- Authors can name and validate a Component Model runtime without confusing it
  with legacy core WebAssembly.
- The runner has a deterministic seam for host and policy conformance tests.
- A configured deployment without a supported host fails with a typed,
  actionable error instead of silently executing through the legacy adapter.
- A Rust/Wasmtime host and generated bindings must conform to this WIT and
  request/response seam before the runtime is advertised as production-ready.
