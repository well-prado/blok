# ADR 0002 — Dart runtime sidecar

- Status: Accepted for issue #941's Dart runtime slice
- Governing issue: [#941](https://github.com/well-prado/blok/issues/941)
- Governing ADR path: `docs/architecture/runtime/adr/0002-dart-runtime.md`

## Context

Blok needs a typed Dart runtime that can execute backend Dart nodes without
depending on Flutter. The runner already owns workflow scheduling and exposes a
stable gRPC ABI for language sidecars. A Dart implementation must therefore be
a long-lived `blok.runtime.v1.NodeRuntime` server, not a second workflow
engine or a per-step process launcher.

## Decision

The Dart SDK uses the maintained grpc-dart/protobuf toolchain. Generated
bindings are produced from the canonical `proto/blok/runtime/v1/runtime.proto`
by `sdks/dart/tool/generate_proto.dart`; the Dart proto copy is synchronized by
`bun run proto:sync` and checked by `bun run proto:check`.

The sidecar provides `Execute`, `ExecuteStream`, `Health`, and `ListNodes`.
Node execution is typed at the SDK boundary through JSON Schema input/output
contracts, capability-manifest reflection, and structured `NodeError` values.
Deadlines and cancellation are cooperative: grpc-dart call state is projected
into `ExecutionContext`, and handlers must call `checkActive()` around
long-running work. The server also bounds the await by the effective call
deadline and shuts down its gRPC and readiness listeners on SIGINT/SIGTERM.

Claim-check `blob-v1` is advertised only when `BLOK_BLOB_DIR` is configured.
Blob identifiers are restricted to two safe path segments, resolved beneath
that directory, and bounded by `BLOK_GRPC_MAX_MESSAGE_BYTES` before decoding.

The CLI treats Dart as a compiled/package-managed sidecar: it copies
`sdks/dart`, runs `dart pub get`, generates a registration shim from
`runtimes/dart/nodes`, sets `BLOK_TRANSPORT=grpc` and `GRPC_PORT`, and waits on
the gRPC port. No hardcoded project port overrides the `.blok/config.json`
value.

## Consequences and limitations

- Linux with Dart 3.3+ is the production support target; Flutter is not a
  dependency. macOS and Windows are local development targets only until a
  platform-specific deployment lane is added.
- grpc-dart's server API does not expose the same transport-level max-message
  knobs as the TypeScript client, so the sidecar enforces the configured bound
  at the request/response payload boundary and advertises the same limit.
- Cancellation cannot preempt arbitrary synchronous Dart code. Node authors
  must use async APIs and call `ExecutionContext.checkActive()` at safe points.
- Isolates are not spawned per request. Any isolate-based node must explicitly
  bridge cancellation and remain within the host's concurrency policy.
