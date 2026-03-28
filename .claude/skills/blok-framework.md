# Blok Framework — Complete Development Guide

You are working with the **Blok Framework**, a TypeScript-first workflow orchestration system. It is NOT a standard application framework. You MUST understand its architecture before writing any code.

## CRITICAL: How Blok Works (Read This First)

Blok has TWO fundamental building blocks:

1. **Nodes** — Small, single-responsibility functions that do ONE thing (fetch data, validate input, transform data, call an API, etc.)
2. **Workflows** — Declarative pipelines that CHAIN nodes together in sequence, with conditional branching

**THE GOLDEN RULE: Nodes are NEVER imported inside other Nodes. Nodes are ALWAYS composed through Workflows.**

A Node does not know about other Nodes. A Node receives input, processes it, and returns output. The Workflow is what connects Node A's output to Node B's input. If you need Node A's result in Node B, you build a Workflow that runs A then B and passes data via context expressions.

```
WRONG:  Node A imports Node B and calls it directly
RIGHT:  Workflow runs Node A → passes output via js/ expression → Node B receives it as input
```

---

## Architecture Overview

```
                    Trigger (HTTP, Worker, Cron, gRPC, etc.)
                         |
                         v
                    Workflow Definition (TypeScript or JSON)
                         |
              +----------+----------+----------+
              |          |          |          |
              v          v          v          v
           Step 1     Step 2     Step 3     Step 4
          (Node A)   (Node B)   (Node C)   (Node D)
          module     module    runtime.go  runtime.python3
              |          |          |          |
              v          v          v          v
         In-process  In-process  Go SDK    Python SDK
         (Bun/Node)  (Bun/Node) (port 9001)(port 9007)
```

### Key Concepts

| Concept | What It Is | Where It Lives |
|---------|-----------|----------------|
| **Node** | A single-purpose function with typed input/output | `triggers/http/src/nodes/{category}/{name}/index.ts` |
| **Workflow** | A pipeline chaining nodes together | `triggers/http/src/workflows/{domain}/{name}.ts` |
| **Trigger** | The entry point that starts a workflow | HTTP, Worker, Cron, gRPC, WebSocket, SSE, Queue, PubSub, Webhook |
| **Context (ctx)** | The shared state object passed through every step | Created by trigger, flows through all nodes |
| **Runtime** | A language SDK server that executes non-TS nodes | Go(:9001), Rust(:9002), Java(:9003), C#(:9004), PHP(:9005), Ruby(:9006), Python3(:9007) |

---

## Part 1: Creating Nodes

### Always Use `defineNode()`

Every node MUST use the `defineNode()` function. NEVER create class-based nodes extending BlokService.

```typescript
import { defineNode } from "@blokjs/runner";
import { z } from "zod";

export default defineNode({
  name: "node-name",
  description: "What this node does",

  input: z.object({
    // ALL expected inputs with Zod types
  }),

  output: z.object({
    // EXACT shape of what execute() returns
  }),

  async execute(ctx, input) {
    // input is validated and type-safe
    // Return MUST match output schema
    return { /* matches output schema */ };
  },
});
```

### Node Rules

1. **One node = one responsibility.** A node that fetches users should NOT also format them.
2. **Never import other nodes.** If you need another node's logic, create a workflow that chains them.
3. **Never call external services AND process data in the same node.** Split into fetch + transform nodes.
4. **Always define both input and output Zod schemas.** No `any` types. Use `z.unknown()` for truly dynamic data.
5. **Always `export default defineNode(...)`.** This is the required pattern.
6. **Node name must be 5+ characters** and match what workflows reference.
7. **Errors should throw.** Thrown errors are auto-wrapped to GlobalError with 500 status.

### Node Organization — Category Folders

Organize nodes in category folders for clarity. Every node gets its own subfolder.

```
triggers/http/src/nodes/
├── auth/
│   ├── validate-token/
│   │   └── index.ts
│   └── check-permissions/
│       └── index.ts
├── users/
│   ├── fetch-user/
│   │   └── index.ts
│   ├── create-user/
│   │   └── index.ts
│   └── update-user/
│       └── index.ts
├── orders/
│   ├── validate-order/
│   │   └── index.ts
│   └── calculate-total/
│       └── index.ts
├── integrations/
│   ├── send-email/
│   │   └── index.ts
│   └── notify-slack/
│       └── index.ts
└── transforms/
    ├── format-response/
    │   └── index.ts
    └── merge-data/
        └── index.ts
```

**Category naming conventions:**
- `auth/` — Authentication and authorization
- `users/`, `orders/`, `products/` — Domain-specific CRUD
- `integrations/` — Third-party service calls
- `transforms/` — Data transformation and formatting
- `validation/` — Input validation and sanitization
- `db/` — Database operations
- `ai/` — AI/ML operations
- `files/` — File processing

### Registering Nodes

After creating a node, register it in `triggers/http/src/Nodes.ts`:

