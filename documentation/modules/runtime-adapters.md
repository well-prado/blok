# Module Reference: Runtime Adapters

> **Path:** `core/runner/src/adapters/`
> **Registry:** `core/runner/src/RuntimeRegistry.ts`
> **Purpose:** Execute nodes in any programming language through pluggable adapters

## What It Does

The runtime adapter system is what makes Blok truly language-agnostic. Instead of being limited to Node.js, any node can specify which runtime it should execute in (Python, Go, Java, Rust, etc.). The adapter system handles the communication protocol (in-process, gRPC, HTTP, Docker).

## Architecture

```
Workflow Step → RuntimeRegistry.get(kind) → RuntimeAdapter.execute(node, ctx) → Result
```

### RuntimeAdapter Interface
```typescript
interface RuntimeAdapter {
  kind: RuntimeKind;
  execute(node: RunnerNode, ctx: Context): Promise<ExecutionResult>;
}

type RuntimeKind =
  | "nodejs" | "bun" | "python3"
  | "go" | "java" | "rust"
  | "php" | "csharp"
  | "docker" | "wasm";

type ExecutionResult = {
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
```

### RuntimeRegistry
```typescript
class RuntimeRegistry {
  register(adapter: RuntimeAdapter): void;
  get(kind: RuntimeKind): RuntimeAdapter;
  has(kind: RuntimeKind): boolean;
  list(): RuntimeKind[];
  unregister(kind: RuntimeKind): void;
}
```

## Adapter Implementations

### 1. NodeJsRuntimeAdapter
- **File:** `adapters/NodeJsRuntimeAdapter.ts`
- **Kind:** `nodejs`
- **Protocol:** In-process (direct function call)
- **How it works:** Resolves the node module locally, calls `node.handle(ctx, inputs)` directly
- **Performance:** Zero overhead (no serialization, no network)
- **Use case:** Default for all TypeScript/JavaScript nodes

### 2. BunRuntimeAdapter
- **File:** `adapters/BunRuntimeAdapter.ts`
- **Kind:** `bun`
- **Protocol:** In-process (Bun runtime)
- **How it works:** Uses Bun's native module resolution and execution
- **Performance:** Near-zero overhead
- **Use case:** When using Bun as the JavaScript runtime

### 3. Python3RuntimeAdapter
- **File:** `adapters/Python3RuntimeAdapter.ts`
- **Kind:** `python3`
- **Protocol:** gRPC
- **How it works:** Sends execution request to Python gRPC server at `RUNTIME_PYTHON3_HOST:RUNTIME_PYTHON3_PORT`
- **Serialization:** Protobuf (node.proto)
- **Performance:** ~5-10ms overhead per call (gRPC)
- **Use case:** Python-based nodes (ML, data processing, etc.)
- **Requires:** Python runtime server running (see `runtimes/python3/`)

### 4. DockerRuntimeAdapter
- **File:** `adapters/DockerRuntimeAdapter.ts`
- **Kind:** `docker`
- **Protocol:** HTTP or gRPC (configurable)
- **How it works:** Manages Docker containers for runtime execution. Supports container pooling, health checks, and automatic lifecycle management.
- **Features:**
  - Container pool management (pre-warmed containers)
  - Health check monitoring
  - Automatic container restart
  - Resource limits (CPU, memory)
  - Volume mounting for node code
- **Performance:** ~50-100ms first call (cold start), ~10-20ms subsequent (warm pool)
- **Use case:** Go, Java, Rust, PHP, Ruby, or any containerized runtime

### 5. WasmRuntimeAdapter
- **File:** `adapters/WasmRuntimeAdapter.ts`
- **Kind:** `wasm`
- **Protocol:** In-process (WASM runtime)
- **How it works:** Loads and executes WebAssembly modules
- **Performance:** Near-native speed, sandboxed execution
- **Use case:** High-performance, sandboxed node execution

## Protocol: gRPC Node Service

The canonical protocol for cross-language communication is defined in `runtimes/proto/node.proto`:

```protobuf
service NodeService {
  rpc Execute(NodeRequest) returns (NodeResponse);
  rpc Validate(NodeRequest) returns (ValidationResponse);
  rpc Health(HealthRequest) returns (HealthResponse);
}

message NodeRequest {
  string node_name = 1;
  string node_path = 2;
  Context context = 3;
  map<string, bytes> config = 4;
}

message NodeResponse {
  bool success = 1;
  bytes data = 2;
  repeated Error errors = 3;
  Metrics metrics = 4;
}
```

## Specifying Runtime in Workflows

```json
{
  "steps": [
    {
      "name": "process-data",
      "node": "data-processor",
      "runtime": "python3",
      "inputs": { "data": "ctx.request.body" }
    },
    {
      "name": "analyze",
      "node": "ml-model",
      "runtime": "docker",
      "runtimeConfig": {
        "image": "blok/ml-runtime:latest",
        "memory": "2g"
      },
      "inputs": { "processed": "ctx.vars.process-data" }
    }
  ]
}
```

## Tests

- `adapters/__tests__/NodeJsRuntimeAdapter.test.ts` (336 lines)
- `adapters/__tests__/BunRuntimeAdapter.test.ts` (328 lines)
- `adapters/__tests__/Python3RuntimeAdapter.test.ts` (595 lines)
- `adapters/__tests__/DockerRuntimeAdapter.test.ts` (666 lines)
- `adapters/__tests__/WasmRuntimeAdapter.test.ts` (284 lines)
- `__tests__/RuntimeRegistry.test.ts` (306 lines)

## What to Document

1. **Architecture overview** — How adapters plug into the runner
2. **Each adapter** — Configuration, performance, limitations
3. **gRPC protocol** — Full protobuf reference
4. **Workflow runtime configuration** — How to specify runtime per step
5. **Building custom adapters** — Step-by-step guide
6. **Docker adapter deep dive** — Container pooling, health checks, scaling
7. **Performance comparison** — Overhead per adapter type
8. **Environment variables** — All runtime-related env vars
