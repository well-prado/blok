# ADR 0002 — First-class Kotlin/JVM runtime sidecar

- **Status:** Accepted — SDK and sidecar implementation
- **Date:** 2026-09-05
- **Issue:** #940

## Context

Blok already has a Java SDK and a shared `NodeRuntime` gRPC ABI. Kotlin users
need an idiomatic coroutine-first authoring surface without inheriting Java
base classes or moving workflow scheduling into the sidecar. The sidecar must
remain a long-lived process: the runner owns workflow state, tracing, policy,
and admission while Kotlin owns node dispatch and the JVM lifecycle.

## Decisions

`runtime.kotlin` is a distinct canonical runtime kind on gRPC port `10008`
(readiness HTTP port `9008`). The Kotlin SDK is built under `sdks/kotlin` with
a pinned Gradle wrapper and Kotlin DSL. Its generated protobuf and
grpc-kotlin sources are derived from the canonical
[`proto/blok/runtime/v1/runtime.proto`](../../../../proto/blok/runtime/v1/runtime.proto)
copy maintained by `scripts/sync-proto.ts`.

Nodes implement `NodeHandler` or the coroutine-first `TypedNode<I, O>` API.
Typed nodes use kotlinx.serialization data classes, validate before execution,
reflect conservative JSON Schema, and expose description, tags, and the shared
Capability Manifest v1 metadata through `ListNodes`. The SDK never duplicates
the workflow engine and never treats a capability declaration as authority;
runner/deployment policy remains the enforcement boundary.

The service maps request deadlines to coroutine timeouts and relies on
grpc-kotlin's call coroutine context for client cancellation. Node work runs on
a bounded dispatcher configured by `BLOK_RUNTIME_DISPATCHER_THREADS`; it never
uses `GlobalScope` or an unbounded executor. `ExecuteStream` emits the required
started and terminal frames, while unary execution carries the structured
result/error envelope.

The sidecar exposes custom gRPC `Health` and `ListNodes` plus a readiness-only
`GET /health`. Message size, keepalive, and JVM worker settings are explicit
environment configuration. Graceful shutdown stops the HTTP probe, drains the
gRPC server, and closes the bounded dispatcher.

`blob-v1` is advertised only when `BLOK_BLOB_DIR` exists and is readable.
Claim-check IDs are restricted to two safe path segments, normalized against
the configured root, and bounded by `BLOK_BLOB_MAX_BYTES`. A missing capability
or invalid reference fails closed; the runner then keeps the normal inline
payload path.

## Governing contracts

- Runtime wire ABI: [`proto/blok/runtime/v1/runtime.proto`](../../../../proto/blok/runtime/v1/runtime.proto)
- Capability policy: [`docs/d/fundamentals/capability-manifests.mdx`](../../../d/fundamentals/capability-manifests.mdx) and ADR 0003
- Runtime adapter lifecycle: [`docs/architecture/runtime-adapters.md`](../../runtime-adapters.md)
- Claim-check boundary: [`docs/d/reliability/large-payloads.mdx`](../../../d/reliability/large-payloads.mdx) and ADR 0014
- JVM runtime limitations: [`sdks/kotlin/README.md`](../../../../sdks/kotlin/README.md)

## Conformance evidence

- `sdks/kotlin/src/test/kotlin/com/blok/kotlin/BlokTest.kt` covers typed
  validation, schema reflection, duplicate registration, chain behavior, and
  path-bounded claim-check IDs.
- `tests/e2e/cross-runtime/spec-b-typed-e2e.ts` includes Kotlin in the strict
  valid/invalid typed, capability, standard chain, and user-node lanes.
- `packages/cli/tests/services/kotlin-node-registry.test.ts` covers scaffold
  code generation and stale-node cleanup.
- `packages/cli/tests/commands/runtime/runtime.test.ts` covers Kotlin runtime
  detection/configuration, port `10008`, and `runtime add kotlin` vocabulary.
- `bun run proto:check` proves the Kotlin proto copy remains synchronized.

The implementation does not claim Android lifecycle integration, Kotlin/JS,
Kotlin/Native, Kotlin Multiplatform, or native gRPC transports on platforms
where the pinned JDK/netty dependencies are unavailable. Throughput and p95/
p99 numbers are deployment-specific; the smoke lane proves correctness and
lifecycle behavior, not a universal performance guarantee.