```typescript
import ApiCall from "@blokjs/api-call";
import IfElse from "@blokjs/if-else";
import type { BlokService } from "@blokjs/runner";

// Import your nodes by category
import ValidateToken from "./nodes/auth/validate-token/index";
import FetchUser from "./nodes/users/fetch-user/index";
import CreateUser from "./nodes/users/create-user/index";
import ValidateOrder from "./nodes/orders/validate-order/index";
import SendEmail from "./nodes/integrations/send-email/index";
import FormatResponse from "./nodes/transforms/format-response/index";

const nodes: Record<string, BlokService<unknown>> = {
  // Built-in nodes
  "@blokjs/api-call": ApiCall,
  "@blokjs/if-else": IfElse,

  // Auth nodes
  "validate-token": ValidateToken,

  // User nodes
  "fetch-user": FetchUser,
  "create-user": CreateUser,

  // Order nodes
  "validate-order": ValidateOrder,

  // Integration nodes
  "send-email": SendEmail,

  // Transform nodes
  "format-response": FormatResponse,
};

export default nodes;
```

### Bulk Registration Pattern

For categories with many nodes, use an index file:

```typescript
// triggers/http/src/nodes/users/index.ts
import FetchUser from "./fetch-user/index";
import CreateUser from "./create-user/index";
import UpdateUser from "./update-user/index";
import DeleteUser from "./delete-user/index";

export default {
  "fetch-user": FetchUser,
  "create-user": CreateUser,
  "update-user": UpdateUser,
  "delete-user": DeleteUser,
};
```

Then in Nodes.ts:
```typescript
import UserNodes from "./nodes/users/index";

const nodes: Record<string, BlokService<unknown>> = {
  "@blokjs/api-call": ApiCall,
  "@blokjs/if-else": IfElse,
  ...UserNodes,
};
```

### Complete Node Examples

**Simple data processing node:**

```typescript
import { defineNode } from "@blokjs/runner";
import { z } from "zod";

export default defineNode({
  name: "calculate-order-total",
  description: "Calculates order total with tax and discount",

  input: z.object({
    items: z.array(z.object({
      price: z.number(),
      quantity: z.number(),
    })),
    taxRate: z.number().default(0.1),
    discountPercent: z.number().default(0),
  }),

  output: z.object({
    subtotal: z.number(),
    tax: z.number(),
    discount: z.number(),
    total: z.number(),
  }),

  async execute(ctx, input) {
    const subtotal = input.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const discount = subtotal * (input.discountPercent / 100);
    const taxable = subtotal - discount;
    const tax = taxable * input.taxRate;
    const total = taxable + tax;

    return { subtotal, tax, discount, total };
  },
});
```

**Node that uses context for logging:**

```typescript
import { defineNode } from "@blokjs/runner";
import { z } from "zod";

export default defineNode({
  name: "fetch-user-profile",
  description: "Fetches a user profile from the database",

  input: z.object({
    userId: z.string().uuid(),
  }),

  output: z.object({
    user: z.object({
      id: z.string(),
      name: z.string(),
      email: z.string(),
    }),
  }),

  async execute(ctx, input) {
    ctx.logger.log(`Fetching user: ${input.userId}`);

    // Your database call here
    const user = await db.users.findById(input.userId);

    if (!user) {
      throw new Error(`User not found: ${input.userId}`);
    }

    return { user: { id: user.id, name: user.name, email: user.email } };
  },
});
```

**Node with optional inputs and defaults:**

```typescript
import { defineNode } from "@blokjs/runner";
import { z } from "zod";

export default defineNode({
  name: "paginate-results",
  description: "Applies pagination to a list of items",

  input: z.object({
    items: z.array(z.unknown()),
    page: z.number().int().positive().default(1),
    pageSize: z.number().int().positive().max(100).default(20),
  }),

  output: z.object({
    data: z.array(z.unknown()),
    pagination: z.object({
      page: z.number(),
      pageSize: z.number(),
      total: z.number(),
      totalPages: z.number(),
    }),
  }),

  async execute(ctx, input) {
    const start = (input.page - 1) * input.pageSize;
    const data = input.items.slice(start, start + input.pageSize);
    const total = input.items.length;

    return {
      data,
      pagination: {
        page: input.page,
        pageSize: input.pageSize,
        total,
        totalPages: Math.ceil(total / input.pageSize),
      },
    };
  },
});
```

---

## Part 2: Creating TypeScript Workflows (Preferred)

TypeScript workflows live in `triggers/http/src/workflows/` organized by domain.

### Workflow File Structure

```
triggers/http/src/workflows/
├── users/
│   ├── create-user.ts
│   ├── get-user.ts
│   └── list-users.ts
├── orders/
│   ├── create-order.ts
│   └── process-payment.ts
├── admin/
│   └── dashboard-stats.ts
└── health/
    └── health-check.ts
```

### Simple Workflow

```typescript
import { type Step, Workflow } from "@blokjs/helper";

const step: Step = Workflow({
  name: "Get User Profile",
  version: "1.0.0",
  description: "Fetches a user profile by ID",
})
  .addTrigger("http", {
    method: "GET",
    path: "/users/:id",
    accept: "application/json",
  })
  .addStep({
    name: "fetch-user",
    node: "fetch-user-profile",
    type: "module",
    inputs: {
      userId: "js/ctx.request.params.id",
    },
  });

export default step;
```

