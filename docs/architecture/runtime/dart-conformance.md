# Dart runtime conformance

Governing ADR: [`docs/architecture/runtime/adr/0002-dart-runtime.md`](adr/0002-dart-runtime.md)

The Dart slice is considered conforming only when these checks are green:

| Contract | Evidence | Required invariant |
| --- | --- | --- |
| Canonical wire ABI | `sdks/dart/proto/blok/runtime/v1/runtime.proto`, `scripts/sync-proto.ts` | The Dart copy is an exact projection of the canonical proto; generated bindings are not hand-edited. |
| Typed execution | `sdks/dart/test/registry_test.dart` | Valid input executes and invalid input returns `VALIDATION` without publishing output. |
| Reflection and policy | `sdks/dart/test/registry_test.dart` | `ListNodes` metadata includes JSON schemas and capability-manifest v1 status. Missing metadata remains non-agent-safe. |
| Lifecycle/readiness | `sdks/dart/bin/serve.dart`, `sdks/dart/lib/src/server/grpc_server.dart` | Health/ListNodes serve over gRPC; the optional `/health` listener and SIGTERM shutdown are bounded and observable. |
| Deadline/cancellation | `sdks/dart/lib/src/types.dart`, `sdks/dart/lib/src/server/grpc_server.dart` | Effective grpc/options deadline is applied; canceled calls become structured `CANCELLED`/`TIMEOUT` errors. |
| Streaming | `DartRuntimeService.executeStream` | Started, log/partial, and terminal response frames are emitted in order. |
| Claim-check safety | `sdks/dart/test/registry_test.dart`, `ClaimCheck` | `blob-v1` is advertised only when configured; traversal and oversized reads fail closed. |
| CLI/scaffold | `packages/cli/src/services/runtime-detector.ts`, `runtime-setup.ts`, create-node tests | `runtime add dart` writes the configured port and a buildable Dart node layout. |
| Packaging | `sdks/dart/Dockerfile` | The Linux image is non-root, Flutter-free, exposes gRPC/readiness ports, and has a healthcheck. |

Run the language-local checks with:

```sh
bun run proto:check
cd sdks/dart
dart analyze
dart test
```

The strict cross-runtime gate must include `dart` in its required runtime set
when the Dart toolchain/image is available. A missing Dart toolchain is a
platform prerequisite failure, not evidence of conformance.
