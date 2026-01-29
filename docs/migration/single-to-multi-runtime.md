---
title: "Migration: Single Runtime to Multi-Runtime"
description: "Guide for migrating from single-runtime (Node.js only) to multi-runtime workflows"
---

# Migration: Single Runtime to Multi-Runtime

This guide walks you through enabling multi-runtime support in your Blok workflows. By the end, you will be able to run workflow steps in Node.js, Python, Bun, Docker containers, or WebAssembly -- all within a single workflow.

## Understanding Runtime Adapters

Blok's multi-runtime system is built on the **RuntimeAdapter** interface. Each language/environment provides an adapter that knows how to execute workflow nodes in that specific runtime.

```
                     Workflow
                       |
              +--------+--------+
              |        |        |
          Step 1    Step 2    Step 3
          nodejs    python3   docker(go)
              |        |        |
         In-process   gRPC     HTTP
              |        |        |
         NodeJS VM  Python    Docker
                    Process   Container
```

### Default Behavior (Single Runtime)

Without any `runtime` field, all steps run as `nodejs` in the same process:

```json
{
  "name": "my-workflow",
  "version": "1.0.0",
  "steps": [
    {
      "name": "validate",
      "node": "input-validator",
      "type": "module"
    },
    {
      "name": "process",
      "node": "data-processor",
      "type": "module"
    }
  ]
}
```

Both steps execute in-process via the `NodeJsRuntimeAdapter`. This is the fastest path and requires no additional infrastructure.

## Adding the Runtime Field to Workflow JSON

To use a different runtime for a step, add the `runtime` field:

```json
{
  "name": "polyglot-workflow",
  "version": "1.0.0",
  "steps": [
    {
      "name": "validate",
      "node": "input-validator",
      "type": "module"
    },
    {
      "name": "ml-predict",
      "node": "prediction-model",
      "type": "module",
      "runtime": "python3"
    },
    {
      "name": "format-response",
      "node": "response-formatter",
      "type": "module"
    }
  ]
}
```

In this example:
- `validate` and `format-response` run in Node.js (default)
- `ml-predict` runs in the Python 3 runtime via gRPC

### Available Runtime Values

| Runtime | Value | Communication | Requirements |
|---|---|---|---|
| Node.js | `nodejs` | In-process | None (default) |
| Bun | `bun` | In-process or subprocess | Bun installed (auto-detected) |
| Python 3 | `python3` | gRPC | Python gRPC server running |
| Docker | `docker` | HTTP | Docker daemon running |
| WebAssembly | `wasm` | In-process (WASM API) | `.wasm` module file |

## Configuring the Python 3 Runtime

### 1. Start the Python gRPC Server

The Python runtime communicates via gRPC. Start the Python runtime server before your Blok application:

```bash
# From the runtimes/python3 directory
pip install -r requirements.txt
python server.py --port 50051
```

Or with Docker:

```bash
docker run -d \
  --name blok-python3 \
  -p 50051:50051 \
  blok-python3-runtime:latest
```

### 2. Configure Environment Variables

```bash
# .env
RUNTIME_PYTHON3_HOST=localhost
RUNTIME_PYTHON3_PORT=50051
```

### 3. Write a Python Node

Python nodes receive serialized context via gRPC and return results:

```python
# nodes/prediction-model/handler.py
import json
from typing import Any

def execute(context: dict, inputs: dict) -> dict:
    """Execute the prediction model node."""
    features = inputs.get("features", [])

    # Your ML logic here
    prediction = model.predict(features)

    return {
        "success": True,
        "data": {
            "prediction": prediction.tolist(),
            "confidence": float(prediction.max()),
        },
        "errors": None,
    }
```

### 4. Reference in Workflow

```json
{
  "steps": [
    {
      "name": "predict",
      "node": "prediction-model",
      "type": "module",
      "runtime": "python3",
      "inputs": {
        "features": "{{ctx.request.body.features}}"
      }
    }
  ]
}
```