### Multi-Step Workflow with Data Flow

```typescript
import { type Step, Workflow } from "@blokjs/helper";

const step: Step = Workflow({
  name: "Create Order",
  version: "1.0.0",
  description: "Validates and creates a new order",
})
  .addTrigger("http", {
    method: "POST",
    path: "/orders",
    accept: "application/json",
  })
  // Step 1: Validate the incoming order data
  .addStep({
    name: "validate",
    node: "validate-order",
    type: "module",
    inputs: {
      order: "js/ctx.request.body",
    },
  })
  // Step 2: Calculate totals — uses Step 1's output via ctx.response.data
  .addStep({
    name: "calculate",
    node: "calculate-order-total",
    type: "module",
    inputs: {
      items: "js/ctx.response.data.items",
      taxRate: 0.08,
    },
  })
  // Step 3: Save to database — uses Step 2's output
  .addStep({
    name: "save-order",
    node: "save-to-db",
    type: "module",
    inputs: {
      data: "js/ctx.response.data",
    },
  })
  // Step 4: Send confirmation email — uses Step 3's output
  .addStep({
    name: "send-confirmation",
    node: "send-email",
    type: "module",
    inputs: {
      to: "js/ctx.response.data.customerEmail",
      subject: "Order Confirmed",
      template: "order-confirmation",
      data: "js/ctx.response.data",
    },
  });

export default step;
```

### Conditional Workflow (if-else)

```typescript
import { AddElse, AddIf, type Step, Workflow } from "@blokjs/helper";

const step: Step = Workflow({
  name: "Route Request",
  version: "1.0.0",
})
  .addTrigger("http", {
    method: "ANY",
    path: "/api/route",
    accept: "application/json",
  })
  .addCondition({
    node: {
      name: "router",
      node: "@blokjs/if-else",
      type: "module",
    },
    conditions: () => [
      new AddIf('ctx.request.query.action === "create"')
        .addStep({
          name: "create-item",
          node: "create-item",
          type: "module",
          inputs: { data: "js/ctx.request.body" },
        })
        .build(),
      new AddIf('ctx.request.query.action === "update"')
        .addStep({
          name: "update-item",
          node: "update-item",
          type: "module",
          inputs: { id: "js/ctx.request.query.id", data: "js/ctx.request.body" },
        })
        .build(),
      new AddElse()
        .addStep({
          name: "list-items",
          node: "list-items",
          type: "module",
          inputs: {
            page: "js/parseInt(ctx.request.query.page || '1')",
            limit: "js/parseInt(ctx.request.query.limit || '20')",
          },
        })
        .build(),
    ],
  });

export default step;
```

### Cross-Runtime Workflow

Use nodes written in different languages within the same workflow:

```typescript
import { type Step, Workflow } from "@blokjs/helper";

const step: Step = Workflow({
  name: "ML Pipeline",
  version: "1.0.0",
  description: "Process data through multiple language runtimes",
})
  .addTrigger("http", {
    method: "POST",
    path: "/ml/predict",
    accept: "application/json",
  })
  // Step 1: Validate input (TypeScript — in-process)
  .addStep({
    name: "validate",
    node: "validate-ml-input",
    type: "module",
    inputs: { data: "js/ctx.request.body" },
  })
  // Step 2: Preprocess with Python (port 9007)
  .addStep({
    name: "preprocess",
    node: "data-preprocessor",
    type: "runtime.python3",
    inputs: { rawData: "js/ctx.response.data" },
  })
  // Step 3: Run inference with Rust (port 9002)
  .addStep({
    name: "inference",
    node: "ml-inference",
    type: "runtime.rust",
    inputs: { processedData: "js/ctx.response.data" },
  })
  // Step 4: Format response (TypeScript)
  .addStep({
    name: "format",
    node: "format-response",
    type: "module",
    inputs: { prediction: "js/ctx.response.data" },
  });

export default step;
```

### Registering Workflows

Every workflow MUST be registered in `triggers/http/src/Workflows.ts`:

```typescript
import type Workflows from "./runner/types/Workflows";
// Import by domain
import createUser from "./workflows/users/create-user";
import getUser from "./workflows/users/get-user";
import listUsers from "./workflows/users/list-users";
import createOrder from "./workflows/orders/create-order";
import healthCheck from "./workflows/health/health-check";

const workflows: Workflows = {
  "create-user": createUser,
  "get-user": getUser,
  "list-users": listUsers,
  "create-order": createOrder,
  "health-check": healthCheck,
};

export default workflows;
```

The key (e.g., `"create-user"`) becomes the route identifier in the URL.

---

## Part 3: Context (ctx) — How Data Flows Between Steps

This is the MOST important concept. Understanding context is essential to building working workflows.

### The Context Object

