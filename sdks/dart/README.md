# Blok Dart SDK

The Dart SDK is a standalone, Dart-native gRPC sidecar. It does not depend on
Flutter and is intended to run on Linux in production. The public API is
typed at the node boundary while the wire contract remains the canonical
`blok.runtime.v1.NodeRuntime` service.

## Quick start

```sh
dart pub get
dart run tool/generate_proto.dart
BLOK_TRANSPORT=grpc dart run bin/serve.dart
```

The default gRPC port is `10008` (the legacy HTTP slot is `9008`). `GET
/health` is served on `PORT` for container readiness probes; the runner uses
the gRPC Health RPC and a TCP probe for readiness.

## Authoring a typed node

```dart
final greet = defineNode<Map<String, Object?>, Map<String, Object?>>(
  name: 'typed-greet',
  description: 'Greets a person.',
  inputSchema: {
    'type': 'object',
    'required': ['name'],
    'properties': {'name': {'type': 'string'}},
  },
  outputSchema: {
    'type': 'object',
    'required': ['greeting'],
    'properties': {'greeting': {'type': 'string'}},
  },
  capabilityManifest: CapabilityManifest.agentCompatible(
    effects: const ['read'],
    requiredCapabilities: const [],
  ),
  execute: (ctx, input) async => {
    return {'greeting': 'Hello, ${input['name']}!'};
  },
);
```

User nodes are loaded from `BLOK_NODES_DIR`. Each immediate subdirectory must
contain a `node.dart` exporting `NodeDefinition registerNode()`. This keeps
discovery deterministic and makes scaffolded nodes work without code
generation. The registry validates input/output JSON Schema, enforces the
capability policy boundary, and converts failures to the canonical `NodeError`
message.

## Platform limitations

- The supported production target is Dart 3.3+ on Linux. Flutter is neither
  required nor loaded.
- Windows and macOS are useful for local SDK tests, but the sidecar release
  images and strict conformance lane target Linux.
- Dart isolates are not used for unbounded per-request spawning. The sidecar
  uses the gRPC server's bounded worker pool; an isolate-based node must own
  its cancellation bridge explicitly.
- Native FFI, filesystem, subprocess, and network authority are not implied by
  the SDK. Declare capabilities in the manifest and enforce policy in the host
  deployment.

## Contract and generated code

`proto/blok/runtime/v1/runtime.proto` is copied from the repository canonical
proto by `bun run proto:sync`. Do not hand-edit generated Dart bindings.

```sh
dart run tool/generate_proto.dart
dart analyze
dart test
```
