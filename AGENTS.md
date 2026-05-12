# Blok Framework

Blok is a TypeScript-first workflow orchestration framework. It executes declarative workflows (JSON or TypeScript DSL) composed of steps (nodes) that run across 8 language runtimes: NodeJS, Python3, Go, Rust, Java, C#, PHP, and Ruby. Built as a Bun monorepo with Hono for HTTP serving.

## Monorepo Structure

```
blok/
├── core/
│   ├── runner/              # @blokjs/runner  — Workflow execution engine
│   ├── shared/              # @blokjs/shared  — Common types, NodeBase, Context, GlobalError
│   └── workflow-helper/     # @blokjs/helper  — TypeScript DSL for defining workflows
├── apps/
│   └── studio/              # @blokjs/studio  — React trace visualization UI (Vite + TanStack)
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
│   ├── http/                # @blokjs/trigger-http — Hono-based HTTP trigger
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
│   │   ├── api-call@1.0.0/  # @blokjs/api-call — HTTP request node
│   │   └── react@1.0.0/     # @blokjs/react   — React SSR node
│   └── control-flow/
│       └── if-else@1.0.0/   # @blokjs/if-else — Conditional branching
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
bun run runner:dev                 # Build @blokjs/runner in watch mode
bun run runner:test                # Test @blokjs/runner in watch mode
bun run helper:dev                 # Build @blokjs/helper in watch mode
bun run helper:test                # Test @blokjs/helper in watch mode
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

**Rule 1: `ctx.prev` carries the immediately previous step's output.**
Each step's output replaces `ctx.prev`. Use it for adjacent-step access only.

**Rule 2: `ctx.state[id]` PERSISTS across the entire workflow.**
Every step's output is auto-stored at `ctx.state[<step-id>]` (the v2 default-store rule). Downstream steps reference it via `$.state.<id>` (TS DSL) or `"$.state.<id>"` / `"js/ctx.state.<id>"` (JSON). Opt out per step with `ephemeral: true`. The legacy `set_var` field was removed in v0.5 — the runner throws at workflow load if it's still present (run `blokctl migrate workflows` to convert v1 workflows).

### Data Flow Example

```
Step 1: id "fetch-user"
  → Executes, returns { id: "123", name: "Alice" }
  → ctx.state["fetch-user"] = { id: "123", name: "Alice" }
  → ctx.prev = { id: "123", name: "Alice" }

Step 2: id "transform"
  → Executes, returns { result: "transformed" }
  → ctx.state["transform"] = { result: "transformed" }
  → ctx.prev = { result: "transformed" }                ← Step 1 output GONE from prev
  → ctx.state["fetch-user"] still = { id: "123", name: "Alice" }

Step 3: id "output"
  → Can read ctx.state["fetch-user"].name  ← still "Alice"
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
import { defineNode } from "@blokjs/runner";
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
import { defineNode } from "@blokjs/runner";
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

Workflows can be defined as **TypeScript (preferred)** or JSON. TypeScript workflows use a fluent builder API from `@blokjs/helper` and live in `triggers/http/src/workflows/`. JSON workflows live in `triggers/http/workflows/json/`. Both produce the same internal structure and have identical capabilities.

### TypeScript Workflows (Preferred)

TypeScript workflows are the recommended approach. They provide type safety, IDE autocompletion, and can be organized in folders.

#### File Structure

```
triggers/http/src/
├── workflows/                    # TypeScript workflow definitions
│   ├── users/                    # Organize by domain in subfolders
│   │   ├── create-user.ts
│   │   └── get-user.ts
│   ├── orders/
│   │   ├── process-order.ts
│   │   └── cancel-order.ts
│   └── health-check.ts          # Or flat files for simple workflows
├── Workflows.ts                  # Registry: maps workflow IDs to workflow objects
└── Nodes.ts                      # Registry: maps node IDs to node instances
```

#### Simple Workflow

```typescript
import { type Step, Workflow } from "@blokjs/helper";

const step: Step = Workflow({
  name: "Get Users",
  version: "1.0.0",
  description: "Fetches users from external API",
})
  .addTrigger("http", {
    method: "GET",
    path: "/users",
    accept: "application/json",
  })
  .addStep({
    name: "fetch-users",
    node: "@blokjs/api-call",
    type: "module",
    inputs: {
      url: "https://api.example.com/users",
      method: "GET",
      headers: { "Content-Type": "application/json" },
      responseType: "application/json",
    },
  });

export default step;
```

