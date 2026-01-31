# Blok Framework

Blok is a TypeScript-first workflow orchestration framework. It executes declarative workflows (JSON or TypeScript DSL) composed of steps (nodes) that run across 8 language runtimes: NodeJS, Python3, Go, Rust, Java, C#, PHP, and Ruby. Built as a Bun monorepo with Hono for HTTP serving.

## Monorepo Structure

```
blok/
├── core/
│   ├── runner/              # @blok/runner  — Workflow execution engine
│   ├── shared/              # @blok/shared  — Common types, NodeBase, Context, GlobalError
│   └── workflow-helper/     # @blok/helper  — TypeScript DSL for defining workflows
├── apps/
│   └── studio/              # @blok/studio  — React trace visualization UI (Vite + TanStack)
├── packages/
│   ├── cli/                 # blokctl       — CLI tool for project scaffolding & dev
│   ├── lsp-server/          # Language Server Protocol for IDE support
│   └── vscode-extension/    # VS Code extension
├── sdks/
│   ├── go/                  # Go SDK        (port 9001)
│   ├── rust/                # Rust SDK      (port 9002)
│   ├── java/                # Java SDK      (port 9003)
│   ├── csharp/              # C# SDK        (port 9004)
│   ├── php/                 # PHP SDK       (port 9005)
│   ├── ruby/                # Ruby SDK      (port 9006)
│   └── python3/             # Python3 SDK   (port 9007)
├── triggers/
│   ├── http/                # @blok/trigger-http — Hono-based HTTP trigger
│   ├── grpc/                # gRPC trigger
│   ├── webhook/             # Webhook trigger
│   ├── websocket/           # WebSocket trigger
│   ├── sse/                 # Server-Sent Events trigger
│   ├── cron/                # Scheduled trigger
│   ├── queue/               # Queue trigger (Kafka, RabbitMQ, SQS, Redis)
│   ├── pubsub/              # Pub/Sub trigger (GCP, AWS, Azure)
│   └── worker/              # Background worker trigger
├── nodes/
│   ├── web/
│   │   ├── api-call@1.0.0/  # @blok/api-call — HTTP request node
│   │   └── react@1.0.0/     # @blok/react   — React SSR node
│   └── control-flow/
│       └── if-else@1.0.0/   # @blok/if-else — Conditional branching
└── runtimes/                # Runtime process definitions
```

## Development Commands

```bash
# Monorepo-wide
bun install                        # Install all workspace dependencies
bun run build                      # Build all core packages + nodes
bun run test                       # Run all tests
bun run lint                       # Lint with Biome

# Core packages
bun run runner:dev                 # Build @blok/runner in watch mode
bun run runner:test                # Test @blok/runner in watch mode
bun run helper:dev                 # Build @blok/helper in watch mode
bun run helper:test                # Test @blok/helper in watch mode
bun run core:build:dev             # Build all core packages in watch mode

# HTTP trigger
bun run http:dev                   # Start HTTP trigger dev server

# CLI
bun run build:cli                  # Build blokctl
bun run cli:dev                    # Build + watch blokctl
bun run cli:test                   # Test blokctl

# Nodes
bun run nodes:build                # Build all pre-built nodes

# Individual packages (vitest)
cd core/runner && bun run test:dev # Watch mode tests
cd core/runner && bun run test     # Single run tests
```

### CLI Commands (blokctl)

```bash
blokctl create project <name>     # Scaffold new Blok project
blokctl create node <name>        # Scaffold new node
blokctl create workflow <name>    # Scaffold new workflow
blokctl dev                       # Start dev server (spawns all runtimes, waits for health)
blokctl build                     # Build project
blokctl generate node             # AI-generate node code
blokctl generate workflow         # AI-generate workflow
blokctl deploy                    # Deploy to cloud
blokctl trace                     # Launch Blok Studio
blokctl monitor                   # Run monitoring UI
blokctl publish node              # Publish node to registry
blokctl search                    # Search nodes/workflows in marketplace
blokctl install                   # Install from marketplace
```

---

## Context — Critical Data Flow

The `Context` type is the central execution state passed through every step. Understanding how data flows through Context is essential.

### Context Type