## Configuring Docker Adapters

Docker adapters let you run nodes written in any language by packaging them in containers.

### 1. Create a Runtime Container

Your container must expose an HTTP server on port `8080` with two endpoints:

**`POST /execute`** -- execute a node:

```json
// Request body
{
  "node": {
    "name": "my-node",
    "config": { ... }
  },
  "context": {
    "id": "request-uuid",
    "request": { ... },
    "response": { ... },
    "config": { ... }
  }
}

// Response body
{
  "success": true,
  "data": { ... },
  "errors": null,
  "metrics": {
    "duration_ms": 42.5,
    "memory_bytes": 1048576
  }
}
```

**`GET /health`** -- health check:

```json
{
  "status": "healthy"
}
```

### Example: Go Runtime Container

```dockerfile
# Dockerfile
FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY . .
RUN go build -o /runtime ./cmd/runtime

FROM alpine:3.19
COPY --from=builder /runtime /runtime
EXPOSE 8080
CMD ["/runtime"]
```

```go
// cmd/runtime/main.go
package main

import (
    "encoding/json"
    "net/http"
)

func main() {
    http.HandleFunc("/execute", handleExecute)
    http.HandleFunc("/health", handleHealth)
    http.ListenAndServe(":8080", nil)
}

func handleExecute(w http.ResponseWriter, r *http.Request) {
    var req ExecuteRequest
    json.NewDecoder(r.Body).Decode(&req)

    // Your Go logic here
    result := processNode(req.Node, req.Context)

    json.NewEncoder(w).Encode(ExecuteResponse{
        Success: true,
        Data:    result,
    })
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
    json.NewEncoder(w).Encode(map[string]string{"status": "healthy"})
}
```

### 2. Register the Docker Adapter

The Docker adapter is registered at startup with pool configuration:

```typescript
import { RuntimeRegistry } from "@nanoservice-ts/runner";
import { DockerRuntimeAdapter } from "@nanoservice-ts/runner/adapters/DockerRuntimeAdapter";

const registry = RuntimeRegistry.getInstance();

// Register a Go runtime via Docker
registry.register(
  new DockerRuntimeAdapter("go", "blok-go-runtime:latest", {
    minInstances: 1,       // Pre-warm 1 container
    maxInstances: 5,       // Scale up to 5
    maxIdleTime: 300_000,  // Recycle after 5 min idle
    maxUseCount: 100,      // Recycle after 100 executions
    healthCheckInterval: 30_000,
  })
);

// Register a Rust runtime via Docker
registry.register(
  new DockerRuntimeAdapter("rust", "blok-rust-runtime:latest", {
    minInstances: 0,       // Start on demand
    maxInstances: 3,
  })
);
```

### 3. Use in Workflow

```json
{
  "steps": [
    {
      "name": "heavy-compute",
      "node": "matrix-multiply",
      "type": "module",
      "runtime": "go"
    }
  ]
}
```

### Docker Pool Configuration

| Setting | Type | Default | Description |
|---|---|---|---|
| `minInstances` | number | `0` | Containers pre-warmed at startup |
| `maxInstances` | number | `5` | Maximum concurrent containers |
| `maxIdleTime` | number | `300000` | Recycle after N ms idle |
| `maxUseCount` | number | `100` | Recycle after N executions |
| `healthCheckInterval` | number | `30000` | Health check polling interval (ms) |

## Configuring the Bun Runtime

The Bun adapter auto-detects the host environment:

- **Running under Bun**: Executes in-process (same as NodeJS adapter)
- **Running under Node.js**: Spawns a `bun` subprocess

```json
{
  "steps": [
    {
      "name": "fast-transform",
      "node": "bun-transform",
      "type": "module",
      "runtime": "bun"
    }
  ]
}
```

Ensure Bun is installed:

```bash
curl -fsSL https://bun.sh/install | bash
```

## Configuring the WebAssembly Runtime