#### Multi-Step Workflow

```typescript
import { type Step, Workflow } from "@blokjs/helper";

const step: Step = Workflow({
  name: "Process Order",
  version: "1.0.0",
})
  .addTrigger("http", {
    method: "POST",
    path: "/orders",
    accept: "application/json",
  })
  .addStep({
    name: "validate-order",
    node: "order-validator",
    type: "module",
    inputs: {
      order: "js/ctx.request.body",
    },
  })
  .addStep({
    name: "save-order",
    node: "order-store",
    type: "module",
    inputs: {
      data: "js/ctx.response.data",
    },
  });

export default step;
```

#### Conditional Workflow (if-else)

```typescript
import { AddElse, AddIf, type Step, Workflow } from "@blokjs/helper";

const step: Step = Workflow({
  name: "Route by Query",
  version: "1.0.0",
})
  .addTrigger("http", {
    method: "ANY",       // ← Use "ANY" in TS (equivalent to "*" in JSON)
    path: "/",
    accept: "application/json",
  })
  .addCondition({
    node: {
      name: "router",
      node: "@blokjs/if-else",
      type: "module",
    },
    conditions: () => {
      return [
        new AddIf('ctx.request.query.type === "countries"')
          .addStep({
            name: "get-countries",
            node: "@blokjs/api-call",
            type: "module",
            inputs: {
              url: "https://countriesnow.space/api/v0.1/countries",
              method: "GET",
              headers: { "Content-Type": "application/json" },
              responseType: "application/json",
            },
          })
          .build(),
        new AddIf('ctx.request.query.type === "facts"')
          .addStep({
            name: "get-facts",
            node: "@blokjs/api-call",
            type: "module",
            inputs: {
              url: "https://catfact.ninja/fact",
              method: "GET",
              headers: { "Content-Type": "application/json" },
              responseType: "application/json",
            },
          })
          .build(),
        new AddElse()
          .addStep({
            name: "default-response",
            node: "default-handler",
            type: "module",
          })
          .build(),
      ];
    },
  });

export default step;
```

#### Cross-Runtime Workflow

```typescript
import { type Step, Workflow } from "@blokjs/helper";

const step: Step = Workflow({
  name: "Cross Runtime Chain",
  version: "1.0.0",
})
  .addTrigger("http", {
    method: "GET",
    path: "/chain",
    accept: "application/json",
  })
  .addStep({
    name: "init",
    node: "chain-init",
    type: "module",
    inputs: {},
  })
  .addStep({
    name: "go-step",
    node: "chain-test",
    type: "runtime.go",
    inputs: {
      chain: "js/ctx.response.data.chain",
    },
  })
  .addStep({
    name: "python-step",
    node: "chain-test",
    type: "runtime.python3",
    inputs: {
      chain: "js/ctx.response.data.chain",
    },
  });

export default step;
```

#### Registering Workflows in Workflows.ts

Every TS workflow must be imported and registered in `triggers/http/src/Workflows.ts`:

```typescript
import type Workflows from "./runner/types/Workflows";
import createUser from "./workflows/users/create-user";
import getUser from "./workflows/users/get-user";
import processOrder from "./workflows/orders/process-order";
import healthCheck from "./workflows/health-check";

const workflows: Workflows = {
  "create-user": createUser,
  "get-user": getUser,
  "process-order": processOrder,
  "health-check": healthCheck,
};

export default workflows;
```

The key (e.g. `"create-user"`) becomes the workflow's route identifier.

#### Registering Nodes in Nodes.ts

All nodes referenced by workflows must be registered in `triggers/http/src/Nodes.ts`:

```typescript
import ApiCall from "@blokjs/api-call";
import IfElse from "@blokjs/if-else";
import type { NodeBase } from "@blokjs/shared";
import OrderValidator from "./nodes/order-validator/index";
import OrderStore from "./nodes/order-store/index";

const nodes: {
  [key: string]: NodeBase;
} = {
  "@blokjs/api-call": ApiCall,
  "@blokjs/if-else": IfElse,
  "order-validator": OrderValidator,
  "order-store": OrderStore,
};

export default nodes;
```