```typescript
type Context = {
  id: string;                      // Unique request ID
  workflow_name?: string;
  workflow_path?: string;
  request: RequestContext;          // Incoming request (body, headers, params, query, method, url)
  response: ResponseContext;       // ⚠️  OVERWRITTEN after every step
  error: ErrorContext;
  logger: LoggerContext;
  config: ConfigContext;           // Node configuration (inputs resolved by Mapper)
  func?: FunctionContext;
  vars?: VarsContext;              // ✅ PERSISTS across entire workflow
  env?: EnvContext;                // process.env access
  eventLogger: GlobalLogger;
  _PRIVATE_: unknown;
};
```

### The Two Critical Rules

**Rule 1: `ctx.response.data` is OVERWRITTEN after every step.**
Each step's output replaces the previous `ctx.response.data`. If you need a step's output later, you must store it in `ctx.vars`.

**Rule 2: `ctx.vars` PERSISTS across the entire workflow.**
Use `set_var: true` on a step to auto-store its output in `ctx.vars[stepName]`. Downstream steps access it via `ctx.vars['step-name']`.

### Data Flow Example

```
Step 1: "fetch-user"  (set_var: true)
  → Executes, returns { id: "123", name: "Alice" }
  → ctx.response.data = { id: "123", name: "Alice" }
  → ctx.vars["fetch-user"] = { id: "123", name: "Alice" }

Step 2: "transform"
  → Executes, returns { result: "transformed" }
  → ctx.response.data = { result: "transformed" }    ← Step 1 output GONE from response
  → ctx.vars["fetch-user"] still = { id: "123", name: "Alice" }

Step 3: "output"
  → Can read ctx.vars["fetch-user"].name  ← still "Alice"
  → ctx.response.data is Step 2's output only
```

### Blueprint Mapper — Expression Resolution

Node inputs in workflow JSON support dynamic expressions that are resolved BEFORE the node executes.

**`js/` prefix** — evaluates JavaScript with full context access:
```json
{
  "inputs": {
    "userId": "js/ctx.request.body.userId",
    "chain": "js/ctx.vars['previous-step'].chain",
    "previous": "js/ctx.response.data.result",
    "isAdmin": "js/ctx.vars['auth'].role === 'admin'"
  }
}
```

**`${...}` templates** — resolved via lodash `_.get` or JavaScript evaluation:
```json
{
  "inputs": {
    "name": "${request.body.name}"
  }
}
```

**Available in `js/` expressions**: `ctx`, `data` (ctx.response.data), `func` (ctx.func), `vars` (ctx.vars)

---

## Creating Nodes with defineNode

Use `defineNode()` for all new nodes. It replaces the legacy class-based BlokService pattern with 60% less boilerplate.

### Simple Node

```typescript
import { defineNode } from "@blok/runner";
import { z } from "zod";

export default defineNode({
  name: "fetch-user",
  description: "Fetches user by ID from database",

  input: z.object({
    userId: z.string().uuid(),
  }),

  output: z.object({
    user: z.object({
      id: z.string(),
      name: z.string(),
      email: z.string().email(),
    }),
  }),

  async execute(ctx, input) {
    // input is type-safe: { userId: string }
    const user = await fetchUser(input.userId);
    // Return must match output schema
    return { user };
  },
});
```

### Flow Control Node (Conditional)

```typescript
import { defineNode } from "@blok/runner";
import { z } from "zod";

export default defineNode({
  name: "my-router",
  description: "Routes execution based on condition",
  flow: true,  // ← Tells runner this returns steps, not data

  input: z.array(z.object({
    type: z.enum(["if", "else"]),
    condition: z.string().optional(),
    steps: z.array(z.any()),
  })),

  output: z.array(z.any()),  // Returns NodeBase[] for runner to execute

  async execute(ctx, inputs) {
    for (const branch of inputs) {
      if (branch.condition) {
        const result = Function("ctx", "vars", `"use strict";return (${branch.condition});`)(
          ctx, ctx.vars || {}
        );
        if (result) return branch.steps;
      } else {
        return branch.steps;  // else branch
      }
    }
    return [];
  },
});
```

### Node with Custom Content Type

```typescript
export default defineNode({
  name: "render-page",
  description: "Renders an HTML page",
  contentType: "text/html",  // ← Response content type

  input: z.object({ title: z.string() }),
  output: z.string(),

  async execute(ctx, input) {
    return `<html><head><title>${input.title}</title></head><body>Hello</body></html>`;
  },
});
```

### defineNode Key Behaviors

- Zod input validation runs automatically before `execute()`
- Zod output validation runs automatically after `execute()`
- `ZodError` is mapped to `GlobalError` with HTTP 400 and detailed validation messages
- `flow: true` nodes return `NodeBase[]` which the runner executes recursively
- `contentType` sets the response Content-Type header
- Always `export default defineNode(...)` — this is the standard pattern