### 1. Compile Your Module to WASM

```bash
# Example: Rust to WASM
cargo build --target wasm32-unknown-unknown --release
cp target/wasm32-unknown-unknown/release/my_node.wasm ./nodes/my-node/
```

### 2. Reference in Workflow

```json
{
  "steps": [
    {
      "name": "sandbox-compute",
      "node": "wasm-processor",
      "type": "module",
      "runtime": "wasm"
    }
  ]
}
```

### WASM Module Contract

Your WASM module should export one of these interfaces (checked in order):

1. **`__blok_execute`** -- Blok-native interface with host function I/O
2. **`execute(ptr, len) -> ptr`** -- Standard pointer-based interface
3. **`_start`** -- WASI-compatible entry point

## Cross-Language Workflow Setup

Here is a complete example of a workflow that uses three different runtimes:

### Workflow JSON

```json
{
  "name": "ml-pipeline",
  "version": "1.0.0",
  "trigger": {
    "http": {
      "method": "POST",
      "path": "/api/predict"
    }
  },
  "steps": [
    {
      "name": "validate-input",
      "node": "input-validator",
      "type": "module",
      "inputs": {
        "body": "{{ctx.request.body}}"
      }
    },
    {
      "name": "preprocess",
      "node": "feature-extractor",
      "type": "module",
      "runtime": "python3",
      "inputs": {
        "rawData": "{{ctx.vars.validate-input.validated}}"
      }
    },
    {
      "name": "predict",
      "node": "ml-model",
      "type": "module",
      "runtime": "python3",
      "inputs": {
        "features": "{{ctx.vars.preprocess.features}}"
      }
    },
    {
      "name": "postprocess",
      "node": "response-formatter",
      "type": "module",
      "inputs": {
        "prediction": "{{ctx.vars.predict.result}}",
        "metadata": "{{ctx.vars.preprocess.metadata}}"
      }
    }
  ]
}
```

### Data Flow

```
HTTP Request
    |
    v
[validate-input]  (nodejs)    -- validates request body
    |
    v
[preprocess]      (python3)   -- feature extraction with NumPy/Pandas
    |
    v
[predict]         (python3)   -- ML inference with scikit-learn/PyTorch
    |
    v
[postprocess]     (nodejs)    -- format API response
    |
    v
HTTP Response
```

### Docker Compose for Development

```yaml
version: "3.8"

services:
  blok-api:
    build: .
    ports:
      - "3000:3000"
    environment:
      - RUNTIME_PYTHON3_HOST=python-runtime
      - RUNTIME_PYTHON3_PORT=50051
      - WORKFLOWS_PATH=./workflows/json
      - NODES_PATH=./nodes
    depends_on:
      python-runtime:
        condition: service_healthy

  python-runtime:
    build: ./runtimes/python3
    ports:
      - "50051:50051"
    healthcheck:
      test: ["CMD", "python", "-c", "import grpc; print('ok')"]
      interval: 10s
      timeout: 5s
      retries: 3
```

## Testing Multi-Runtime Workflows

### Unit Testing Individual Nodes

Each runtime has its own test tooling:

```typescript
// Node.js node test
import { defineNode } from "@nanoservice-ts/runner";
import { createTestContext } from "@nanoservice-ts/runner/testing";

const node = defineNode({ /* ... */ });
const ctx = createTestContext({
  request: { body: { userId: "123" } },
});

const result = await node.handle(ctx, { userId: "123" });
expect(result.success).toBe(true);
```

```python
# Python node test
from handler import execute

result = execute(
    context={"id": "test-123"},
    inputs={"features": [1.0, 2.0, 3.0]}
)

assert result["success"] is True
assert "prediction" in result["data"]
```

### Integration Testing

Test the full workflow with all runtimes running:

