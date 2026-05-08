---
title: "Runtime Adapter System"
description: "Deep-dive architecture documentation for the Blok multi-runtime adapter system"
---

# Runtime Adapter System

The runtime adapter system is the foundation of Blok's multi-language workflow execution. It provides a uniform interface for running workflow nodes across different programming languages and execution environments, including Node.js, Python, Bun, Docker containers, and WebAssembly modules.

## Overview of the Adapter Pattern

Blok uses the **Strategy pattern** to abstract runtime execution behind a common interface. Each language runtime provides its own adapter that implements the `RuntimeAdapter` interface, while the `RuntimeRegistry` serves as a central lookup for all registered adapters.

This architecture enables:

- **Polyglot workflows** -- a single workflow can invoke nodes written in TypeScript, Python, Go, or any supported language.
- **Zero-change extensibility** -- add a new language by implementing one interface and registering it.
- **Consistent error handling** -- all adapters produce the same `ExecutionResult` structure.
- **Built-in metrics** -- every adapter records `duration_ms`, `cpu_ms`, and `memory_bytes`.

## RuntimeAdapter Interface

The core abstraction is a two-method interface defined in `core/runner/src/adapters/RuntimeAdapter.ts`:

```typescript
export type RuntimeKind =
  | "nodejs"
  | "bun"
  | "python3"
  | "go"
  | "java"
  | "rust"
  | "php"
  | "csharp"
  | "ruby"
  | "docker"
  | "wasm";

export type ExecutionResult = {
  success: boolean;
  data: unknown;
  errors: unknown | null;
  logs?: string[];
  metrics?: {
    duration_ms?: number;
    cpu_ms?: number;
    memory_bytes?: number;
  };
};

export interface RuntimeAdapter {
  readonly kind: RuntimeKind;
  execute(node: RunnerNode, ctx: Context): Promise<ExecutionResult>;
}
```

Every adapter declares its `kind` (the language identifier used in workflow JSON) and implements `execute()` to run a node within that runtime.

## RuntimeRegistry

The `RuntimeRegistry` is a **singleton** that maintains the map of `RuntimeKind` to `RuntimeAdapter`:

```typescript
const registry = RuntimeRegistry.getInstance();

// Register adapters at startup
registry.register(new NodeJsRuntimeAdapter());
registry.register(new Python3RuntimeAdapter());
registry.register(new BunRuntimeAdapter());
registry.register(new WasmRuntimeAdapter());
registry.register(new DockerRuntimeAdapter("go", "blok-go-runtime:latest"));

// Resolve at execution time
const adapter = registry.get("python3");
const result = await adapter.execute(node, ctx);
```

Key methods:

| Method | Description |
|---|---|
| `register(adapter)` | Registers an adapter. Throws if the kind is already registered. |
| `get(kind)` | Returns the adapter for a given kind. Throws if not found. |
| `has(kind)` | Checks whether an adapter is registered. |
| `getRegisteredKinds()` | Lists all registered runtime kinds. |
| `replace(adapter)` | Replaces an existing adapter (useful for testing or hot-reload). |
| `clear()` | Removes all adapters (testing only). |

The registry is initialized automatically by `Configuration` during workflow loading.

## Built-in Adapters

### NodeJsRuntimeAdapter

**Kind:** `nodejs`
**Communication:** In-process (zero overhead)
**Source:** `core/runner/src/adapters/NodeJsRuntimeAdapter.ts`

The default adapter for TypeScript and JavaScript nodes. Executes nodes directly in the same Node.js process by calling `node.run(ctx)`. This is the fastest path since there is no serialization or IPC overhead.

```typescript
const adapter = new NodeJsRuntimeAdapter();
// Calls node.run(ctx) directly
const result = await adapter.execute(node, ctx);
```

**Performance characteristics:**
- Latency: sub-millisecond overhead
- Memory: shared with host process
- Serialization: none

### Python3RuntimeAdapter

**Kind:** `python3`
**Communication:** gRPC (protobuf over HTTP/2)
**Source:** `core/runner/src/adapters/Python3RuntimeAdapter.ts`

Executes Python nodes via a gRPC server. The adapter serializes the workflow context to base64-encoded JSON, sends it over gRPC, and deserializes the response.

