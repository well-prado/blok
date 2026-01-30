# Module Reference: defineNode (Function-First API)

> **File:** `core/runner/src/defineNode.ts`
> **Purpose:** Modern, declarative way to create nodes without class boilerplate

## What It Does

`defineNode` is the recommended way to create Blok nodes. Instead of extending `BlokService<T>` with class syntax, you define a node with a plain object: name, description, Zod input/output schemas, and an execute function.

Under the hood, `defineNode` wraps your function into a `FunctionNode` class that implements the full `BlokService` interface, maintaining 100% backward compatibility with the runner.

## API Signature

```typescript
import { z } from "zod";
import { defineNode } from "@blok/runner";

const MyNode = defineNode({
  // Required: unique node name
  name: "my-node",

  // Required: human-readable description
  description: "Does something useful",

  // Required: Zod schema for input validation
  input: z.object({
    userId: z.string().uuid(),
  }),

  // Required: Zod schema for output validation
  output: z.object({
    user: z.object({
      id: z.string(),
      name: z.string(),
    }),
  }),

  // Required: the business logic
  async execute(ctx, input) {
    // `input` is fully typed from the Zod schema
    // `ctx` is the Context object
    const user = await fetchUser(input.userId);

    // Store data for downstream nodes
    ctx.vars["current-user"] = user;

    // Return value is validated against the output schema
    return { user };
  },
});

export default MyNode;
```

## How It Works Internally

```
defineNode({ name, input, output, execute })
       │
       ▼
Creates FunctionNode extends BlokService<I>
       │
       ▼
FunctionNode.handle(ctx, rawInputs):
  1. Parse rawInputs through input Zod schema
  2. If validation fails → GlobalError with Zod error details
  3. Call execute(ctx, parsedInput)
  4. Parse result through output Zod schema
  5. If validation fails → GlobalError with details
  6. Return BlokResponse.success(parsedOutput)
```

## Source Files

| File | Purpose |
|------|---------|
| `core/runner/src/defineNode.ts` | Main implementation (~266 lines) |
| `core/runner/__tests__/unit/defineNode.test.ts` | Unit tests (~661 lines, comprehensive) |
| `core/runner/FUNCTION_FIRST_NODES.md` | Internal design doc (~937 lines) |
| `core/runner/examples/function-first/` | Example implementations |
| `templates/node-function/` | CLI scaffolding template |

## Examples

### Minimal Node
```typescript
import { z } from "zod";
import { defineNode } from "@blok/runner";

export default defineNode({
  name: "greet",
  description: "Returns a greeting",
  input: z.object({ name: z.string() }),
  output: z.object({ message: z.string() }),
  async execute(ctx, input) {
    return { message: `Hello, ${input.name}!` };
  },
});
```

### Node with Context Usage
```typescript
export default defineNode({
  name: "fetch-user",
  description: "Fetches user by ID from database",
  input: z.object({ userId: z.string().uuid() }),
  output: z.object({
    user: z.object({ id: z.string(), name: z.string(), email: z.string() }),
  }),
  async execute(ctx, input) {
    const db = ctx.env.DATABASE_URL;
    const user = await fetchFromDB(db, input.userId);
    ctx.vars["current-user"] = user;
    return { user };
  },
});
```

### Node with Error Handling
```typescript
export default defineNode({
  name: "validate-payment",
  description: "Validates payment details",
  input: z.object({
    amount: z.number().positive(),
    currency: z.string().length(3),
    cardToken: z.string(),
  }),
  output: z.object({ valid: z.boolean(), transactionId: z.string().optional() }),
  async execute(ctx, input) {
    if (input.amount > 10000) {
      throw new Error("Amount exceeds maximum limit");
    }
    const result = await processPayment(input);
    return { valid: true, transactionId: result.id };
  },
});
```

## Comparison: Function-First vs Class-Based

### Function-First (Recommended)
```typescript
// ~15 lines
export default defineNode({
  name: "greet",
  description: "Returns a greeting",
  input: z.object({ name: z.string() }),
  output: z.object({ message: z.string() }),
  async execute(ctx, input) {
    return { message: `Hello, ${input.name}!` };
  },
});
```

### Class-Based (Legacy)
```typescript
// ~40 lines
import { BlokService, BlokResponse, GlobalError } from "@blok/runner";
import { Context } from "@blok/shared";
import { IBlokResponse } from "@blok/runner";

interface GreetInput { name: string; }

export default class Greet extends BlokService<GreetInput> {
  constructor() { super(); }

  async handle(ctx: Context, inputs: GreetInput): Promise<IBlokResponse> {
    const response = new BlokResponse();
    try {
      if (!inputs.name) throw new GlobalError(400, "name required");
      response.setSuccess({ message: `Hello, ${inputs.name}!` });
    } catch (error) {
      response.setError(new GlobalError(500, error.message));
    }
    return response;
  }
}
```

**Result:** 60% less code, automatic validation, type-safe inputs/outputs.

## What to Document

1. **Complete API reference** for `defineNode()`
2. **Zod schema patterns** (strings, numbers, objects, arrays, unions, optionals)
3. **Context usage patterns** within execute functions
4. **Error handling** (thrown errors → GlobalError mapping)
5. **Migration guide** from class-based to function-first
6. **CLI template** (`blokctl create node --style=function`)
7. **Testing nodes** created with `defineNode`