```typescript
import { Configuration, Runner } from "@nanoservice-ts/runner";

describe("ML Pipeline", () => {
  it("should execute across runtimes", async () => {
    // Requires Python runtime to be running
    const config = new Configuration();
    await config.load("./workflows/json/ml-pipeline.json");

    const runner = new Runner(config.steps);
    const ctx = createTestContext({
      request: {
        body: { rawData: [1.0, 2.0, 3.0] },
      },
    });

    const result = await runner.execute(ctx);

    expect(result.response.success).toBe(true);
    expect(result.response.data.prediction).toBeDefined();
  });
});
```

### Mocking Runtime Adapters

For CI environments where external runtimes are unavailable:

```typescript
import { RuntimeRegistry } from "@nanoservice-ts/runner";
import type { RuntimeAdapter, ExecutionResult } from "@nanoservice-ts/runner/adapters/RuntimeAdapter";

class MockPythonAdapter implements RuntimeAdapter {
  readonly kind = "python3" as const;

  async execute(node, ctx): Promise<ExecutionResult> {
    return {
      success: true,
      data: { prediction: [0.95], confidence: 0.95 },
      errors: null,
    };
  }
}

// In test setup
const registry = RuntimeRegistry.getInstance();
registry.replace(new MockPythonAdapter());
```

## Performance Considerations

### Latency by Runtime

| Runtime | First Call | Subsequent Calls | Communication |
|---|---|---|---|
| `nodejs` | <1ms | <1ms | In-process |
| `bun` (Bun host) | <1ms | <1ms | In-process |
| `bun` (Node host) | 50-200ms | 50-200ms | Subprocess |
| `python3` | 1-5ms | 1-5ms | gRPC (protobuf) |
| `docker` | 2-30s | 5-50ms | HTTP (JSON) |
| `wasm` | 10-100ms | <1ms | In-process (WASM API) |

### Optimization Strategies

1. **Pool Docker containers**: Set `minInstances > 0` for frequently-used Docker runtimes to avoid cold starts.

2. **Keep Python gRPC server warm**: Run the Python server as a long-lived process rather than starting it per request.

3. **Cache WASM modules**: The WASM adapter caches compiled modules automatically. Set `maxCacheSize` based on your number of unique WASM nodes.

4. **Minimize cross-runtime data transfer**: Place steps that exchange large payloads in the same runtime when possible.

5. **Use Node.js for I/O-heavy work**: Node.js is best for HTTP calls, database queries, and I/O. Use Python/Go/Rust for compute-heavy work.

6. **Batch Python operations**: If you have multiple Python steps that share data (e.g., ML preprocessing + inference), consider combining them into a single Python node to avoid serialization overhead.

### Memory Considerations

| Runtime | Memory Model | Overhead |
|---|---|---|
| `nodejs` | Shared with host | ~0 MB |
| `bun` | Shared (Bun host) or separate (Node host) | 0-50 MB |
| `python3` | Separate process | 30-100 MB |
| `docker` | Isolated container | 50-500 MB |
| `wasm` | Sandboxed linear memory | 0.6-6.4 MB |

### Monitoring Multi-Runtime Performance

Use the built-in metrics to track per-runtime performance:

```typescript
// Node execution metrics include runtime information
// node_time{runtime="python3", node_name="ml-model"} 45.2
// node_time{runtime="nodejs", node_name="validator"} 0.8
```

Grafana queries for runtime comparison:

```promql
# Average execution time by runtime
avg(node_time) by (runtime)

# Error rate by runtime
rate(node_errors[5m]) / rate(node[5m]) by (runtime)

# Memory usage by runtime
max(node_memory) by (runtime)
```

## See Also

- [Runtime Adapter System](/docs/architecture/runtime-adapters) -- detailed architecture of the adapter system
- [Migration: Class to Function](/docs/migration/class-to-function) -- migrating nodes to the function-first API
- [Observability](/docs/architecture/observability) -- monitoring multi-runtime workflows
- [Trigger System](/docs/architecture/trigger-system) -- how triggers invoke workflows