```typescript
const adapter = new Python3RuntimeAdapter(
  "localhost",  // host (default: RUNTIME_PYTHON3_HOST env var)
  50051         // port (default: RUNTIME_PYTHON3_PORT env var)
);
```

**Environment variables:**

| Variable | Default | Description |
|---|---|---|
| `RUNTIME_PYTHON3_HOST` | `localhost` | Python gRPC server host |
| `RUNTIME_PYTHON3_PORT` | `50051` | Python gRPC server port |

**Performance characteristics:**
- Latency: 1-5ms per call (gRPC overhead)
- Memory: separate process
- Serialization: JSON to base64 to protobuf

### BunRuntimeAdapter

**Kind:** `bun`
**Communication:** In-process (under Bun) or subprocess (under Node.js)
**Source:** `core/runner/src/adapters/BunRuntimeAdapter.ts`

Provides dual execution modes:

1. **In-process** -- When the host process is Bun, nodes run with zero overhead (identical to `NodeJsRuntimeAdapter`).
2. **Subprocess** -- When the host is Node.js, spawns `bun eval` to execute the node in a separate Bun process.

```typescript
const adapter = new BunRuntimeAdapter();
// Automatically detects runtime via `globalThis.Bun`
const result = await adapter.execute(node, ctx);
```

**Performance characteristics:**
- In-process (Bun host): sub-millisecond overhead
- Subprocess (Node.js host): 50-200ms (process spawn + serialize)

### DockerRuntimeAdapter

**Kind:** configurable (defaults to `docker`)
**Communication:** HTTP REST (JSON over TCP)
**Source:** `core/runner/src/adapters/DockerRuntimeAdapter.ts`

Executes nodes inside Docker containers. This adapter supports **any** language by packaging the runtime in a container image. It includes container pooling, health checks, and automatic recycling.

```typescript
const adapter = new DockerRuntimeAdapter(
  "go",                          // RuntimeKind
  "blok-go-runtime:latest",     // Docker image
  {
    minInstances: 1,             // Pre-warm containers
    maxInstances: 5,             // Pool ceiling
    maxIdleTime: 5 * 60 * 1000, // Recycle idle containers after 5 min
    maxUseCount: 100,            // Recycle after 100 executions
    healthCheckInterval: 30_000, // Check health every 30s
  }
);
```

**Container contract:**

Containers must expose an HTTP server on port `8080` with:
- `POST /execute` -- accepts JSON `{ node, context }`, returns `ExecutionResult`
- `GET /health` -- returns `{ "status": "healthy" }`

**Pool management:**

| Setting | Default | Description |
|---|---|---|
| `minInstances` | `0` | Containers pre-warmed at startup |
| `maxInstances` | `5` | Maximum concurrent containers |
| `maxIdleTime` | `300000` | Recycle after 5 min idle (ms) |
| `maxUseCount` | `100` | Recycle after N executions |
| `healthCheckInterval` | `30000` | Health check polling interval (ms) |

**Performance characteristics:**
- First call: 2-30s (container start + health check)
- Subsequent calls: 5-50ms (HTTP overhead)
- Memory: isolated per container

### WasmRuntimeAdapter

**Kind:** `wasm`
**Communication:** WebAssembly in-process
**Source:** `core/runner/src/adapters/WasmRuntimeAdapter.ts`

Executes WebAssembly modules directly using the built-in `WebAssembly` API. Supports three execution strategies:

1. **`__blok_execute`** -- Blok-native WASM interface using host functions for I/O.
2. **`execute(ptr, len)`** -- Standard function that takes/returns memory pointers.
3. **`_start`** -- WASI-compatible entry point.

```typescript
const adapter = new WasmRuntimeAdapter({
  maxCacheSize: 50,  // Cache up to 50 compiled modules
});
```

The adapter caches compiled `WebAssembly.Module` instances to avoid recompilation. WASI stubs are provided for compatibility with modules that use WASI preview 1.

**Performance characteristics:**
- First call: 10-100ms (compile + instantiate)
- Subsequent calls: sub-millisecond (cached module)
- Memory: sandboxed WASM linear memory (640KB - 6.4MB default)

## How to Create a Custom Adapter

To add support for a new language runtime, implement the `RuntimeAdapter` interface and register it:

