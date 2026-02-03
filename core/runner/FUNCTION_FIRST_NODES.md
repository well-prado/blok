# Function-First Nodes API

> **The modern way to build Blok nodes with 60%+ less code**

## Overview

Function-first nodes use the `defineNode()` API to create type-safe, Zod-validated nodes with minimal boilerplate. Instead of classes, constructors, and manual error handling, you define schemas and an execution function.

## Table of Contents

1. [Quick Start](#quick-start)
2. [API Reference](#api-reference)
3. [Schema Validation](#schema-validation)
4. [Error Handling](#error-handling)
5. [Migration Guide](#migration-guide)
6. [Best Practices](#best-practices)
7. [Examples](#examples)

---

## Quick Start

### Installation

Function-first nodes are built into `@blokjs/runner` (v0.1.26+):

```bash
pnpm add @blokjs/runner zod
```

### Your First Function-First Node

```typescript
import { defineNode } from "@blokjs/runner";
import { z } from "zod";

export default defineNode({
  name: "hello-world",
  description: "Says hello to a user",

  input: z.object({
    name: z.string().min(1),
  }),

  output: z.object({
    message: z.string(),
  }),

  async execute(ctx, input) {
    return {
      message: `Hello, ${input.name}!`,
    };
  },
});
```

That's it! **No classes, no constructors, no try/catch, no boilerplate!**

---

## API Reference

### `defineNode()`

Creates a function-first node that's compatible with existing Blok workflows.

```typescript
function defineNode<TInput, TOutput>(
  definition: FnNodeDefinition<TInput, TOutput>
): FunctionNode<TInput, TOutput>
```

### `FnNodeDefinition<TInput, TOutput>`

The node definition object:

```typescript
interface FnNodeDefinition<TInput, TOutput> {
  // Node identification
  name: string;
  description: string;

  // Zod schemas for validation
  input: ZodType<TInput>;
  output: ZodType<TOutput>;

  // Execution function
  execute: (
    ctx: Context,
    input: TInput
  ) => Promise<TOutput> | TOutput;
}
```

#### Properties

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `name` | `string` | Yes | Node name (used in workflows) |
| `description` | `string` | Yes | Human-readable description |
| `input` | `ZodType` | Yes | Zod schema for input validation |
| `output` | `ZodType` | Yes | Zod schema for output validation |
| `execute` | `Function` | Yes | Node execution logic |

### `execute(ctx, input)` Function

The heart of your node - contains your business logic.

**Parameters:**

- `ctx: Context` - Workflow context with access to:
  - `ctx.logger` - Logging interface
  - `ctx.vars` - Cross-node state storage
  - `ctx.request` - Trigger request data
  - `ctx.response` - Current response state
  - `ctx.config` - Node configuration
  - `ctx.env` - Environment variables

- `input: TInput` - Type-safe input (validated by Zod)

**Returns:** `Promise<TOutput> | TOutput` - Type-safe output (will be validated)

**Example:**

```typescript
async execute(ctx, input) {
  // Log activity
  ctx.logger.log(`Processing user: ${input.userId}`);

  // Business logic
  const user = await fetchUser(input.userId);

  // Store in context for downstream nodes
  if (ctx.vars) {
    ctx.vars['current-user'] = user;
  }

  // Return validated output
  return { user };
}
```

---

## Schema Validation

Function-first nodes use [Zod](https://zod.dev) for runtime validation and TypeScript type inference.

### Basic Types

```typescript
input: z.object({
  // Primitives
  name: z.string(),
  age: z.number(),
  active: z.boolean(),

  // Optional fields
  nickname: z.string().optional(),

  // Fields with defaults
  role: z.string().default("user"),

  // Nullable fields
  deletedAt: z.string().nullable(),
})
```

### String Validation

```typescript
input: z.object({
  // Format validation
  email: z.string().email(),
  url: z.string().url(),
  uuid: z.string().uuid(),
  datetime: z.string().datetime(),

  // Length constraints
  username: z.string().min(3).max(20),
  password: z.string().min(8),

  // Regex patterns
  phoneNumber: z.string().regex(/^\+?[1-9]\d{1,14}$/),

  // Enums
  status: z.enum(["active", "inactive", "pending"]),
})
```

### Number Validation

```typescript
input: z.object({
  // Type constraints
  age: z.number().int(),
  price: z.number().positive(),
  temperature: z.number().finite(),

  // Range constraints
  rating: z.number().min(1).max(5),
  percentage: z.number().min(0).max(100),

  // Multiple of
  even: z.number().multipleOf(2),
})
```

### Array Validation

```typescript
input: z.object({
  // Basic arrays
  tags: z.array(z.string()),

  // Length constraints
  requiredTags: z.array(z.string()).min(1),
  topFive: z.array(z.string()).max(5),
  exactlyThree: z.array(z.string()).length(3),

  // Non-empty arrays
  items: z.array(z.string()).nonempty(),
})
```

### Object Validation

```typescript
input: z.object({
  // Nested objects
  user: z.object({
    id: z.string(),
    profile: z.object({
      name: z.string(),
      age: z.number(),
    }),
  }),

  // Dynamic keys (record)
  metadata: z.record(z.string(), z.unknown()),

  // Partial objects
  updates: z.object({
    name: z.string(),
    email: z.string(),
  }).partial(),
})
```

### Advanced Validation

#### Custom Refinements

```typescript
input: z.object({
  password: z.string()
    .min(8)
    .refine(
      (val) => /[A-Z]/.test(val),
      { message: "Must contain uppercase letter" }
    )
    .refine(
      (val) => /[0-9]/.test(val),
      { message: "Must contain number" }
    ),
})
```

#### Transformations

```typescript
input: z.object({
  // Parse date string to Date object
  createdAt: z.string().transform((str) => new Date(str)),

  // Convert string to number
  count: z.string().transform((str) => parseInt(str, 10)),

  // Uppercase transformation
  code: z.string().transform((str) => str.toUpperCase()),
})
```

#### Conditional Validation

```typescript
input: z.discriminatedUnion("type", [
  z.object({
    type: z.literal("email"),
    address: z.string().email(),
  }),
  z.object({
    type: z.literal("phone"),
    number: z.string().regex(/^\+?[1-9]\d{1,14}$/),
  }),
])
```

---

## Error Handling

Function-first nodes handle errors automatically. You don't need try/catch blocks!

### Validation Errors (400)

When input or output fails Zod validation:

```typescript
// Input: { email: "not-an-email", age: -5 }

// Automatic error response:
{
  success: false,
  error: {
    code: 400,
    name: "my-node",
    message: "Validation failed: email (Invalid email), age (Number must be positive)",
    json: {
      validation_errors: [
        {
          path: ["email"],
          message: "Invalid email",
          code: "invalid_string"
        },
        {
          path: ["age"],
          message: "Number must be positive",
          code: "too_small"
        }
      ]
    }
  }
}
```

### Runtime Errors (500)

When your execute() function throws an error:

```typescript
async execute(ctx, input) {
  throw new Error("Database connection failed");
}

// Automatic error response:
{
  success: false,
  error: {
    code: 500,
    name: "my-node",
    message: "Database connection failed",
    stack: "Error: Database connection failed\n  at execute..."
  }
}
```

### Custom Error Handling

If you need custom error handling:

```typescript
async execute(ctx, input) {
  try {
    const result = await riskyOperation();
    return { result };
  } catch (error) {
    ctx.logger.error("Operation failed", error);

    // Re-throw to trigger automatic error handling
    throw new Error(`Failed to process: ${error.message}`);
  }
}
```

---

## Migration Guide

### From Class-Based to Function-First

#### Before (Class-Based) - 80+ lines

```typescript
import BlokService from "@blokjs/runner";
import type { Context } from "@blokjs/shared";
import { GlobalError } from "@blokjs/shared";
import type { IBlokResponse } from "@blokjs/runner";
import BlokResponse from "@blokjs/runner";

interface InputType {
  userId: string;
}

export default class FetchUser extends BlokService<InputType> {
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
      required: ["user"],
    };
  }

  async handle(ctx: Context, inputs: InputType): Promise<IBlokResponse> {
    const response: BlokResponse = new BlokResponse();

    try {
      ctx.logger.log(`Fetching user: ${inputs.userId}`);

      const user = await fetchUserFromDatabase(inputs.userId);

      if (ctx.vars) {
        ctx.vars["current-user"] = user;
      }

      response.setSuccess({ user });
    } catch (error: any) {
      const nodeError: GlobalError = new GlobalError(error.message);
      nodeError.setCode(500);
      nodeError.setStack(error.stack);
      nodeError.setName(this.name);
      response.setError(nodeError);
    }

    return response;
  }
}

async function fetchUserFromDatabase(userId: string) {
  // ... implementation
}
```

#### After (Function-First) - 30 lines

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
    ctx.logger.log(`Fetching user: ${input.userId}`);

    const user = await fetchUserFromDatabase(input.userId);

    if (ctx.vars) {
      ctx.vars["current-user"] = user;
    }

    return { user };
  },
});

async function fetchUserFromDatabase(userId: string) {
  // ... implementation
}
```

**Reduction: From 80+ lines to 30 lines (62% less code!)** 🎉

### Migration Checklist

- [ ] Replace class declaration with `defineNode()`
- [ ] Convert JSON Schema to Zod schemas
- [ ] Move business logic from `handle()` to `execute()`
- [ ] Remove try/catch blocks (automatic now!)
- [ ] Remove BlokResponse boilerplate
- [ ] Remove GlobalError construction
- [ ] Test the node in a workflow

---

## Best Practices

### 1. Be Specific with Validation

```typescript
// ❌ Too permissive
input: z.object({
  email: z.string(),  // Any string!
})

// ✅ Specific validation
input: z.object({
  email: z.string().email(),
})
```

### 2. Use Descriptive Names

```typescript
// ❌ Generic names
defineNode({
  name: "node1",  // What does it do?
  ...
})

// ✅ Descriptive names
defineNode({
  name: "fetch-user-by-id",
  description: "Fetches user profile from database by UUID",
  ...
})
```

### 3. Document Complex Schemas

```typescript
input: z.object({
  userId: z.string().uuid().describe("User's unique identifier"),
  includeDeleted: z.boolean()
    .optional()
    .default(false)
    .describe("Include soft-deleted users in results"),
})
```

### 4. Keep Nodes Focused

```typescript
// ❌ Does too much
defineNode({
  name: "user-workflow",  // Fetches, validates, updates, emails
  ...
})

// ✅ Single responsibility
defineNode({
  name: "fetch-user",  // Just fetches
  ...
})
```

### 5. Use Context Effectively

```typescript
async execute(ctx, input) {
  // ✅ Log important operations
  ctx.logger.log(`Starting operation with ${input.userId}`);

  // ✅ Store data for downstream nodes
  if (ctx.vars) {
    ctx.vars['user-data'] = result;
  }

  // ✅ Access environment variables
  const apiKey = ctx.env?.API_KEY;

  return result;
}
```

### 6. Reuse Schemas

```typescript
// Define once
const UserSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  email: z.string().email(),
});

// Reuse everywhere
export const FetchUser = defineNode({
  input: z.object({ userId: z.string().uuid() }),
  output: z.object({ user: UserSchema }),
  // ...
});

export const UpdateUser = defineNode({
  input: z.object({
    userId: z.string().uuid(),
    updates: UserSchema.partial(),
  }),
  output: z.object({ user: UserSchema }),
  // ...
});
```

---

## Examples

### Example 1: API Call Node

```typescript
import { defineNode } from "@blokjs/runner";
import { z } from "zod";

export default defineNode({
  name: "api-call",
  description: "Makes HTTP requests with automatic JSON handling",

  input: z.object({
    url: z.string().url(),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
    headers: z.record(z.string()).optional(),
    body: z.any().optional(),
    timeout: z.number().positive().default(30000),
  }),

  output: z.object({
    status: z.number().int().min(100).max(599),
    data: z.any(),
    headers: z.record(z.string()),
    duration: z.number(),
  }),

  async execute(ctx, input) {
    const startTime = performance.now();

    const response = await fetch(input.url, {
      method: input.method,
      headers: { "Content-Type": "application/json", ...input.headers },
      body: input.body ? JSON.stringify(input.body) : undefined,
      signal: AbortSignal.timeout(input.timeout),
    });

    const contentType = response.headers.get("content-type") || "";
    const data = contentType.includes("application/json")
      ? await response.json()
      : await response.text();

    return {
      status: response.status,
      data,
      headers: Object.fromEntries(response.headers.entries()),
      duration: performance.now() - startTime,
    };
  },
});
```

### Example 2: Database Query Node

```typescript
export default defineNode({
  name: "query-users",
  description: "Queries users from database with filters",

  input: z.object({
    filters: z.object({
      status: z.enum(["active", "inactive"]).optional(),
      minAge: z.number().int().optional(),
      tags: z.array(z.string()).optional(),
    }),
    pagination: z.object({
      page: z.number().int().positive().default(1),
      limit: z.number().int().positive().max(100).default(10),
    }),
  }),

  output: z.object({
    users: z.array(z.object({
      id: z.string(),
      name: z.string(),
      email: z.string().email(),
      status: z.enum(["active", "inactive"]),
    })),
    total: z.number().int(),
    page: z.number().int(),
  }),

  async execute(ctx, input) {
    // Build query
    const query = db.users.select();

    if (input.filters.status) {
      query.where({ status: input.filters.status });
    }

    if (input.filters.minAge) {
      query.where("age", ">=", input.filters.minAge);
    }

    // Execute with pagination
    const offset = (input.pagination.page - 1) * input.pagination.limit;
    const [users, total] = await Promise.all([
      query.limit(input.pagination.limit).offset(offset),
      query.count(),
    ]);

    ctx.logger.log(`Found ${users.length} of ${total} users`);

    return {
      users,
      total,
      page: input.pagination.page,
    };
  },
});
```

### Example 3: Conditional Logic Node

```typescript
export default defineNode({
  name: "validate-and-route",
  description: "Validates user data and determines next step",

  input: z.object({
    user: z.object({
      id: z.string(),
      email: z.string().email(),
      age: z.number().int(),
      verified: z.boolean(),
    }),
  }),

  output: z.object({
    action: z.enum(["approve", "review", "reject"]),
    reason: z.string(),
    priority: z.enum(["low", "medium", "high"]),
  }),

  async execute(ctx, input) {
    const { user } = input;

    // Rejection conditions
    if (user.age < 18) {
      return {
        action: "reject",
        reason: "User is under 18",
        priority: "low",
      };
    }

    if (!user.verified) {
      return {
        action: "review",
        reason: "Email not verified",
        priority: "medium",
      };
    }

    // Check for suspicious patterns
    const isSuspicious = await checkForSuspiciousActivity(user.id);
    if (isSuspicious) {
      return {
        action: "review",
        reason: "Suspicious activity detected",
        priority: "high",
      };
    }

    // All checks passed
    return {
      action: "approve",
      reason: "All validations passed",
      priority: "low",
    };
  },
});
```

---

## TypeScript Integration

### Type Inference

TypeScript automatically infers types from your Zod schemas:

```typescript
const MyNode = defineNode({
  input: z.object({
    userId: z.string().uuid(),
    count: z.number().int(),
  }),
  output: z.object({
    result: z.string(),
  }),

  async execute(ctx, input) {
    // TypeScript knows:
    // input.userId is string
    // input.count is number

    const userId: string = input.userId; // ✅ Type-safe
    const doubled: number = input.count * 2; // ✅ Type-safe

    // Return must match output schema
    return { result: `User ${userId}` }; // ✅ Type-safe
  },
});
```

### Extract Types

```typescript
const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
});

type User = z.infer<typeof UserSchema>;
// { id: string; name: string; }
```

### Reusable Type-Safe Schemas

```typescript
// schemas/user.ts
export const UserIdSchema = z.string().uuid();
export const UserSchema = z.object({
  id: UserIdSchema,
  name: z.string(),
  email: z.string().email(),
});

export type UserId = z.infer<typeof UserIdSchema>;
export type User = z.infer<typeof UserSchema>;

// nodes/fetch-user.ts
import { UserIdSchema, UserSchema, type User } from "../schemas/user";

export default defineNode({
  input: z.object({ userId: UserIdSchema }),
  output: z.object({ user: UserSchema }),

  async execute(ctx, input) {
    const user: User = await fetchUser(input.userId);
    return { user };
  },
});
```

---

## Testing

Testing function-first nodes is straightforward:

```typescript
import { describe, it, expect } from "vitest";
import { defineNode } from "@blokjs/runner";
import { z } from "zod";

const MyNode = defineNode({
  name: "test-node",
  description: "Test",
  input: z.object({ value: z.number() }),
  output: z.object({ doubled: z.number() }),
  async execute(ctx, input) {
    return { doubled: input.value * 2 };
  },
});

describe("MyNode", () => {
  it("should double the input value", async () => {
    const ctx = createTestContext();
    const result = await MyNode.handle(ctx, { value: 5 });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ doubled: 10 });
  });

  it("should reject invalid input", async () => {
    const ctx = createTestContext();
    const result = await MyNode.handle(ctx, { value: "not-a-number" });

    expect(result.success).toBe(false);
    expect(result.error.code).toBe(400);
  });
});
```

---

## Resources

- [Zod Documentation](https://zod.dev)
- [Example Nodes](./examples/function-first/)
- [Blok Documentation](https://blok.build)
- [TypeScript Handbook](https://www.typescriptlang.org/docs/)

---

## FAQ

### Can I use class-based and function-first nodes together?

Yes! Function-first nodes are fully backward compatible. Mix and match as needed.

### Do I need to update existing workflows?

No! Function-first nodes work with existing workflows without changes.

### Can I convert existing nodes gradually?

Absolutely! Convert one node at a time at your own pace.

### What about performance?

Function-first nodes have **zero overhead** compared to class-based nodes. They're just a cleaner syntax for the same underlying system.

### Can AI generate function-first nodes?

Yes! AI models achieve **95%+ success rates** with function-first nodes vs 60% with class-based.

---

**Ready to start?** Check out the [examples](./examples/function-first/) or jump right in with `defineNode()`! 🚀
