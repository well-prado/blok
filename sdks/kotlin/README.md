# Blok Kotlin SDK

The Kotlin SDK is a coroutine-first, gRPC sidecar for `runtime.kotlin`. It
uses the canonical `proto/blok/runtime/v1/runtime.proto` and generated
grpc-kotlin bindings; it does not subclass or depend on the Java SDK.

## Build and run

The checked-in Gradle wrapper pins the build tool, so a system Gradle install
is not required:

```bash
./gradlew test
./gradlew installDist
GRPC_PORT=10008 BLOK_TRANSPORT=grpc ./gradlew run
```

The sidecar serves `NodeRuntime/Execute`, `ExecuteStream`, `Health`, and
`ListNodes` over gRPC on `GRPC_PORT` (default `10008`) and a readiness-only
`GET /health` endpoint on `PORT` (default `9008`). `HOST`, `VERSION`,
`BLOK_GRPC_MAX_MESSAGE_BYTES`, `BLOK_GRPC_KEEPALIVE_TIME_MS`,
`BLOK_GRPC_KEEPALIVE_TIMEOUT_MS`, and `BLOK_RUNTIME_DISPATCHER_THREADS` are
configurable through the environment.

## Authoring nodes

Use `TypedNode<I, O>` with `@Serializable` data classes and a suspend `run`:

```kotlin
@Serializable data class Input(val name: String)
@Serializable data class Output(val greeting: String)

class GreetNode : TypedNode<Input, Output>(
    name = "greet",
    description = "Greets a user",
    inputSerializer = Input.serializer(),
    outputSerializer = Output.serializer(),
) {
    override suspend fun run(ctx: NodeContext, input: Input) =
        Output("Hello, ${input.name}!")
}
```

`TypedNode` validates inputs before calling `run`, reflects conservative JSON
Schemas in `ListNodes`, and emits structured validation errors. Nodes can use
`ctx.logger`, `ctx.request`, `ctx.env`, `ctx.getVar`/`setVar`, and
`ctx.ensureActive()`. The service runs node work on a bounded dispatcher and
maps per-call deadlines to coroutine timeouts; gRPC cancellation cancels the
child coroutine. `GlobalScope` and unbounded executors are intentionally not
used.

`blokctl create node <name> --runtime kotlin` generates a project node and
`blokctl dev` compiles it into the generated `UserNodeRegistry.kt` shim.

## Capability and claim-check boundary

Nodes may declare `CapabilityManifest`, whose fields mirror Capability
Manifest v1. Secret values never belong in the manifest. When `BLOK_BLOB_DIR`
points to an existing readable shared directory, `ListNodes` advertises
`blob-v1`; only then does the runner send `$blokBlob` inputs. IDs are restricted
to two safe path segments and reads are bounded by `BLOK_BLOB_MAX_BYTES`
(default 256 MiB).

## Platform limits

This SDK targets JVM 17+ and the Kotlin/JVM server runtime. It is not an
Android runtime: Android application lifecycle, SDK/NDK APIs, and Android
network policy are outside the sidecar contract. Kotlin/Native and Kotlin/JS
are not claimed. The Docker image is Linux/JVM; other platforms are supported
only where a compatible JDK, Gradle wrapper, and grpc-netty native transport
are available. Cross-platform production support requires the same gRPC and
filesystem/claim-check assumptions documented above.
