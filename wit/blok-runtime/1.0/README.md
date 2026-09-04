# `blok:runtime@1.0.0`

This directory is the canonical WIT source for the first Blok Component Model
contract. It defines the `blok-node` world in `world.wit`.

The v1 baseline is the stable WASI 0.2 Component Model surface. WASI 0.3
native async functions, futures, and streams are not implied by this package;
they require a separately versioned contract and conformance evidence.

The `node` interface uses bounded JSON strings for arbitrary node input and
output schemas. This is deliberate: WIT owns the envelope, lifecycle, and
error shape, while workflow schemas remain author-defined data. Components
must not expose raw linear-memory pointers as a Blok ABI.

`host` imports are mediated capabilities. A host must link only imports
approved by the component manifest and deployment policy. Filesystem, network,
environment, clock, randomness, subprocess, persistence, and HTTP access are
denied unless a later versioned interface explicitly defines and authorizes
them. Secret values and host paths never belong in manifests, logs, traces, or
error details.

## Compatibility policy

- Patch releases are additive and must preserve existing record fields and
  semantics.
- Minor releases may add optional interfaces/imports; a v1 host may reject a
  component that requires them with a typed protocol error.
- Major releases require a new package/world and an explicit migration path.
- `runtime.wasi` is distinct from the legacy `runtime.wasm` core-module JSON
  pointer ABI. Neither format is guessed or silently adapted to the other.

The WIT source is reviewed like `proto/blok/runtime/v1/runtime.proto`. Generated
bindings, when added, must be produced by pinned tooling and checked for drift;
this first slice intentionally does not add generated guest bindings or a
Wasmtime host.