#### Builder API Chain

```
Workflow({ name, version, description? })
  → returns Trigger
    .addTrigger(type, config)
      → returns StepNode
        .addStep({ name, node, type, inputs?, runtime? })
          → returns StepNode (chainable)
        .addCondition({ node, conditions: () => [...] })
          → returns StepNode (chainable)
```

#### Key Differences: TS vs JSON

| Feature | TypeScript | JSON |
|---------|-----------|------|
| HTTP method wildcard | `"ANY"` | `"*"` |
| Inputs location | Inline on `.addStep()` | Separate in `nodes` object |
| Conditions | `AddIf` / `AddElse` builders | `conditions` array |
| File location | `triggers/http/src/workflows/` | `triggers/http/workflows/json/` |
| Registration | Import in `Workflows.ts` | Auto-loaded by runner |
| Type safety | Full TypeScript + Zod validation | None |

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
    { "name": "fetch",    "node": "@blokjs/api-call",  "type": "module" },
    { "name": "process",  "node": "my-node",         "type": "module" },
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
| `ephemeral` | boolean | No | Skip persisting this step's output to `ctx.state` (default: false — every step default-stores) |
| `as` | string | No | Alternative state key — store at `state[as]` instead of `state[name]` |
| `spread` | boolean | No | Shallow-merge `result.data` keys into `state` (mutually exclusive with `as`) |
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

### Conditional Workflow (if-else) — JSON

```json
{
  "steps": [
    { "name": "filter-request", "node": "@blokjs/if-else", "type": "module" }
  ],
  "nodes": {
    "filter-request": {
      "conditions": [
        {
          "type": "if",
          "condition": "ctx.request.query.countries === \"true\"",
          "steps": [
            { "name": "get-countries", "node": "@blokjs/api-call", "type": "module" }
          ]
        },
        {
          "type": "else",
          "steps": [
            { "name": "get-facts", "node": "@blokjs/api-call", "type": "module" }
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

Queue providers: `kafka`, `rabbitmq`, `sqs`, `redis`, `beanstalk`, `nats`
Pub/Sub providers: `gcp`, `aws`, `azure`

### Worker Trigger

The `worker` trigger processes background jobs from a queue. It supports multiple adapters and provides retry logic, concurrency control, and job lifecycle management.

#### Worker Trigger Config

```typescript
interface WorkerTriggerOpts {
  queue: string;           // Queue name to subscribe to
  concurrency?: number;    // Max concurrent jobs (default: 1)
  retries?: number;        // Maximum retry attempts (default: 3)
  timeout?: number;        // Job processing timeout in ms
  delay?: number;          // Base delay for exponential backoff in ms
}
```

#### Worker Workflow Example (TypeScript)

```typescript
import { type Step, Workflow } from "@blokjs/helper";

const step: Step = Workflow({
  name: "Process Background Job",
  version: "1.0.0",
})
  .addTrigger("worker", {
    queue: "background-jobs",
  })
  .addStep({
    name: "process-job",
    node: "@blokjs/api-call",
    type: "module",
    inputs: {
      url: "https://example.com/process",
      method: "POST",
      body: "js/ctx.request.body",
    },
  });