---

## Workflow Structure

Workflows can be defined as JSON or via the TypeScript DSL.

### JSON Workflow

```json
{
  "name": "My Workflow",
  "version": "1.0.0",
  "description": "What this workflow does",
  "trigger": {
    "http": {
      "method": "POST",
      "path": "/api/process",
      "accept": "application/json"
    }
  },
  "steps": [
    { "name": "fetch",    "node": "@blok/api-call",  "type": "module" },
    { "name": "process",  "node": "my-node",         "type": "module", "set_var": true },
    { "name": "go-step",  "node": "chain-test",      "type": "runtime.go" },
    { "name": "output",   "node": "format-result",   "type": "local" }
  ],
  "nodes": {
    "fetch": {
      "inputs": {
        "url": "https://api.example.com/users",
        "method": "GET",
        "headers": { "Content-Type": "application/json" },
        "responseType": "application/json"
      }
    },
    "process": {
      "inputs": {
        "data": "js/ctx.response.data"
      }
    },
    "go-step": {
      "inputs": {
        "processed": "js/ctx.vars['process']"
      }
    },
    "output": {
      "inputs": {}
    }
  }
}
```

### Step Properties

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `name` | string | Yes | Step identifier (must match key in `nodes`) |
| `node` | string | Yes | Node package name or path |
| `type` | string | Yes | `module`, `local`, or `runtime.*` |
| `set_var` | boolean | No | Store output in `ctx.vars[name]` (default: false) |
| `active` | boolean | No | Skip step if false (default: true) |
| `stop` | boolean | No | Halt workflow after this step (default: false) |

### Step Types

| Type | Description | Execution |
|------|-------------|-----------|
| `module` | TypeScript node from registered modules | In-process NodeJS |
| `local` | TypeScript node from filesystem (`NODES_PATH`) | In-process NodeJS |
| `runtime.nodejs` | NodeJS runtime adapter | In-process |
| `runtime.python3` | Python3 SDK container | HTTP to port 9007 |
| `runtime.go` | Go SDK container | HTTP to port 9001 |
| `runtime.rust` | Rust SDK container | HTTP to port 9002 |
| `runtime.java` | Java SDK container | HTTP to port 9003 |
| `runtime.csharp` | C# SDK container | HTTP to port 9004 |
| `runtime.php` | PHP SDK container | HTTP to port 9005 |
| `runtime.ruby` | Ruby SDK container | HTTP to port 9006 |

### Conditional Workflow (if-else)

```json
{
  "steps": [
    { "name": "filter-request", "node": "@blok/if-else", "type": "module" }
  ],
  "nodes": {
    "filter-request": {
      "conditions": [
        {
          "type": "if",
          "condition": "ctx.request.query.countries === \"true\"",
          "steps": [
            { "name": "get-countries", "node": "@blok/api-call", "type": "module" }
          ]
        },
        {
          "type": "else",
          "steps": [
            { "name": "get-facts", "node": "@blok/api-call", "type": "module" }
          ]
        }
      ]
    },
    "get-countries": {
      "inputs": { "url": "https://api.example.com/countries", "method": "GET" }
    },
    "get-facts": {
      "inputs": { "url": "https://catfact.ninja/fact", "method": "GET" }
    }
  }
}
```

Conditions are evaluated in order. First match wins. `condition` strings are JavaScript expressions with access to `ctx`.

### TypeScript DSL

```typescript
import { Workflow, Step } from "@blok/helper";

const workflow = Workflow({ name: "example", version: "1.0.0" })
  .addTrigger("http", { method: "POST", path: "/api/process" })
  .addStep({ name: "fetch", node: "@blok/api-call", type: "module" })
  .addStep({ name: "process", node: "my-node", type: "module" })
  .build();
```

---

## Trigger Types

| Trigger | Key Config | Example |
|---------|-----------|---------|
| `http` | method, path, accept | `{ "method": "GET", "path": "/", "accept": "application/json" }` |
| `grpc` | service, method, proto | `{ "service": "UserService", "method": "GetUser" }` |
| `cron` | schedule, timezone | `{ "schedule": "0 * * * *", "timezone": "UTC" }` |
| `queue` | provider, topic, consumerGroup | `{ "provider": "kafka", "topic": "events" }` |
| `pubsub` | provider, topic, subscription | `{ "provider": "gcp", "topic": "updates" }` |
| `webhook` | source, events, secret | `{ "source": "github", "events": ["push"] }` |
| `websocket` | events, path | `{ "events": ["message"], "path": "/ws" }` |
| `sse` | events, channels, path | `{ "events": ["update"], "path": "/stream" }` |
| `worker` | queue, concurrency, retries | `{ "queue": "jobs", "concurrency": 5 }` |

