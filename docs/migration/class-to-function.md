---
title: "Migration: Class-Based to Function-First Nodes"
description: "Step-by-step guide for migrating from class-based BlokService nodes to function-first defineNode API"
---

# Migration: Class-Based to Function-First Nodes

This guide walks you through migrating existing class-based `BlokService` nodes to the new function-first `defineNode` API. The migration is fully backward-compatible -- both styles work side by side.

## Why Migrate?

| Benefit | Class-Based | Function-First |
|---|---|---|
| **Lines of code** | ~40-60 per node | ~15-25 per node |
| **Boilerplate** | constructor, handle(), schemas, response wrapper | Just `defineNode({...})` |
| **Type safety** | Manual JSON Schema | Zod schemas with full inference |
| **Input/output types** | `unknown` or manual cast | Fully inferred from Zod |
| **Validation** | JSON Schema (jsonschema lib) | Zod (runtime + compile-time) |
| **Error messages** | Generic validation errors | Detailed path-specific errors |
| **AI-friendliness** | Harder to generate correctly | Declarative, easy for LLMs |
| **Testability** | Must instantiate class, mock super() | Import and call `.execute()` |

## Before and After

### Before: Class-Based Node

```typescript
// nodes/fetch-user/index.ts
import BlokService from "@blokjs/runner/BlokService";
import BlokResponse from "@blokjs/runner/BlokResponse";
import type { IBlokResponse } from "@blokjs/runner/BlokResponse";
import type { Context } from "@blokjs/shared";
import { GlobalError } from "@blokjs/shared";
import type JsonLikeObject from "@blokjs/runner/types/JsonLikeObject";
import type Condition from "@blokjs/runner/types/Condition";

interface FetchUserInput {
  userId: string;
}

interface User {
  id: string;
  name: string;
  email: string;
}

export default class FetchUser extends BlokService<FetchUserInput> {
  constructor() {
    super();
    this.inputSchema = {
      type: "object",
      properties: {
        userId: { type: "string" },
      },
      required: ["userId"],
    };
    this.outputSchema = {
      type: "object",
      properties: {
        user: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            email: { type: "string" },
          },
        },
      },
    };
  }

  async handle(
    ctx: Context,
    inputs: FetchUserInput | JsonLikeObject | Condition[],
  ): Promise<IBlokResponse> {
    const response = new BlokResponse();

    try {
      const { userId } = inputs as FetchUserInput;

      const res = await fetch(`https://api.example.com/users/${userId}`);
      if (!res.ok) {
        throw new Error(`User not found: ${res.status}`);
      }

      const user: User = await res.json();
      response.setSuccess({ user } as unknown as JsonLikeObject);
    } catch (error) {
      const globalError = new GlobalError((error as Error).message);
      globalError.setCode(500);
      globalError.setName("FetchUser");
      response.setError(globalError);
    }

    return response;
  }
}
```

**Total: ~55 lines, 7 imports, manual type casting, no compile-time type safety on inputs/outputs.**

### After: Function-First Node

```typescript
// nodes/fetch-user/index.ts
import { defineNode } from "@blokjs/runner";
import { z } from "zod";

export default defineNode({
  name: "fetch-user",
  description: "Fetches a user by ID from the external API",

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
    // `input` is fully typed as { userId: string }
    const res = await fetch(`https://api.example.com/users/${input.userId}`);
    if (!res.ok) {
      throw new Error(`User not found: ${res.status}`);
    }

    const user = await res.json();
    // Return type is validated against the output schema
    return { user };
  },
});
```

**Total: ~25 lines, 2 imports, full type inference, automatic validation, automatic error mapping.**

## Step-by-Step Migration Process

### Step 1: Install Zod (if not already present)

```bash
npm install zod
```

### Step 2: Identify the Node to Migrate

Find the class-based node file. It will look like this:

```typescript
export default class MyNode extends BlokService<SomeType> {
  constructor() {
    super();
    this.inputSchema = { ... };
    this.outputSchema = { ... };
  }