export default step;
```

#### Job Context Mapping

When a worker processes a job, the context is populated as follows:

```
ctx.request.body              → Job payload (data)
ctx.request.headers           → Job headers/metadata
ctx.request.params.queue      → Queue name
ctx.request.params.jobId      → Job ID
ctx.request.params.attempt    → Current attempt (0-based string)
ctx.vars._worker_job          → { id, queue, attempts, maxRetries, priority, createdAt, delay, timeout }
```

#### Worker Adapters

| Adapter | Backend | Install | Use Case |
|---------|---------|---------|----------|
| `NATSWorkerAdapter` | NATS JetStream | `nats` | Production — durable, distributed |
| `BullMQAdapter` | Redis via BullMQ | `bullmq ioredis` | Production — priority queues, delayed jobs |
| `InMemoryAdapter` | In-process | None | Development/testing only |

#### Worker Retry Logic

Exponential backoff with jitter: `min(baseDelay × 2^attempt, 30000ms) + 10% jitter`

After max retries, jobs are moved to a Dead Letter Queue (DLQ).

### NATS JetStream

NATS JetStream is the recommended adapter for both queue and worker triggers. It provides:

- **Pull-based consumers** — reliable message delivery
- **Durable consumers** — fault tolerance across restarts
- **Server-side retry** — `max_deliver` configures redelivery count
- **Work queue semantics** — each message processed by exactly one consumer

#### NATS Environment Variables

```
NATS_SERVERS=localhost:4222         # Comma-separated server URLs
NATS_TOKEN=                         # Authentication token (optional)
NATS_USER=                          # Username (optional)
NATS_PASS=                          # Password (optional)
NATS_STREAM_NAME=blok-queue         # Queue trigger stream (default: blok-queue)
                                    # Worker trigger stream (default: blok-worker)
```

---

## Standalone Workers (Go, Rust, Python)

Go, Rust, and Python SDKs include standalone NATS JetStream workers that run independently of the TypeScript runner. These connect directly to NATS, consume jobs, and execute registered node handlers in their native runtimes.

### Architecture

```
NATS JetStream
  └── Worker (Go/Rust/Python process)
       ├── handle(queue, handler)      # Custom handler per queue
       ├── handle_node(queue, name)    # Auto-route to node registry
       ├── start()                     # Connect + consume + block
       ├── stop()                      # Graceful shutdown
       └── dispatch(queue, data)       # Publish new job
```

### Worker Environment Variables (All Languages)

```
NATS_SERVERS=localhost:4222         # NATS server URLs
NATS_STREAM_NAME=blok-worker       # JetStream stream name
NATS_TOKEN=                         # Auth token
NATS_USER= / NATS_PASS=           # User/pass auth
WORKER_CONCURRENCY=1                # Max concurrent jobs
WORKER_MAX_RETRIES=3                # Max delivery attempts
WORKER_ACK_WAIT_SECS=30            # Ack timeout (Python: seconds, Go: duration string)
WORKER_QUEUES=queue1,queue2         # Comma-separated queue names
PORT=8080                           # Health server port (Rust/Python)
```

### Go Worker

```go
import blok "blok-runtime"

func main() {
    registry := blok.NewNodeRegistry("1.0.0")
    registry.Register("process-order", processOrderNode)

    config := blok.LoadWorkerConfigFromEnv()
    worker := blok.NewWorker(registry, config)

    // Route queue to registered node
    worker.HandleNode("orders", "process-order")

    // Or use a custom handler
    worker.Handle("notifications", func(ctx context.Context, job *blok.JobMessage) error {
        var payload map[string]interface{}
        job.DataAs(&payload)
        return nil
    })

    worker.Start(context.Background()) // Blocks until signal
}
```

### Rust Worker

```rust
use blok_runtime::{Worker, WorkerConfig, NodeRegistry, JobMessage};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut registry = NodeRegistry::new("1.0.0");
    registry.register("process-order", process_order_node);

    let config = WorkerConfig::from_env();
    let mut worker = Worker::new(registry, config);

    worker.handle_node("orders", "process-order");
    worker.handle("notifications", |job: JobMessage| async move {
        println!("Got job: {}", job.id);
        Ok(())
    });

    worker.start().await
}
```

### Python Worker

```python
from blok import NodeRegistry, Worker, WorkerConfig, listen_and_serve_worker

registry = NodeRegistry("1.0.0")
registry.register("process-order", process_order_node)

# Quick start (reads config from env, starts health server)
listen_and_serve_worker(registry)

# Or manual setup
config = WorkerConfig.from_env()
worker = Worker(registry, config)
worker.handle_node("orders", "process-order")

async def custom_handler(job):
    print(f"Got job: {job.id}, data: {job.data_map()}")

worker.handle("notifications", custom_handler)
asyncio.run(worker.start())
```

**Install**: `pip install nats-py` (or `pip install blok-blok-python3[worker]`)

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
1. Merges `result.vars` into `ctx.state`
2. Routes `result.data` through `PersistenceHelper.applyStepOutput` — same `ephemeral` / `spread` / `as` rules as module nodes
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

## Testing Utilities

The `@blokjs/runner` package provides testing utilities for both individual nodes and complete workflows.

### NodeTestHarness — Unit Testing Nodes

```typescript
import { NodeTestHarness } from "@blokjs/runner";
import myNode from "./my-node";