```typescript
import type { Context } from "@blokjs/shared";
import type RunnerNode from "@blokjs/runner/RunnerNode";
import type {
  RuntimeAdapter,
  ExecutionResult,
} from "@blokjs/runner/adapters/RuntimeAdapter";

export class RubyRuntimeAdapter implements RuntimeAdapter {
  public readonly kind = "ruby" as const;

  async execute(node: RunnerNode, ctx: Context): Promise<ExecutionResult> {
    const startTime = performance.now();

    try {
      // Your execution logic here:
      // - Call a Ruby process
      // - Send via gRPC, HTTP, or IPC
      // - Parse the response
      const response = await this.callRubyRuntime(node, ctx);

      return {
        success: true,
        data: response,
        errors: null,
        metrics: {
          duration_ms: performance.now() - startTime,
        },
      };
    } catch (error: unknown) {
      return {
        success: false,
        data: null,
        errors: {
          message: (error as Error).message,
          stack: (error as Error).stack,
        },
        metrics: {
          duration_ms: performance.now() - startTime,
        },
      };
    }
  }

  private async callRubyRuntime(
    node: RunnerNode,
    ctx: Context
  ): Promise<unknown> {
    // Implementation: gRPC, HTTP, subprocess, etc.
  }
}
```

Register the adapter at startup:

```typescript
import { RuntimeRegistry } from "@blokjs/runner";
import { RubyRuntimeAdapter } from "./RubyRuntimeAdapter";

const registry = RuntimeRegistry.getInstance();
registry.register(new RubyRuntimeAdapter());
```

Reference the runtime in your workflow JSON:

```json
{
  "name": "ruby-workflow",
  "version": "1.0.0",
  "steps": [
    {
      "name": "process-data",
      "node": "ruby-processor",
      "type": "module",
      "runtime": "ruby",
      "inputs": {
        "data": "{{ctx.request.body}}"
      }
    }
  ]
}
```

## Execution Flow

```
                    Workflow Execution
                          |
                    Configuration
                    loads workflow
                          |
                    For each step:
                          |
               +----------+-----------+
               |                      |
          Has runtime?           No runtime
               |                  (default)
               |                      |
       RuntimeRegistry           NodeJS adapter
       .get(kind)                (in-process)
               |                      |
        +------+------+              |
        |      |      |              |
      Python  Docker  WASM           |
      (gRPC)  (HTTP)  (WASM API)     |
        |      |      |              |
        +------+------+--------------+
                    |
              ExecutionResult
              {success, data, errors, metrics}
                    |
              RuntimeAdapterNode
              converts to ResponseContext
                    |
              Runner continues
              to next step
```

## RuntimeAdapterNode Bridge

The `RuntimeAdapterNode` class bridges the adapter system with the existing `RunnerNode` execution model. When a workflow step specifies a `runtime` field, the `Configuration` class wraps the target node in a `RuntimeAdapterNode`:

```typescript
// Internal: Configuration wraps nodes with non-default runtimes
const adapterNode = new RuntimeAdapterNode(adapter, targetNode);
// adapterNode.run(ctx) delegates to adapter.execute(targetNode, ctx)
```

This bridge ensures backward compatibility -- existing Node.js nodes continue to work without any changes.

## Configuration Options

Runtime adapters are configured via environment variables and the workflow JSON `runtime` field.

### Environment Variables

| Variable | Adapter | Description |
|---|---|---|
| `RUNTIME_PYTHON3_HOST` | Python3 | gRPC server hostname |
| `RUNTIME_PYTHON3_PORT` | Python3 | gRPC server port |
| `BLOK_WASM_CACHE_SIZE` | WASM | Max compiled module cache entries |

### Workflow JSON

```json
{
  "steps": [
    {
      "name": "my-step",
      "node": "my-node",
      "type": "module",
      "runtime": "python3"
    }
  ]
}
```

When the `runtime` field is omitted, the step defaults to `nodejs` (in-process execution).

## See Also

- [Trigger System](/docs/architecture/trigger-system) -- how triggers invoke workflows
- [Migration: Single to Multi-Runtime](/docs/migration/single-to-multi-runtime) -- guide for adopting multi-runtime
- [Security Model](/docs/architecture/security-model) -- authentication and authorization across runtimes