```typescript
type Context = {
  id: string;                    // Unique request ID (UUID)
  workflow_name?: string;        // Name of the executing workflow
  request: {                     // IMMUTABLE — set by trigger, never changes
    method: string;              // HTTP method
    path: string;                // URL path
    url: string;                 // Full URL
    body: object;                // Request body (parsed JSON/form)
    headers: object;             // Request headers
    params: object;              // Path params (e.g., :id from /users/:id)
    query: object;               // Query string params (?key=value)
  };
  response: {                    // OVERWRITTEN after EVERY step
    data: unknown;               // Current step's output
    success: boolean;
    error: unknown;
    contentType?: string;
  };
  vars?: {                       // PERSISTS across entire workflow
    [stepName: string]: unknown; // Stored outputs from previous steps
  };
  logger: LoggerContext;         // Logging methods
  env?: object;                  // process.env
};
```

### The Three Critical Rules

**Rule 1: `ctx.request` is IMMUTABLE.** It is set once by the trigger and never changes. Every step can always read the original request.

**Rule 2: `ctx.response.data` is OVERWRITTEN after EVERY step.** After Step 2 runs, Step 1's output is GONE from `ctx.response.data`. You can ONLY read the immediately previous step's output from `ctx.response.data`.

**Rule 3: `ctx.vars` PERSISTS across the entire workflow.** Once data is stored in `ctx.vars`, it stays there for all subsequent steps.

### How Data Flows — Visual Model

```
HTTP POST /orders { items: [...], customer: "alice" }
                   |
                   v
        ctx.request.body = { items: [...], customer: "alice" }
        ctx.response.data = null
        ctx.vars = {}
                   |
    +--------------+------------------+
    |              Step 1: validate   |
    |  input: js/ctx.request.body     |
    |  output: { valid: true, ... }   |
    +--------------+------------------+
                   |
        ctx.request.body = { items: [...], customer: "alice" }  // UNCHANGED
        ctx.response.data = { valid: true, ... }                // Step 1 output
        ctx.vars = {}
                   |
    +--------------+------------------+
    |              Step 2: calculate  |
    |  input: js/ctx.response.data    |
    |  output: { total: 99.50 }       |
    +--------------+------------------+
                   |
        ctx.request.body = { items: [...], customer: "alice" }  // UNCHANGED
        ctx.response.data = { total: 99.50 }                    // Step 2 output
        ctx.vars = {}
        // Step 1 output is GONE from ctx.response.data!
                   |
    +--------------+------------------+
    |              Step 3: save       |
    |  input: js/ctx.response.data    |  // Gets Step 2 output
    |  CANNOT access Step 1 output!   |
    +--------------+------------------+
```

### Accessing Data Between Steps

**Adjacent steps (Step N reads Step N-1):**
```typescript
// In workflow .addStep():
inputs: {
  data: "js/ctx.response.data",                // Entire previous output
  total: "js/ctx.response.data.total",          // Specific field
  name: "js/ctx.response.data.user.name",       // Nested field
}
```

**Original request (any step can read):**
```typescript
inputs: {
  body: "js/ctx.request.body",                  // Full request body
  userId: "js/ctx.request.params.id",           // Path parameter
  page: "js/ctx.request.query.page",            // Query parameter
  token: "js/ctx.request.headers.authorization", // Header
  method: "js/ctx.request.method",              // HTTP method
}
```

