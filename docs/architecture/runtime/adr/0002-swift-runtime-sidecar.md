# ADR 0002 — First-class Swift runtime sidecar

- **Status:** Accepted — Linux production sidecar slice
- **Date:** 2026-09-05
- **Issue:** #939

## Decision

`runtime.swift` is a first-class, long-lived gRPC sidecar implemented as a
Swift Package Manager product in `sdks/swift`. Swift 6.1+, gRPC Swift 2,
SwiftProtobuf, and SwiftNIO HTTP/2 are the supported implementation baseline.
The sidecar uses the canonical `blok.runtime.v1.NodeRuntime` service and the
same `Execute`, `ExecuteStream`, `Health`, and `ListNodes` wire contract as the
other SDKs. Its default gRPC port is `10008`.

The runner owns scheduling, workflow state, policy, tracing, and the gRPC
deadline. The Swift process owns node registration, typed JSON decoding and
encoding, structured logs and errors, bounded claim-check reads, and graceful
drain on SIGINT/SIGTERM. A node is never run by spawning a process per step.

Swift user nodes implement the `NodeHandler` protocol. `blokctl dev` copies
the source into the Swift target and regenerates
`GeneratedUserNodeRegistry.swift`; the runtime then serves built-ins and user
nodes from one sidecar. `TypedNode` is the preferred authoring API and carries
input/output JSON Schema plus an optional capability manifest in `ListNodes`.

The production image is Linux-based and runs non-root. macOS source builds are
expected to be useful for development, but Apple platform CI, Xcode targets,
and Apple-specific transport behavior are explicitly out of scope for this
slice.

## Governing ADRs and contracts

- [`proto/blok/runtime/v1/runtime.proto`](../../../../proto/blok/runtime/v1/runtime.proto)
  is the wire source of truth; `scripts/sync-proto.ts` keeps the Swift copy in
  lock-step.
- [`specs/blok-vision/adr/0014-runtime-boundary-bulk-data.md`](../../../../specs/blok-vision/adr/0014-runtime-boundary-bulk-data.md)
  governs the `blob-v1` claim-check boundary. Swift resolves only bounded,
  validated `$blokBlob` IDs under the configured blob directory.
- [`docs/architecture/agent-harness/adr/0003-capabilities-effects-and-policy.md`](../../agent-harness/adr/0003-capabilities-effects-and-policy.md)
  and [`docs/d/fundamentals/capability-manifests.mdx`](../../../d/fundamentals/capability-manifests.mdx)
  govern capability declarations, opaque secret references, and fail-closed
  policy checks. No secret value is placed in a manifest, trace, or response.
- [`docs/architecture/runtime/adr/0001-wasi-component-runtime.md`](0001-wasi-component-runtime.md)
  remains separate: Swift is a native gRPC runtime and does not claim WASI or
  Component Model execution.

## Conformance evidence

| Requirement | Evidence |
|---|---|
| Canonical protocol and proto drift | `scripts/sync-proto.ts`, `scripts/proto-check.ts`, and `sdks/swift/Sources/BlokSwiftRuntime/Protos/blok/runtime/v1/runtime.proto` |
| Typed validation and schemas | `sdks/swift/Sources/BlokSwiftRuntime/Node.swift`, `Builtins.swift`, and `Tests/BlokSwiftRuntimeTests/RuntimeTests.swift` |
| Health, discovery, unary and streaming execution | `sdks/swift/Sources/BlokSwiftRuntime/RuntimeService.swift` |
| Deadline, cancellation, structured errors, and graceful shutdown | `RuntimeService.swift`, `Context.swift`, `BlokError.swift`, and `Sources/BlokSwiftRuntimeCLI/main.swift` |
| Capability policy and bounded claim-check | `CapabilityManifest.swift`, `ClaimCheck.swift`, and `tests/fixtures/capability-manifest/` |
| User-node scaffold and discovery | `packages/cli/src/commands/create/node.ts`, `runtime-setup.ts`, and `tests/e2e/cross-runtime/prepare-usernodes.ts` |
| Cross-runtime interoperability | `tests/e2e/cross-runtime/docker-compose.yml`, `spec-b-typed-e2e.ts`, and `docs/testing/real-e2e-matrix.md` |

The repository can validate TypeScript wiring, proto synchronization, and
compose/scaffold structure without Swift installed. Swift package compilation,
generated binding compilation, and live Swift gRPC execution require a Swift
6.1+ Linux toolchain (or a supported macOS development toolchain).