Queue providers: `kafka`, `rabbitmq`, `sqs`, `redis`, `beanstalk`
Pub/Sub providers: `gcp`, `aws`, `azure`

---

## Runtime Adapter System

### Architecture

```
Configuration.ts → RuntimeRegistry (singleton) → RuntimeAdapter → ExecutionResult
                                                    ├── NodeJsRuntimeAdapter (in-process)
                                                    └── HttpRuntimeAdapter (HTTP to SDK containers)
```

### RuntimeRegistry

Singleton initialized in `Configuration` constructor. Registers built-in adapters for all 8 runtimes.

```typescript
const registry = RuntimeRegistry.getInstance();
registry.register(adapter);      // Register new adapter
registry.get("go");              // Get adapter by kind
registry.has("go");              // Check if registered
registry.replace(adapter);       // Replace (for hot-reload/testing)
```

### HTTP Runtime Contract

All non-NodeJS SDKs implement the same HTTP contract:

**POST /execute**
```json
// Request
{
  "node": { "name": "step-name", "type": "runtime.go", "config": { /* resolved inputs */ } },
  "context": {
    "id": "request-id",
    "workflow_name": "My Workflow",
    "request": { "body": {}, "headers": {}, "params": {}, "query": {} },
    "response": { "data": {}, "success": true },
    "vars": {},
    "env": {}
  }
}

// Response (ExecutionResult)
{
  "success": true,
  "data": { /* node output */ },
  "errors": null,
  "logs": ["log line 1"],
  "metrics": { "duration_ms": 42, "cpu_ms": 10, "memory_bytes": 1024 },
  "vars": {}
}
```

**GET /health** — Returns `{ "status": "healthy" }`

### Environment Variables

```
RUNTIME_GO_HOST=localhost       RUNTIME_GO_PORT=9001
RUNTIME_RUST_HOST=localhost     RUNTIME_RUST_PORT=9002
RUNTIME_JAVA_HOST=localhost     RUNTIME_JAVA_PORT=9003
RUNTIME_CSHARP_HOST=localhost   RUNTIME_CSHARP_PORT=9004
RUNTIME_PHP_HOST=localhost      RUNTIME_PHP_PORT=9005
RUNTIME_RUBY_HOST=localhost     RUNTIME_RUBY_PORT=9006
RUNTIME_PYTHON3_HOST=localhost  RUNTIME_PYTHON3_PORT=9007
```

### RuntimeAdapterNode Behavior

After SDK execution, `RuntimeAdapterNode` automatically:
1. Merges `result.vars` into `ctx.vars`
2. Saves `result.data` to `ctx.vars[this.name]` (auto set_var for runtime nodes)
3. Records metrics into RunTracker trace

---

## Blok Studio

React 18+ SPA (Vite + TanStack Router + Zustand) for real-time workflow trace visualization.

### Trace API Endpoints (at `/__blok/`)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/__blok/runs` | GET | List all workflow runs |
| `/__blok/runs/:id` | GET | Get specific run details |
| `/__blok/runs/:id/stream` | GET | SSE stream of run events |
| `/__blok/workflows` | GET | List available workflows |
| `/__blok/metrics` | GET | Metrics snapshot |
| `/__blok/health` | GET | Health check |

Enabled by default. Disable with `BLOK_TRACE_ENABLED=false`.

### Key React Hooks

```typescript
useRuns()              // Fetch all runs (TanStack Query)
useRunDetail(id)       // Fetch specific run
useGlobalStream()      // SSE stream of live events
useMetrics()           // Metrics data
useWorkflows()         // List workflows
```

### Trace Data Model

```typescript
interface RunTrace {
  id: string;
  workflowName: string;
  status: "running" | "completed" | "failed";
  startTime: number;
  endTime?: number;
  nodes: NodeTrace[];
}

interface NodeTrace {
  id: string;
  nodeName: string;
  nodeType: string;
  runtimeKind?: string;
  status: "running" | "completed" | "failed" | "skipped";
  inputs: unknown;
  outputs?: unknown;
  error?: unknown;
  depth: number;        // 0 = top-level, 1+ = nested in flow
  stepIndex: number;
}
```

