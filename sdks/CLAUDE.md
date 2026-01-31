# Multi-Language SDKs

All SDKs implement the same HTTP contract. The runner communicates with them via `HttpRuntimeAdapter`.

## HTTP Contract

**POST /execute**
```json
{
  "node": { "name": "step-name", "type": "runtime.go", "config": {} },
  "context": {
    "id": "uuid",
    "workflow_name": "name",
    "request": { "body": {}, "headers": {}, "params": {}, "query": {} },
    "response": { "data": {}, "success": true },
    "vars": {},
    "env": {}
  }
}
```

**Response (ExecutionResult)**
```json
{
  "success": true,
  "data": {},
  "errors": null,
  "logs": [],
  "metrics": { "duration_ms": 0, "cpu_ms": 0, "memory_bytes": 0 },
  "vars": {}
}
```

**GET /health** → `{ "status": "healthy" }`

## Default Ports

Go: 9001, Rust: 9002, Java: 9003, C#: 9004, PHP: 9005, Ruby: 9006, Python3: 9007

## SDK Node Pattern

Each SDK registers nodes with a `NodeHandler` interface (language-specific):
- **Go**: `NodeHandler` interface with `Execute(ctx, config) (interface{}, error)`
- **Rust**: `NodeHandler` trait with `async fn execute(&self, ctx, config) -> Result<Value>`
- **Python3**: Function-based handler
- **Java**: `NodeHandler` interface with `execute(Context ctx, Map config)`
- **C#**: `INodeHandler` interface
- **PHP**: `NodeHandler` interface
- **Ruby**: Handler module

User nodes live in `runtimes/{lang}/nodes/` within projects.

## Adding a New SDK Language

1. Implement HTTP server with `POST /execute` and `GET /health`
2. Parse `ExecutionRequest` from request body
3. Route to registered node handler by `node.name`
4. Return `ExecutionResult` JSON
5. Register `HttpRuntimeAdapter` in `Configuration.ts` with new kind/port
6. Add `RuntimeKind` value to `core/runner/src/adapters/RuntimeAdapter.ts`
7. Add `runtime.{lang}` to `NodeTypeSchema` in `core/workflow-helper/src/types/StepOpts.ts`