  async handle(ctx, inputs): Promise<IBlokResponse> {
    // ...
  }
}
```

### Step 3: Convert JSON Schema to Zod Schema

Map your existing `inputSchema` and `outputSchema` from JSON Schema to Zod:

| JSON Schema | Zod Equivalent |
|---|---|
| `{ type: "string" }` | `z.string()` |
| `{ type: "number" }` | `z.number()` |
| `{ type: "boolean" }` | `z.boolean()` |
| `{ type: "integer" }` | `z.number().int()` |
| `{ type: "array", items: { type: "string" } }` | `z.array(z.string())` |
| `{ type: "object", properties: { ... } }` | `z.object({ ... })` |
| `{ enum: ["a", "b"] }` | `z.enum(["a", "b"])` |
| `{ type: "string", format: "email" }` | `z.string().email()` |
| `{ type: "string", format: "uuid" }` | `z.string().uuid()` |
| `{ type: "string", format: "url" }` | `z.string().url()` |
| `{ type: "string", minLength: 1 }` | `z.string().min(1)` |
| Required field | Included in `z.object()` (required by default) |
| Optional field | `z.string().optional()` |
| Nullable field | `z.string().nullable()` |

### Step 4: Extract the Core Logic from handle()

The `handle()` method typically follows this pattern:

```typescript
async handle(ctx, inputs) {
  const response = new BlokResponse();
  try {
    const typedInputs = inputs as MyInputType;    // <-- manual cast
    // ... core logic ...
    response.setSuccess(result);                   // <-- manual wrapping
  } catch (error) {
    const globalError = new GlobalError(...);       // <-- manual error
    response.setError(globalError);
  }
  return response;
}
```

With `defineNode`, the wrapping, validation, and error handling are all automatic. Extract just the core logic:

```typescript
async execute(ctx, input) {
  // input is already validated and typed
  // ... core logic ...
  return result;  // automatically validated and wrapped
}
```

### Step 5: Write the defineNode Call

```typescript
import { defineNode } from "@blokjs/runner";
import { z } from "zod";

export default defineNode({
  name: "my-node",          // Same name as before
  description: "What it does",

  input: z.object({
    // Converted from inputSchema
  }),

  output: z.object({
    // Converted from outputSchema
  }),

  async execute(ctx, input) {
    // Core logic from handle(), without try/catch boilerplate
    // Errors thrown here are automatically caught and mapped to GlobalError
  },
});
```

### Step 6: Remove Old Imports

Replace:
```typescript
import BlokService from "@blokjs/runner/BlokService";
import BlokResponse from "@blokjs/runner/BlokResponse";
import type { IBlokResponse } from "@blokjs/runner/BlokResponse";
import { GlobalError } from "@blokjs/shared";
import type JsonLikeObject from "@blokjs/runner/types/JsonLikeObject";
import type Condition from "@blokjs/runner/types/Condition";
```

With:
```typescript
import { defineNode } from "@blokjs/runner";
import { z } from "zod";
```

### Step 7: Test the Migrated Node

The node's external interface is unchanged. Existing workflow JSON files do not need modification. Run your existing tests to verify.

## Using the CLI Migration Command

The `blokctl` CLI provides an automated migration command:

```bash
# Migrate a single node
blokctl migrate node ./nodes/fetch-user/index.ts

# Migrate all nodes in a directory
blokctl migrate node ./nodes/ --recursive

# Preview changes without writing (dry run)
blokctl migrate node ./nodes/fetch-user/index.ts --dry-run