const harness = new NodeTestHarness(myNode);

// Execute with test input
const result = await harness.execute(
  { userId: "abc-123" },
  { vars: { "auth": { role: "admin" } } }  // Context overrides
);

// Assertions
harness.assertSuccess(result);
harness.assertOutput(result, { user: { id: "abc-123" } });
harness.assertContextVar(result, "my-node", { user: { id: "abc-123" } });

// Metrics
const metrics = harness.getMetrics();
// { totalExecutions, successCount, failureCount, avgDurationMs, lastDurationMs }
```

### TestResult

```typescript
interface TestResult<O> {
  success: boolean;
  data: O | null;        // Node output
  error: any;            // Error if failed
  context: Context;      // Full context after execution
  durationMs: number;    // Execution time
  logs: string[];        // Captured log messages
}
```

### TestContextOverrides

```typescript
interface TestContextOverrides {
  id?: string;
  request?: { body?, headers?, query?, params? };
  response?: Partial<ResponseContext>;
  vars?: Record<string, any>;
  env?: Record<string, any>;
  error?: { message, code? };
  logger?: TestLogger;
  workflow_name?: string;
  workflow_path?: string;
  config?: Record<string, any>;
}
```

### WorkflowTestRunner — Integration Testing Workflows

```typescript
import { WorkflowTestRunner } from "@blokjs/runner";

const runner = new WorkflowTestRunner({ verbose: true, timeout: 10000 });

// Register real or mock nodes
runner.registerNode("validate", ValidateNode);
runner.mockNode("fetch-user", async (input, ctx) => {
  return { user: { id: input.userId, name: "Test User" } };
});

// Load and execute workflow
runner.loadWorkflow({
  name: "test-workflow",
  steps: [
    { name: "step1", node: "validate", inputs: { userId: "abc" } },
    { name: "step2", node: "fetch-user", inputs: { userId: "js/ctx.response.data.userId" } },
  ],
});

const result = await runner.execute({ userId: "abc" });
// result.success, result.output, result.trace, result.durationMs, result.nodeResults
```

#### WorkflowTestRunner Config

| Option | Default | Description |
|--------|---------|-------------|
| `timeout` | 30000 | Workflow execution timeout (ms) |
| `verbose` | false | Print execution details to console |
| `mockAllNodes` | false | Auto-mock any unregistered node |

#### ExecutionTrace

Each step in the trace contains:
```typescript
{ nodeName, stepIndex, input, output, durationMs, success, error?, timestamp }
```

---

## Error Handling

### GlobalError

All framework errors use `GlobalError` from `@blokjs/shared`:

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
import { defineNode } from "@blokjs/runner";
import type { FnNodeDefinition } from "@blokjs/runner";

// Testing utilities
import { NodeTestHarness, WorkflowTestRunner } from "@blokjs/runner";
import type { TestResult, TestContextOverrides } from "@blokjs/runner";

// Shared types
import type { Context, RequestContext, ResponseContext, VarsContext } from "@blokjs/shared";
import { GlobalError, NodeBase } from "@blokjs/shared";

// Workflow helper DSL
import { Workflow, Step, Trigger, AddIf, AddElse } from "@blokjs/helper";
import type { StepOpts, WorkflowOpts, NodeType, RuntimeKind } from "@blokjs/helper";
import type { HttpTriggerOpts, CronTriggerOpts, QueueTriggerOpts, WorkerTriggerOpts } from "@blokjs/helper";

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

- Use `$.state.<id>` (or `js/ctx.state.<id>`) to pass data between non-adjacent steps — every step default-stores its output there
- Opt out with `ephemeral: true` when a step is a side effect only
- Use Zod schemas for all input/output validation in defineNode
- Use `defineNode()` for all new nodes
- Use named exports for library code, `export default defineNode(...)` for node files
- Handle errors via GlobalError with appropriate HTTP status codes
- Keep nodes focused — one responsibility per node
- Test nodes with Vitest using mocked Context objects