### Tech Stack

- React 19, TanStack Router, TanStack Query, TanStack Table
- @xyflow/react for workflow graph visualization
- Zustand for state management
- Tailwind CSS 4, Recharts for metrics charts
- Lucide React for icons

---

## Error Handling

### GlobalError

All framework errors use `GlobalError` from `@blok/shared`:

```typescript
const error = new GlobalError("Something went wrong");
error.setCode(500);           // HTTP status code
error.setName("node-name");   // Originating node
error.setStack(err.stack);    // Stack trace
error.setJson({ details });   // Additional JSON payload
```

### Zod Validation Errors

In `defineNode` nodes, Zod validation errors are automatically converted:
- Input validation failure → `GlobalError` with code 400
- Message format: `"Validation failed: fieldName (expected string, received undefined)"`
- JSON payload includes detailed `validation_errors` array

### Try-Catch in Workflows

```json
{
  "nodes": {
    "step-name": {
      "try": {
        "steps": [
          { "name": "risky", "node": "some-node", "type": "module" }
        ]
      },
      "catch": {
        "steps": [
          { "name": "fallback", "node": "error-handler", "type": "module" }
        ]
      }
    }
  }
}
```

---

## Project Configuration

### .blok/config.json

Created by `blokctl create project`. Defines runtime processes:

```json
{
  "runtimes": {
    "python3": {
      "kind": "python3",
      "label": "Python 3",
      "port": 9007,
      "startCmd": "python3 .blok/runtimes/python3/server.py",
      "cwd": ".blok/runtimes/python3"
    },
    "go": {
      "kind": "go",
      "label": "Go",
      "port": 9001,
      "startCmd": "go run cmd/main.go",
      "cwd": "runtimes/go"
    }
  }
}
```

`blokctl dev` reads this file, spawns each runtime process, polls `/health` until ready, then starts the Bun runner.

---

## Import Patterns

```typescript
// Core runner
import { defineNode } from "@blok/runner";
import type { FnNodeDefinition } from "@blok/runner";

// Shared types
import type { Context, RequestContext, ResponseContext, VarsContext } from "@blok/shared";
import { GlobalError, NodeBase } from "@blok/shared";

// Workflow helper DSL
import { Workflow, Step, Trigger, AddIf, AddElse } from "@blok/helper";
import type { StepOpts, WorkflowOpts, NodeType, RuntimeKind } from "@blok/helper";
import type { HttpTriggerOpts, CronTriggerOpts, QueueTriggerOpts } from "@blok/helper";

// Zod (always from "zod" directly)
import { z } from "zod";
```

---

## Code Conventions

- **Linter**: Biome (not ESLint/Prettier)
- **Test framework**: Vitest
- **Files**: kebab-case (`my-node.ts`)
- **Types/Interfaces**: PascalCase (`StepOpts`, `RuntimeKind`)
- **Zod schemas**: PascalCase + `Schema` suffix (`StepOptsSchema`, `RuntimeKindSchema`)
- **Node files**: Always `export default defineNode(...)`
- **Runtime / Package manager**: Bun with workspaces
- **Build**: TypeScript compiler for builds (declaration generation)
- **HTTP framework**: Hono (triggers/http)

---

## Do NOT

- Do NOT rely on `ctx.response.data` for data from non-previous steps — it gets overwritten
- Do NOT create class-based nodes extending BlokService — use `defineNode()` instead
- Do NOT use `any` type — use `unknown` and narrow with Zod
- Do NOT hardcode runtime ports — use environment variables
- Do NOT mutate `ctx` directly in node execute functions — return data and let the framework handle it
- Do NOT skip Zod input/output schemas — they power validation, JSON Schema generation, and type safety
- Do NOT edit auto-generated files in `.blok/runtimes/`
- Do NOT use ESLint/Prettier — this project uses Biome

## Do

- Use `ctx.vars` with `set_var: true` to pass data between non-adjacent steps
- Use `js/ctx.vars['step-name'].field` in workflow node inputs for data flow
- Use Zod schemas for all input/output validation in defineNode
- Use `defineNode()` for all new nodes
- Use named exports for library code, `export default defineNode(...)` for node files
- Handle errors via GlobalError with appropriate HTTP status codes
- Keep nodes focused — one responsibility per node
- Test nodes with Vitest using mocked Context objects
