# Blok Swift SDK

The Swift SDK is a Linux-capable Swift Package Manager sidecar for Blok's
`runtime.swift` nodes. It uses Swift 6.1 structured concurrency, gRPC Swift 2,
SwiftProtobuf, and the SwiftNIO HTTP/2 transport. Xcode is not required for
server builds.

## Build and run

```sh
swift package resolve
swift build -c release
GRPC_PORT=10008 swift run -c release blok-swift-runtime
```

The sidecar exposes the canonical `blok.runtime.v1.NodeRuntime` service over
gRPC. `Health`, `ListNodes`, unary `Execute`, and server-streaming
`ExecuteStream` share the same proto as every other Blok SDK. The default gRPC
port is `10008`; `GRPC_PORT`, `HOST`, `BLOK_GRPC_MAX_MESSAGE_BYTES`,
`BLOK_GRPC_KEEPALIVE_TIME_MS`, and `BLOK_GRPC_KEEPALIVE_TIMEOUT_MS` are
environment-configurable. `GET /health` is served on `HEALTH_PORT` (default
`9008`) for container/orchestrator readiness.

## Authoring nodes

Typed nodes implement `TypedNode` and provide Codable input/output types plus
the JSON Schemas and capability manifest they want reflected in `ListNodes`.
Compiled project nodes are copied into the Swift target by `blokctl dev`; each
node directory must expose a uniquely named namespace with
`static func register(_:)`.

```swift
public enum RiskScoreNode {
  public static func register(_ registry: NodeRegistry) {
    registry.register("risk-score", RiskScore())
  }
}
```

Capability manifests contain only opaque secret reference names. If
`BLOK_ALLOWED_CAPABILITIES` is set, the runtime denies a node whose declared
capabilities are outside that allow-list. `BLOK_REQUIRE_CAPABILITY_MANIFEST`
can be enabled for fail-closed agent deployments.

## Platform boundary

Linux is the production sidecar target and is covered by the Docker/CI path.
The package is source-compatible with macOS for local development, but this
repository does not claim Apple-platform CI coverage or Xcode application
integration. Swift SDK generation and server tests should run on a supported
Swift/Linux toolchain.
