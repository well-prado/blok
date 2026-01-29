# Plan: Migrate Python Runtime to HTTP SDK Pattern

## Objective

Replace the gRPC-based `runtimes/python3/` with a new `sdks/python3/` that follows the **exact same HTTP pattern** as Go, Rust, Java, C#, PHP, and Ruby SDKs. After this migration, Python nodes run in a Docker container just like every other language — no local Python installation required, no gRPC complexity, same `HttpRuntimeAdapter` on the runner side.

**Before (current):**
- Python runtime uses gRPC (protobuf over HTTP/2, BASE64 encoding)
- Requires `Python3RuntimeAdapter` in the runner (a completely separate adapter)
- Requires `NodeGrpcNativeClient` + `@grpc/grpc-js` dependency
- Uses proto/node.proto for message format
- Port 50051

**After (target):**
- Python SDK uses HTTP JSON (same as Go/Rust/Java/C#/PHP/Ruby)
- Uses the existing `HttpRuntimeAdapter` — zero new adapter code needed
- No gRPC dependencies required
- Follows `POST /execute` + `GET /health` contract
- Port 8080 (default), mapped to 9007 on host

---

## Architecture Decision

### Option chosen: New SDK + Deprecate gRPC Adapter

1. Create `sdks/python3/` as a new HTTP-based Python SDK (mirroring the other 6 SDKs)
2. Move existing Python nodes from `runtimes/python3/nodes/` into the new SDK
3. Register Python in `Configuration.ts` as an `HttpRuntimeAdapter` (like Go)
4. Keep `Python3RuntimeAdapter` as deprecated fallback (can be removed later)
5. Update docker-compose files to include the Python SDK container

---

## Implementation Steps

### Step 1: Create the Python HTTP SDK (`sdks/python3/`)

Create the following structure mirroring the other SDKs:

```
sdks/python3/
├── bin/
│   └── serve.py                   # Entry point — starts HTTP server
├── nanoservice/
│   ├── __init__.py
│   ├── server/
│   │   ├── __init__.py
│   │   └── runtime_server.py      # HTTP server (aiohttp or Flask)
│   ├── node/
│   │   ├── __init__.py
│   │   ├── node_handler.py        # NodeHandler abstract base class
│   │   └── node_registry.py       # NodeRegistry (register + execute + health)
│   ├── types/
│   │   ├── __init__.py
│   │   ├── execution_request.py   # ExecutionRequest dataclass
│   │   ├── execution_result.py    # ExecutionResult dataclass
│   │   ├── context.py             # Context dataclass
│   │   ├── request.py             # Request dataclass
│   │   └── response.py            # Response dataclass
│   ├── config/
│   │   ├── __init__.py
│   │   └── server_config.py       # ServerConfig (from env vars)
│   ├── logging/
│   │   ├── __init__.py
│   │   └── logger.py              # Structured logger
│   ├── middleware/
│   │   ├── __init__.py
│   │   ├── logging_middleware.py   # Request/response logging
│   │   └── recovery_middleware.py  # Exception catching
│   └── errors/
│       ├── __init__.py
│       └── node_error.py          # NodeError, ValidationError
├── examples/
│   ├── __init__.py
│   ├── hello_world_node.py        # HelloWorld example node
│   ├── api_call_node.py           # API call example node
│   ├── transform_data_node.py     # Transform data example node
│   └── chain_test_node.py         # Cross-runtime chain test node
├── Dockerfile                     # Multi-stage build
├── requirements.txt               # Dependencies (aiohttp or flask)
├── pyproject.toml                 # Package metadata
└── README.md
```

**The HTTP server must implement the exact same contract as the other SDKs:**

```
POST /execute
  Request body: ExecutionRequest JSON
  Response body: ExecutionResult JSON

GET /health
  Response body: { "status": "healthy", "runtime": "python3", "nodes": [...], "version": "..." }
```

**Key reference files to match the contract:**

- `core/runner/src/adapters/HttpRuntimeAdapter.ts` — The adapter that will communicate with Python (lines 60-130 define the request/response format)
- Any existing SDK server as a pattern to follow (e.g., `sdks/go/server.go` or `sdks/ruby/lib/nanoservice/server/runtime_app.rb`)

### Step 2: Migrate Existing Python Nodes

Move the existing node implementations from `runtimes/python3/nodes/` to `sdks/python3/examples/`. The node logic stays the same — only the base class interface changes:

**Current (gRPC-era):**
```python
class ChainTest(NanoService):
    async def handle(self, ctx: Context, inputs: Dict[str, Any]) -> NanoServiceResponse:
        # Node logic...
        response.setSuccess(data)
        return response
```

**New (HTTP SDK):**
```python
class ChainTestNode(NodeHandler):
    def execute(self, request: ExecutionRequest) -> ExecutionResult:
        body = request.context.request.body  # Resolved inputs from Mapper
        chain = body.get("chain", [])
        origin = body.get("origin", "unknown")

        entry = {"language": "python3", "order": len(chain) + 1, "timestamp": ...}
        chain.append(entry)

        return ExecutionResult(
            success=True,
            data={"chain": chain, "origin": origin},
            vars={"chain": chain, "origin": origin},
        )
```

The key difference: the new `NodeHandler` receives `ExecutionRequest` (the full HTTP JSON body) and returns `ExecutionResult` (the full HTTP JSON response). No more `NanoService.process()` → `blueprintMapper` → `handle()` chain — that mapping happens in the **runner** before the HTTP call.

### Step 3: Update Runner Configuration

**File: `core/runner/src/Configuration.ts`**

Change Python3 from gRPC adapter to HTTP adapter:

```typescript
// BEFORE (gRPC):
if (!registry.has("python3")) {
    registry.register(new Python3RuntimeAdapter(...));
}

// AFTER (HTTP, same as Go/Rust/etc.):
{
    kind: "python3" as RuntimeKind,
    hostEnv: "RUNTIME_PYTHON3_HOST",
    portEnv: "RUNTIME_PYTHON3_PORT",
    defaultPort: 9007,  // or keep 50051 for backward compat
}
```

This is a one-line change in the `httpRuntimes` config array in `initializeRuntimeRegistry()`.

### Step 4: Update Docker Compose

**File: `tests/e2e/cross-runtime/docker-compose.yml`**

Add Python SDK container alongside the other 6:

```yaml
sdk-python3:
  build:
    context: ../../../sdks/python3
    dockerfile: Dockerfile
  ports:
    - "9007:8080"
  environment:
    - PORT=8080
    - LOG_LEVEL=info
  healthcheck:
    test: ["CMD", "curl", "-f", "http://localhost:8080/health"]
    interval: 10s
    timeout: 5s
    retries: 3
```

### Step 5: Update Default Ports

The current default port for Python3 is 50051 (gRPC convention). Change to match the HTTP SDK pattern:

| Runtime | Default Port |
|---------|-------------|
| Go      | 9001        |
| Rust    | 9002        |
| Java    | 9003        |
| C#      | 9004        |
| PHP     | 9005        |
| Ruby    | 9006        |
| Python3 | 9007 (new)  |

This means updating `RUNTIME_PYTHON3_PORT` default from `50051` to `9007` in `Configuration.ts`.

### Step 6: Deprecate (but keep) gRPC Adapter

Don't delete `Python3RuntimeAdapter.ts` immediately. Mark it as deprecated:

```typescript
/**
 * @deprecated Use HttpRuntimeAdapter with kind="python3" instead.
 * This gRPC adapter is kept for backward compatibility with
 * existing deployments using the runtimes/python3 gRPC server.
 */
export class Python3RuntimeAdapter implements RuntimeAdapter { ... }
```

The gRPC adapter and `runtimes/python3/` folder should remain in the codebase until all deployments have migrated.

### Step 7: Write Dockerfile

Following the pattern of the other SDKs:

```dockerfile
FROM python:3.12-slim AS base

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy source
COPY . .

EXPOSE 8080
ENV PORT=8080
ENV HOST=0.0.0.0

HEALTHCHECK --interval=10s --timeout=3s \
  CMD curl -f http://localhost:8080/health || exit 1

ENTRYPOINT ["python", "bin/serve.py"]
```

### Step 8: Update Tests

- Add Python SDK container to the cross-runtime E2E test docker-compose
- Verify the cross-runtime chain still passes with Python using HTTP instead of gRPC
- The `HttpRuntimeAdapter.test.ts` already covers the HTTP contract — no new adapter tests needed

### Step 9: Update Documentation

- Update `ROADMAP.md` Phase 1G to note Python migration
- Update `documentation/DOCS_ROADMAP.md` Phase 3.3 (Python 3 Runtime) to reference new SDK
- Update `documentation/DOCS_PROGRESS.md` page 3.3 notes

---

## Files the Agent MUST Read (Context)

### Understand the HTTP SDK contract (what Python needs to implement):

1. **`core/runner/src/adapters/HttpRuntimeAdapter.ts`** — The adapter that communicates with ALL HTTP SDKs. Read this to understand the exact JSON request/response format Python must implement.

2. **`core/runner/src/adapters/RuntimeAdapter.ts`** — The `ExecutionResult` type that all adapters must return. Contains `success`, `data`, `errors`, `logs`, `metrics`, `vars` fields.

### Understand the existing HTTP SDK pattern (pick ONE as primary reference):

3. **`sdks/go/server.go`** — HTTP server implementation (Go). Clean, simple, good reference.
4. **`sdks/go/registry.go`** — Node registry pattern (register, execute, health).
5. **`sdks/go/types.go`** — Type definitions (ExecutionRequest, ExecutionResult, Context).
6. **`sdks/go/cmd/server/main.go`** — Entry point, registers nodes, starts server.
7. **`sdks/go/examples/nodes/chaintest.go`** — The chain-test node that must work with cross-runtime E2E.
8. **`sdks/go/Dockerfile`** — Container build pattern.

### Understand the existing Python gRPC runtime (what we're replacing):

9. **`runtimes/python3/server.py`** — Current gRPC server entry point. Must be replaced with HTTP.
10. **`runtimes/python3/runner.py`** — Current node executor. The HTTP SDK eliminates this — the runner does this work now.
11. **`runtimes/python3/core/nanoservice.py`** — Current base class for Python nodes (NanoService). The new SDK will have a simpler `NodeHandler` base class.
12. **`runtimes/python3/core/node_base.py`** — Current NodeBase with `process()` and `blueprintMapper()`. The new SDK doesn't need this — the runner's Mapper handles it before the HTTP call.
13. **`runtimes/python3/core/types/context.py`** — Current Context type. Must match the JSON Context format from `HttpRuntimeAdapter`.
14. **`runtimes/python3/core/types/response.py`** — Current ResponseContext type. Replaced by `ExecutionResult`.
15. **`runtimes/python3/nodes/chain_test/node.py`** — Current chain-test node. Must be migrated to the new SDK pattern.

### Understand how the runner dispatches to Python:

16. **`core/runner/src/Configuration.ts`** — Where Python3 adapter is registered. Must change from `Python3RuntimeAdapter` to `HttpRuntimeAdapter` registration in the `httpRuntimes` array.
17. **`core/runner/src/adapters/Python3RuntimeAdapter.ts`** — Current gRPC adapter. Must be deprecated (not deleted).
18. **`core/runner/src/RuntimeAdapterNode.ts`** — Bridge between adapter and runner node. Auto-saves `result.data` to `ctx.vars[this.name]`. This doesn't change.
19. **`core/runner/src/index.ts`** — Runner exports. Python3RuntimeAdapter export should be kept but marked deprecated.

### Understand Docker orchestration:

20. **`tests/e2e/cross-runtime/docker-compose.yml`** — Where all SDK containers are defined. Python SDK container must be added here.
21. **`infra/testing/docker-compose.yml`** — Testing infrastructure. Has the old Python gRPC container.
22. **`infra/development/docker-compose.yml`** — Development environment. May reference Python runtime.

### Understand the gRPC protocol being replaced:

23. **`core/runner/proto/node.proto`** — Protobuf definition for the gRPC protocol. After migration, this is only needed for backward compat.
24. **`core/runner/src/NodeGrpcNativeClient.ts`** — Native gRPC client. After migration, this is only needed for backward compat.
25. **`core/runner/src/NodeGrpcClient.ts`** — Connect-based gRPC client. Same — backward compat only.

### Understand the E2E test that validates the chain:

26. **`triggers/http/workflows/json/cross-runtime-chain.json`** — The workflow JSON. Python step is `"type": "runtime.python3"`. This doesn't change — the type stays the same, only the adapter behind it changes.
27. **`triggers/http/src/nodes/chain-init/index.ts`** — Initializes the chain in `ctx.vars['init']`.
28. **`triggers/http/src/nodes/chain-verify/index.ts`** — Reads `ctx.vars` to verify all 8 runtimes executed.

### Understand other SDK implementations (secondary references):

29. **`sdks/ruby/lib/nanoservice/server/runtime_app.rb`** — Ruby HTTP server (Sinatra). Good reference because Python's Flask is similar to Sinatra.
30. **`sdks/php/src/Server/Server.php`** — PHP HTTP server (ReactPHP). Shows async event-loop server pattern.
31. **`sdks/java/src/main/java/com/blok/nanoservice/server/RuntimeServer.java`** — Java HTTP server. Shows middleware pattern.

---

## What Does NOT Change

- `"type": "runtime.python3"` in workflow JSON — stays the same
- `ctx.vars` data flow pattern — stays the same
- `RuntimeAdapterNode` behavior — stays the same
- The runner's Mapper/blueprintMapper resolving `js/` expressions — stays the same
- Python node business logic (chain-test, hello-world, etc.) — only the interface wrapper changes

---

## What Changes

| Component | Before | After |
|-----------|--------|-------|
| Python runtime location | `runtimes/python3/` | `sdks/python3/` |
| Protocol | gRPC (protobuf + BASE64) | HTTP JSON |
| Server framework | grpc.aio (asyncio) | aiohttp or Flask |
| Default port | 50051 | 9007 (8080 internal) |
| Runner adapter | `Python3RuntimeAdapter` (custom) | `HttpRuntimeAdapter` (shared) |
| Node base class | `NanoService` (with blueprintMapper) | `NodeHandler` (simple execute) |
| Container | Optional / manual | Required (Docker, like all other SDKs) |
| Dependencies (runner-side) | `@grpc/grpc-js`, proto files | None (uses fetch) |
| Node interface | `handle(ctx, inputs)` → `NanoServiceResponse` | `execute(request)` → `ExecutionResult` |

---

## Risk Mitigation

1. **Backward compatibility**: Keep `Python3RuntimeAdapter` and `runtimes/python3/` for existing deployments
2. **Feature flag**: Could use env var `PYTHON3_ADAPTER_MODE=http|grpc` to select adapter
3. **E2E validation**: Run cross-runtime chain test with Python in HTTP mode before removing gRPC
4. **Gradual rollout**: Deploy Python HTTP SDK alongside gRPC server, switch over, then deprecate

---

## Success Criteria

- [ ] `sdks/python3/` exists with HTTP server, following the same pattern as the other 6 SDKs
- [ ] `POST /execute` and `GET /health` endpoints work correctly
- [ ] chain-test node works in cross-runtime E2E test
- [ ] `docker-compose up` starts Python SDK container alongside other SDKs
- [ ] Python3 uses `HttpRuntimeAdapter` in `Configuration.ts` (same code path as Go/Rust/etc.)
- [ ] No local Python installation required to run Python nodes
- [ ] All existing Python node logic preserved (just wrapped in new interface)

---

**Document Version:** 1.0.0
**Created:** 2026-01-29
**Status:** Plan (for agent execution)