# Generate migration report
blokctl migrate node ./nodes/ --report
```

The CLI command performs:
1. Parses the existing class-based node
2. Extracts JSON Schema definitions
3. Converts JSON Schema to Zod schemas
4. Extracts core logic from `handle()`
5. Generates the `defineNode()` call
6. Writes the migrated file

## Common Patterns and Gotchas

### Pattern: Nodes That Set Variables

**Before (pre-v0.5):**
```typescript
async handle(ctx, inputs) {
  const response = new BlokResponse();
  const result = await doWork(inputs);

  // Legacy set_var on the workflow step routed result.data into ctx.vars
  if (this.set_var) {
    const vars = { [this.name]: result.data };
    this.setVar(ctx, vars);
    response.data = ctx.response || {};
  } else {
    response.setSuccess(result);
  }

  return response;
}
```

**After:**
```typescript
export default defineNode({
  // ...
  async execute(ctx, input) {
    // v2 default-stores result.data at ctx.state[<step-id>].
    // (The legacy `set_var` field was removed in v0.5 — drop it.)
    return await doWork(input);
  },
});
```

### Pattern: Conditional/Branching Nodes

**Before:**
```typescript
async handle(ctx, inputs) {
  const response = new BlokResponse();
  const conditions = inputs as Condition[];
  // ... evaluate conditions
  response.setSuccess(result);
  return response;
}
```

**After:**
```typescript
export default defineNode({
  name: "condition-node",
  description: "Evaluates conditions",

  input: z.array(z.object({
    field: z.string(),
    operator: z.enum(["eq", "ne", "gt", "lt"]),
    value: z.unknown(),
  })),

  output: z.object({
    matched: z.boolean(),
    branch: z.string(),
  }),

  async execute(ctx, conditions) {
    // conditions is typed as the array
    const matched = evaluateConditions(conditions);
    return { matched, branch: matched ? "then" : "else" };
  },
});
```

### Pattern: Custom Content Types

**Before:**
```typescript
async handle(ctx, inputs) {
  const response = new BlokResponse();
  this.contentType = "text/csv";
  response.setSuccess({ data: csvString });
  return response;
}
```

**After:**
```typescript
export default defineNode({
  // ...
  async execute(ctx, input) {
    // Set content type via context
    ctx.response.contentType = "text/csv";
    return { data: csvString };
  },
});
```

### Gotcha: Error Codes

With `defineNode`, errors thrown from `execute()` are automatically mapped to `GlobalError` with code `500`. If you need a specific HTTP status code, throw an error with a `code` property:

```typescript
async execute(ctx, input) {
  const user = await findUser(input.userId);
  if (!user) {
    const err = new Error("User not found");
    (err as any).code = 404;
    throw err;
  }
  return { user };
}
```

For Zod validation errors, the framework automatically returns code `400` (Bad Request) with detailed field-level error messages.

### Gotcha: Accessing Node Properties

In class-based nodes, you could access `this.name` and other framework-internal fields. In function-first nodes, these are managed internally by the `FunctionNode` wrapper. Access the node name from the definition itself:

```typescript
export default defineNode({
  name: "my-node",
  // ...
  async execute(ctx, input) {
    // Don't use `this.name` -- use the literal or ctx
    ctx.logger.log(`Processing in my-node`);
  },
});
```

### Gotcha: Multiple Return Types

Class-based `handle()` could return `IBlokResponse | BlokService<T>[]`. The `defineNode` API always expects a single return value matching the output schema. If you need to return multiple node instances (for fan-out), keep using the class-based approach for now.

## Backward Compatibility Guarantees

- **Workflow JSON**: No changes required. Both class-based and function-first nodes use the same workflow JSON format.
- **Node Map**: Both styles are registered identically in the node map.
- **Metrics**: Both styles emit the same OpenTelemetry metrics.
- **Side-by-side**: You can mix class-based and function-first nodes in the same workflow.
- **Runtime adapters**: `defineNode` works with all runtime adapters (NodeJS, Bun, etc.).
- **BlokService inheritance**: `FunctionNode` extends `BlokService`, so it is fully compatible with all existing runner infrastructure.

The class-based `BlokService` API is not deprecated. Both approaches are supported.

## See Also

- [Runtime Adapter System](/docs/architecture/runtime-adapters) -- how nodes execute across runtimes
- [Migration: Single to Multi-Runtime](/docs/migration/single-to-multi-runtime) -- adding multi-runtime support
- [Trigger System](/docs/architecture/trigger-system) -- how triggers invoke workflows containing nodes