**Non-adjacent steps (Step 3 needs Step 1's output):**

For TypeScript workflows, the current `addStep()` builder does NOT support `set_var`. Instead, use one of these patterns:

**Pattern A: Return what you need from each step (recommended for TS workflows)**

Design your nodes so that each step returns everything the next step needs. If Step 3 needs data from both Step 1 and Step 2, make Step 2 receive Step 1's data and return a merged result.

```typescript
// Step 2 node (merge-data) receives both sources and returns combined
export default defineNode({
  name: "merge-data",
  description: "Combines user data with order data",
  input: z.object({
    userData: z.object({ id: z.string(), name: z.string() }),
    orderData: z.object({ items: z.array(z.unknown()) }),
  }),
  output: z.object({
    userId: z.string(),
    userName: z.string(),
    items: z.array(z.unknown()),
  }),
  async execute(ctx, input) {
    return {
      userId: input.userData.id,
      userName: input.userData.name,
      items: input.orderData.items,
    };
  },
});
```

**Pattern B: Use `ctx.vars` directly inside node execute() (for complex cases)**

Nodes have full access to `ctx` in their execute function. A node can read `ctx.vars` directly if previous steps stored data there. However, note that in TS workflows, automatic `set_var` is not available through the builder. Runtime nodes (Go, Rust, Python, etc.) automatically store their output in `ctx.vars[stepName]` — this is built into RuntimeAdapterNode.

**Pattern C: Use JSON workflows when you need `set_var`**

If you need `set_var: true` to persist step outputs across non-adjacent steps, use JSON workflows:

```json
{
  "steps": [
    { "name": "step-1", "node": "fetch-user", "type": "module", "set_var": true },
    { "name": "step-2", "node": "fetch-orders", "type": "module", "set_var": true },
    { "name": "step-3", "node": "generate-report", "type": "module" }
  ],
  "nodes": {
    "step-3": {
      "inputs": {
        "user": "js/ctx.vars['step-1']",
        "orders": "js/ctx.vars['step-2']"
      }
    }
  }
}
```

### Runtime Nodes and ctx.vars

Important: When using `runtime.*` step types (Go, Rust, Python, etc.), the RuntimeAdapterNode **automatically** stores the step output in `ctx.vars[stepName]`. This means you can always access runtime node outputs via `js/ctx.vars['step-name']` in subsequent steps without needing `set_var`.

### Available `js/` Expressions

The Blueprint Mapper resolves `js/` expressions BEFORE the node executes. The node receives already-resolved values.

```typescript
// Direct access
"js/ctx.request.body"                     // Request body object
"js/ctx.request.body.email"               // Nested property
"js/ctx.response.data"                    // Previous step output
"js/ctx.response.data.users[0].name"      // Array access
"js/ctx.vars['step-name']"               // Stored step output
"js/ctx.vars['step-name'].field"          // Nested var access

// JavaScript operations
"js/ctx.request.body.items.length"         // Array length
"js/parseInt(ctx.request.query.page || '1')"  // Parse with default
"js/JSON.stringify(ctx.vars['data'])"      // Stringify
"js/Object.keys(ctx.request.body)"         // Object methods
"js/ctx.request.body.items.map(i => i.id)" // Array methods
"js/Date.now()"                            // Current timestamp
"js/ctx.request.query.type === 'admin'"    // Boolean expression

// Ternary and logic
"js/ctx.request.body.discount ? ctx.request.body.discount : 0"
"js/ctx.vars['auth'] && ctx.vars['auth'].isAdmin"

// Static values (no js/ prefix)
"hello"                                    // String literal
42                                         // Number literal
true                                       // Boolean literal
```

---

## Part 4: Multi-Language Runtime System

Blok supports 8 language runtimes. TypeScript nodes run in-process. All other languages run as HTTP servers.

### Runtime Ports

| Runtime | Port | Step Type | Node Location |
|---------|------|-----------|---------------|
| TypeScript | In-process | `module` or `local` | `triggers/http/src/nodes/` |
| Go | 9001 | `runtime.go` | `runtimes/go/nodes/` |
| Rust | 9002 | `runtime.rust` | `runtimes/rust/nodes/` (src/) |
| Java | 9003 | `runtime.java` | `runtimes/java/nodes/` |
| C# | 9004 | `runtime.csharp` | `runtimes/csharp/nodes/` |
| PHP | 9005 | `runtime.php` | `runtimes/php/nodes/` |
| Ruby | 9006 | `runtime.ruby` | `runtimes/ruby/nodes/` |
| Python3 | 9007 | `runtime.python3` | `runtimes/python3/nodes/` |

### How Runtime Nodes Work

1. TypeScript runner resolves `type: "runtime.go"` to the Go HttpRuntimeAdapter
2. Adapter sends HTTP POST to `http://localhost:9001/execute` with node name and inputs
3. Go SDK finds the registered node handler, executes it, returns result
4. Runner receives result, stores it in `ctx.vars[stepName]` and `ctx.response.data`

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

### Using Runtime Nodes in Workflows

```typescript
.addStep({
  name: "process-data",
  node: "my-go-node",       // Node name registered in Go SDK
  type: "runtime.go",       // Routes to Go runtime
  inputs: {
    data: "js/ctx.request.body",
  },
})
.addStep({
  name: "analyze",
  node: "sentiment-analysis",
  type: "runtime.python3",   // Routes to Python runtime
  inputs: {
    text: "js/ctx.response.data.processedText",
  },
})
```

### Go Node Example

```go
// runtimes/go/nodes/my_node.go
package nodes

import blok "blok-runtime"

func MyGoNode(ctx *blok.Context, input map[string]interface{}) (*blok.ExecutionResult, error) {
    data := input["data"]
    // Process data...
    return &blok.ExecutionResult{
        Success: true,
        Data:    map[string]interface{}{"result": processed},
    }, nil
}

// Register in main.go
registry.Register("my-go-node", MyGoNode)
```

### Python Node Example

```python
# runtimes/python3/nodes/my_node/node.py
from core.blok import NanoService

class MyPythonNode(NanoService):
    async def handle(self, ctx, inputs):
        data = inputs.get("data")
        # Process data...
        response = self.create_response()
        response.setSuccess({"result": processed})
        return response
```

### Rust Node Example

```rust
// runtimes/rust/src/nodes/my_node.rs
use blok_runtime::{Context, ExecutionResult, NodeHandler};

pub struct MyRustNode;

impl NodeHandler for MyRustNode {
    async fn execute(&self, ctx: &Context, input: serde_json::Value) -> ExecutionResult {
        let data = input.get("data");
        // Process data...
        ExecutionResult::success(json!({"result": processed}))
    }
}
```

---

## Part 5: CLI Commands (blokctl)

### Project Scaffolding

```bash
# Create new project with specific runtimes and triggers
blokctl create project my-app \
  -r go,python3,rust \           # Include Go, Python3, and Rust runtimes
  -T http \                       # HTTP trigger
  -m bun                          # Package manager

# Create in current directory
blokctl create project . -r go -T http -m bun

# Scaffold a new node
blokctl create node my-node \
  -s function \                   # function (defineNode) or class
  -r typescript                   # typescript, python3, go, java, rust, csharp, php, ruby

# Scaffold a new workflow
blokctl create workflow my-workflow
```

### Development

```bash
# Start full dev server (all runtimes + HTTP trigger)
blokctl dev

# Open Blok Studio (trace visualization UI)
blokctl trace
```

### What `blokctl dev` Does

1. Reads `.blok/config.json` for runtime and trigger configurations
2. Spawns each runtime process (Go, Python, Rust, etc.) as child processes
3. Health-checks each runtime by polling `GET /health` (up to 120s timeout)
4. Once all runtimes are healthy, starts the trigger (HTTP server on port 4000)
5. Monitors all processes, gracefully shuts down on SIGINT/SIGTERM

### Project Structure After `blokctl create project`

```
my-project/
├── .blok/
│   ├── config.json                 # Runtime & trigger config
│   └── runtimes/
│       ├── go/                     # Go SDK (auto-managed)
│       ├── python3/                # Python SDK (auto-managed)
│       └── rust/                   # Rust SDK (auto-managed)
├── runtimes/
│   ├── go/nodes/                   # YOUR Go nodes go here
│   ├── python3/nodes/              # YOUR Python nodes go here
│   └── rust/nodes/                 # YOUR Rust nodes go here
├── triggers/
│   └── http/
│       ├── src/
│       │   ├── index.ts            # Entry point
│       │   ├── Nodes.ts            # Node registry
│       │   ├── Workflows.ts        # Workflow registry
│       │   ├── nodes/              # YOUR TypeScript nodes
│       │   │   └── {category}/
│       │   │       └── {name}/
│       │   │           └── index.ts
│       │   └── workflows/          # YOUR TypeScript workflows
│       │       └── {domain}/
│       │           └── {name}.ts
│       └── workflows/
│           └── json/               # JSON workflows (alternative)
├── package.json
├── tsconfig.json
└── biome.json
```

---

## Part 6: Worker Workflows (Background Jobs)

Workers process jobs from a queue instead of HTTP requests.

```typescript
import { type Step, Workflow } from "@blokjs/helper";

const step: Step = Workflow({
  name: "Process Background Job",
  version: "1.0.0",
})
  .addTrigger("worker", {
    queue: "background-jobs",
    concurrency: 5,           // Max concurrent jobs
    retries: 3,               // Max retry attempts
    timeout: 30000,           // Job timeout in ms
  })
  .addStep({
    name: "process",
    node: "job-processor",
    type: "module",
    inputs: {
      payload: "js/ctx.request.body",           // Job data
      jobId: "js/ctx.request.params.jobId",     // Job ID
      attempt: "js/ctx.request.params.attempt",  // Current attempt (0-based)
      queue: "js/ctx.request.params.queue",      // Queue name
    },
  });

export default step;
```

### Worker Context Mapping

| Context Property | Worker Value |
|-----------------|-------------|
| `ctx.request.body` | Job payload data |
| `ctx.request.params.queue` | Queue name |
| `ctx.request.params.jobId` | Unique job ID |
| `ctx.request.params.attempt` | Current attempt (0-based) |
| `ctx.vars._worker_job` | Full job metadata |

### Worker Adapters

| Adapter | Backend | Best For |
|---------|---------|----------|
| NATSWorkerAdapter | NATS JetStream | Production (durable, distributed) |
| BullMQAdapter | Redis via BullMQ | Priority queues, delayed jobs |
| InMemoryAdapter | In-process | Development/testing only |

### Standalone Workers (Go/Rust/Python)

These SDKs can run as standalone NATS workers without the TypeScript runner:

```go
// Go standalone worker
func main() {
    registry := blok.NewNodeRegistry("1.0.0")
    registry.Register("process-order", processOrderNode)

    config := blok.LoadWorkerConfigFromEnv()
    worker := blok.NewWorker(registry, config)
    worker.HandleNode("orders", "process-order")
    worker.Start(context.Background())
}
```

```python
# Python standalone worker
from blok import NodeRegistry, listen_and_serve_worker

registry = NodeRegistry("1.0.0")
registry.register("process-order", process_order_node)
listen_and_serve_worker(registry)
```

```rust
// Rust standalone worker
let mut registry = NodeRegistry::new("1.0.0");
registry.register("process-order", process_order_node);
let config = WorkerConfig::from_env();
let mut worker = Worker::new(registry, config);
worker.handle_node("orders", "process-order");
worker.start().await?;
```

Worker environment variables:
```
NATS_SERVERS=localhost:4222
NATS_STREAM_NAME=blok-worker
WORKER_CONCURRENCY=1
WORKER_MAX_RETRIES=3
WORKER_ACK_WAIT_SECS=30
WORKER_QUEUES=queue1,queue2
```

---

## Part 7: Trigger Types

| Trigger | Key Config | Context Mapping |
|---------|-----------|-----------------|
| `http` | method, path, accept | `ctx.request.body`, `.query`, `.params`, `.headers` |
| `worker` | queue, concurrency, retries | `ctx.request.body` (job payload), `.params.jobId` |
| `cron` | schedule, timezone | `ctx.request.body` (schedule payload) |
| `queue` | provider, topic, consumerGroup | `ctx.request.body` (message) |
| `pubsub` | provider, topic, subscription | `ctx.request.body` (message) |
| `grpc` | service, method, proto | `ctx.request.body` (proto message) |
| `webhook` | source, events, secret | `ctx.request.body` (webhook payload) |
| `websocket` | events, path | `ctx.request.body` (message data) |
| `sse` | events, channels, path | `ctx.request.body` (event data) |

---

## Part 8: Testing

### Unit Test a Node

```typescript
import { NodeTestHarness } from "@blokjs/runner";
import myNode from "../src/nodes/users/fetch-user/index";

const harness = new NodeTestHarness(myNode);

test("fetches user successfully", async () => {
  const result = await harness.execute({ userId: "abc-123" });
  harness.assertSuccess(result);
  harness.assertOutput(result, { user: { id: "abc-123" } });
});

test("fails with invalid UUID", async () => {
  const result = await harness.execute({ userId: "not-a-uuid" });
  harness.assertError(result, /validation/i);
});
```

### Integration Test a Workflow

```typescript
import { WorkflowTestRunner } from "@blokjs/runner";

const runner = new WorkflowTestRunner({ verbose: true, mockAllNodes: true });

runner.registerNode("validate", ValidateNode);
runner.mockNode("external-api", async (input) => ({ result: "mocked" }));

runner.loadWorkflow(myWorkflowDefinition);
const result = await runner.execute({ input: "data" });
expect(result.success).toBe(true);
expect(result.trace).toHaveLength(2);
```

---

## Part 9: Complete Example — Building a Feature

**Task: Build a user registration system**

### Step 1: Create the Nodes (each in its own category folder)

**`triggers/http/src/nodes/validation/validate-registration/index.ts`:**
```typescript
import { defineNode } from "@blokjs/runner";
import { z } from "zod";

export default defineNode({
  name: "validate-registration",
  description: "Validates user registration data",
  input: z.object({
    email: z.string().email(),
    password: z.string().min(8),
    name: z.string().min(2),
  }),
  output: z.object({
    email: z.string(),
    password: z.string(),
    name: z.string(),
    valid: z.literal(true),
  }),
  async execute(ctx, input) {
    return { ...input, valid: true as const };
  },
});
```

**`triggers/http/src/nodes/users/create-user-record/index.ts`:**
```typescript
import { defineNode } from "@blokjs/runner";
import { z } from "zod";

export default defineNode({
  name: "create-user-record",
  description: "Creates a user record in the database",
  input: z.object({
    email: z.string().email(),
    password: z.string(),
    name: z.string(),
  }),
  output: z.object({
    id: z.string(),
    email: z.string(),
    name: z.string(),
    createdAt: z.string(),
  }),
  async execute(ctx, input) {
    // Database call here
    const user = { id: crypto.randomUUID(), email: input.email, name: input.name, createdAt: new Date().toISOString() };
    return user;
  },
});
```

**`triggers/http/src/nodes/integrations/send-welcome-email/index.ts`:**
```typescript
import { defineNode } from "@blokjs/runner";
import { z } from "zod";

export default defineNode({
  name: "send-welcome-email",
  description: "Sends a welcome email to a new user",
  input: z.object({
    email: z.string().email(),
    name: z.string(),
  }),
  output: z.object({
    sent: z.boolean(),
    messageId: z.string(),
  }),
  async execute(ctx, input) {
    // Email service call here
    return { sent: true, messageId: crypto.randomUUID() };
  },
});
```

### Step 2: Register Nodes in `Nodes.ts`

```typescript
import ValidateRegistration from "./nodes/validation/validate-registration/index";
import CreateUserRecord from "./nodes/users/create-user-record/index";
import SendWelcomeEmail from "./nodes/integrations/send-welcome-email/index";

const nodes: Record<string, BlokService<unknown>> = {
  // ... existing nodes
  "validate-registration": ValidateRegistration,
  "create-user-record": CreateUserRecord,
  "send-welcome-email": SendWelcomeEmail,
};
```

### Step 3: Create the Workflow

**`triggers/http/src/workflows/users/register-user.ts`:**
```typescript
import { type Step, Workflow } from "@blokjs/helper";

const step: Step = Workflow({
  name: "Register User",
  version: "1.0.0",
  description: "Validates input, creates user, sends welcome email",
})
  .addTrigger("http", {
    method: "POST",
    path: "/users/register",
    accept: "application/json",
  })
  .addStep({
    name: "validate",
    node: "validate-registration",
    type: "module",
    inputs: {
      email: "js/ctx.request.body.email",
      password: "js/ctx.request.body.password",
      name: "js/ctx.request.body.name",
    },
  })
  .addStep({
    name: "create-user",
    node: "create-user-record",
    type: "module",
    inputs: {
      email: "js/ctx.response.data.email",
      password: "js/ctx.response.data.password",
      name: "js/ctx.response.data.name",
    },
  })
  .addStep({
    name: "welcome-email",
    node: "send-welcome-email",
    type: "module",
    inputs: {
      email: "js/ctx.response.data.email",
      name: "js/ctx.response.data.name",
    },
  });

export default step;
```

### Step 4: Register the Workflow

```typescript
// triggers/http/src/Workflows.ts
import registerUser from "./workflows/users/register-user";

const workflows: Workflows = {
  // ... existing workflows
  "register-user": registerUser,
};
```

---

## Common Mistakes to Avoid

### NEVER import nodes inside other nodes

```typescript
// WRONG — DO NOT DO THIS
import FetchUser from "../users/fetch-user/index";

export default defineNode({
  name: "get-user-orders",
  async execute(ctx, input) {
    const user = await FetchUser.handle(ctx, { userId: input.userId }); // WRONG!
    // ...
  },
});

// RIGHT — Use a workflow to chain them
// Workflow: fetch-user → get-user-orders (receives user data via ctx.response.data)
```

### NEVER forget to register nodes and workflows

Every new node → add to `Nodes.ts`
Every new workflow → add to `Workflows.ts`

### NEVER assume ctx.response.data persists beyond the next step

```typescript
// WRONG — Step 3 trying to read Step 1's output from ctx.response.data
.addStep({ name: "step-1", node: "a", type: "module", inputs: {...} })
.addStep({ name: "step-2", node: "b", type: "module", inputs: {...} })
.addStep({ name: "step-3", node: "c", type: "module", inputs: {
  step1Data: "js/ctx.response.data",  // This is Step 2's data, NOT Step 1's!
}})

// RIGHT — Design Step 2 to pass through what Step 3 needs
// Or use JSON workflow with set_var: true
```

### NEVER use class-based nodes

```typescript
// WRONG
class MyNode extends BlokService<MyInput> {
  async handle(ctx: Context, inputs: MyInput): Promise<BlokResponse> { ... }
}

// RIGHT
export default defineNode({
  name: "my-node",
  input: z.object({ ... }),
  output: z.object({ ... }),
  async execute(ctx, input) { ... },
});
```

### NEVER use `any` types

```typescript
// WRONG
input: z.object({ data: z.any() })

// RIGHT
input: z.object({ data: z.unknown() })
// Or better yet, define the actual shape:
input: z.object({ data: z.object({ id: z.string(), name: z.string() }) })
```

### NEVER use ESLint/Prettier

This project uses **Biome** for linting and formatting. Run `bun run lint`.

### NEVER edit files in `.blok/runtimes/`

These are auto-generated SDK files. Your runtime nodes go in `runtimes/{language}/nodes/`.

---

## Quick Reference: Workflow Builder API

```
Workflow({ name, version, description? })
  .addTrigger("http", { method, path, accept, headers? })
  .addStep({ name, node, type, inputs?, runtime? })          // Chainable
  .addStep({ ... })                                           // Add more steps
  .addCondition({
    node: { name, node: "@blokjs/if-else", type: "module" },
    conditions: () => [
      new AddIf("js expression")
        .addStep({ ... })
        .build(),
      new AddElse()
        .addStep({ ... })
        .build(),
    ],
  })
```

### Trigger Methods

| Method | Description |
|--------|-------------|
| `"GET"` | Read resource |
| `"POST"` | Create resource |
| `"PUT"` | Replace resource |
| `"PATCH"` | Update resource |
| `"DELETE"` | Delete resource |
| `"ANY"` | Match all methods (use `"ANY"`, not `"*"`) |

### Step Types

| Type | Description |
|------|-------------|
| `"module"` | TypeScript node registered in Nodes.ts |
| `"local"` | TypeScript node loaded from filesystem |
| `"runtime.go"` | Go node (port 9001) |
| `"runtime.rust"` | Rust node (port 9002) |
| `"runtime.java"` | Java node (port 9003) |
| `"runtime.csharp"` | C# node (port 9004) |
| `"runtime.php"` | PHP node (port 9005) |
| `"runtime.ruby"` | Ruby node (port 9006) |
| `"runtime.python3"` | Python3 node (port 9007) |

---

## Debugging Checklist

1. **"Node not found"** → Is the node registered in `Nodes.ts`?
2. **"Validation failed"** → Check Zod schema vs actual input data
3. **"undefined in step input"** → Are you reading `ctx.response.data` from a non-adjacent step? It's overwritten.
4. **"Runtime execution error"** → Is the runtime process running? Check `GET http://localhost:{port}/health`
5. **"ctx.vars['X'] is undefined"** → Did you use `set_var: true`? Is this a TS workflow (doesn't support set_var in builder)?
6. **No data flowing between steps** → Check `js/` expression syntax. Common: missing quotes around step name in `ctx.vars['name']`
7. **Condition not matching** → Check condition string syntax. Must be valid JS with access to `ctx`.
