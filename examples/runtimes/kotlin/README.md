# Kotlin runtime example

This example uses the first-class Kotlin coroutine SDK in `sdks/kotlin`.
Scaffold it with:

```bash
blokctl create project demo --runtimes kotlin
blokctl create node greet --runtime kotlin
```

The sidecar uses the canonical `blok.runtime.v1.NodeRuntime` gRPC ABI. Its
HTTP `/health` endpoint is informational/readiness-only; workflow execution is
always dispatched over gRPC. The Gradle wrapper pins the build to Gradle
8.10.2 and the SDK targets JVM 17 or newer.
