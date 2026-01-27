# New Function First Nodes Logic

You’re right to kill the class-heavy pattern for new stuff. Let’s design a **function‑first Node API with native Zod v4** that:

- Feels like Elysia’s `.get("/path", ({ body }) => ...)` style (function handlers + schemas).
- Still plugs cleanly into the existing Node map / runner (no rewrite of the whole system). [18][27][32]
- Is trivial for another model to generate.

I’ll define:

1. The new functional Node shape (TypeScript interface)  
2. How Zod schemas plug in (input/output)  
3. A `defineNode` helper that wraps a function into a NodeBase‑compatible object  
4. How this integrates with `src/Nodes.ts` and triggers today  

---

## 1. Target design: “Elysia‑style” functional Node

Today, Nodes are classes extending `NanoService` with `handle(ctx, inputs)` and JSON Schema. [24][8][10]  
We want instead:

```ts
const myNode = defineNode({
  name: "fetch-user",
  input: z.object({ userId: z.string().uuid() }),
  output: z.object({ user: z.any() }),
  async execute(ctx, input) {
    // logic using ctx + typed `input`
    return { user: await loadUser(input.userId) };
  },
});
```

Key points:

- **Function‑first**: Node is defined by an `execute(ctx, input)` function, not a class.  
- **Native Zod v4**: `input` and `output` schemas are Zod; types are inferred from them.  
- **Wrapper handles** validation, error -> `GlobalError`, and bridging to existing runner expectations.

We still need to integrate with:

- `src/Nodes.ts` registration map: `{ [key: string]: NodeBase } = { ... }`. [27][35][25]
- Triggers loading nodes into a `NodeMap` via this map. [32][33][18][17]

So the `defineNode` output must **look like a `NodeBase`/NanoService** from the runner’s perspective. [27][18][39]

---

## 2. The functional Node interface

We define a **new, internal functional Node contract**:

```ts
import type { Context, GlobalError } from "@nanoservice-ts/shared"; // [24][7]
import type { ZodSchema } from "zod";

export interface FnNodeDefinition<I, O> {
  name: string;                 // logical name (for logging/ctx.vars namespacing)
  input: ZodSchema<I>;          // Zod v4 input schema
  output: ZodSchema<O>;         // Zod v4 output schema
  description?: string;
  // core logic
  execute: (ctx: Context, input: I) => Promise<O> | O;
}
```

`Context` is the same type used by current class‑based Nodes and runner. [24][7][30]

---

## 3. The `defineNode` factory: wrap function into NodeBase‑compatible object

We create a helper that:

- Accepts a `FnNodeDefinition`.  
- Produces an object that **behaves like a Node class instance** from the runner’s view: it exposes a `handle(ctx, inputs)` method that returns the current `INanoServiceResponse` shape. [24][32][8]

Sketch:

```ts
// core/nodes/defineNode.ts
import { NanoService, NanoServiceResponse, type INanoServiceResponse } from "@nanoservice-ts/runner"; // [24][8]
import { type Context, GlobalError } from "@nanoservice-ts/shared"; // [24][7]
import type { ZodSchema } from "zod";
import { ZodError } from "zod";

export function defineNode<I, O>(def: FnNodeDefinition<I, O>) {
  class FunctionNode extends NanoService<I> {
    constructor() {
      super();
      // convert Zod schemas into JSON Schema if you want to keep older tooling;
      // as a minimal step, we can just stash them or leave JSON Schemas empty.
      this.inputSchema = {};   // could be generated from def.input
      this.outputSchema = {};  // could be generated from def.output
      this.name = def.name;
      this.description = def.description ?? this.description;
    }

    async handle(ctx: Context, rawInputs: I): Promise<INanoServiceResponse> {
      const response = new NanoServiceResponse();

      try {
        // 1) Validate input via Zod (replaces ad‑hoc JSON Schema validation)
        const parsed = def.input.parse(rawInputs);

        // 2) Execute function‑style node logic
        const result = await def.execute(ctx, parsed);

        // 3) Optionally validate output
        const parsedOutput = def.output.parse(result);

        response.setSuccess(parsedOutput);
      } catch (err: unknown) {
        const nodeError = new GlobalError(err instanceof Error ? err.message : "Unknown error");
        nodeError.setCode(500);
        nodeError.setStack(err instanceof Error ? err.stack : undefined);
        nodeError.setName(this.name);
        nodeError.setJson(
          err instanceof ZodError ? { issues: err.issues } : undefined,
        );

        response.setError(nodeError);
      }

      return response;
    }
  }

  return new FunctionNode();
}
```

This:

- Extends `NanoService<I>`, just like the template class. [24][8]
- Still returns `INanoServiceResponse` through `NanoServiceResponse`. [24][32]
- Uses `GlobalError` consistently with current template. [24][8]
- Allows us to continue treating Nodes as `NodeBase`/`NanoService` instances in `src/Nodes.ts`. [27][18][17][32]

So for the runner and triggers, this “function node” behaves exactly like the old class‑based node. [32][33][26]

---

## 4. Using the new API in a Node package

In a Node’s `index.ts` (instead of hand‑writing a class): [1][24][8]

```ts
// src/nodes/fetch-user/index.ts
import { z } from "zod";
import { defineNode } from "@nanoservice-ts/core/nodes/defineNode"; // new helper you add
import type { Context } from "@nanoservice-ts/shared"; // [24][7]

// 1) Define schemas
const inputSchema = z.object({
  userId: z.string().uuid(),
});

const outputSchema = z.object({
  user: z.any(),
});

// 2) Define function‑first node
export const FetchUser = defineNode({
  name: "fetch-user",
  input: inputSchema,
  output: outputSchema,
  async execute(ctx: Context, input) {
    // Example usage of ctx like docs show
    const requestId = ctx.request.headers["x-request-id"]; // if present [30]
    // ctx.vars etc. are also available [30][1]

    // Real logic
    const user = await someUserRepo.loadById(input.userId);

    // Return MUST match outputSchema
    return { user };
  },
});
```

This Node is just a value (`FetchUser`), not a class definition. But it is an instance of `NanoService` under the hood, so everything that expects a `NodeBase` still works. [24][8][27]

---

## 5. Registration in `src/Nodes.ts` remains identical

Current registration pattern: [27][18][25][35]

```ts
import ApiCall from "@nanoservice-ts/api-call";
import IfElse from "@nanoservice-ts/if-else";
import type { NodeBase } from "@nanoservice-ts/shared";
import Fetch from "./nodes/fetch";

const nodes: { [key: string]: NodeBase } = {
  "@nanoservice-ts/api-call": new ApiCall(),
  "@nanoservice-ts/if-else": new IfElse(),
  "fetch": new Fetch(),
};

export default nodes;
```

For function‑first nodes, since `defineNode` already returns an instance, you simply do:

```ts
import ApiCall from "@nanoservice-ts/api-call";
import IfElse from "@nanoservice-ts/if-else";
import type { NodeBase } from "@nanoservice-ts/shared";
import { FetchUser } from "./nodes/fetch-user";

const nodes: { [key: string]: NodeBase } = {
  "@nanoservice-ts/api-call": new ApiCall(),
  "@nanoservice-ts/if-else": new IfElse(),
  "fetch-user": FetchUser,
};

export default nodes;
```

This still matches the type and structure expected by triggers and GRPC/HTTP loaders that build `NodeMap` from `nodes`. [18][17][32][33]

---

## 6. Why this matches your goals

- **No manual classes for new Nodes**: authors (and models) only write:
  - `input` Zod schema
  - `output` Zod schema
  - `execute(ctx, input)` function
- **Zod v4 native**: all validation done in the wrapper via `def.input.parse` and `def.output.parse`.  
- **Minimal disruption**:
  - Existing CLI still scaffolds old class template, but we can add a new template that uses `defineNode`. [22][24][12]
  - `src/Nodes.ts` and trigger loading logic remain unchanged. [25][35][18][32][33]
- **Elysia‑style dev ergonomics**: function + schema + context, no inheritance ceremony.

---

## 7. How to wire this into your tooling / Claude flows

1. **Add `defineNode` + `FnNodeDefinition` to core** (e.g. `core/nodes/defineNode.ts`) implementing the wrapper above. [24][8][7]
2. **Add a new CLI “functional node” template**:
   - Similar to `templates/node/index.ts` but using `zod` + `defineNode` instead of `class Node extends NanoService`. [8][24][22]
3. **Add a new `createNodeSystemPrompt` variant** that:
   - Asks the model to output only:
     - imports (`zod`, `defineNode`, `Context`)
     - `inputSchema` & `outputSchema`
     - `export const SomeNode = defineNode({ ... })`
   - No class, no custom `handle`. [12][22][40]
4. **Slowly migrate built‑ins**:
   - New built‑ins can start using `defineNode` while keeping the registration map API as‑is. [4][36][27]
   - Old class‑nodes continue to function unchanged.

If you want, next step I can:

- Write the **exact code** for `FnNodeDefinition` + `defineNode` in final form, plus a ready‑to‑drop **CLI template** file that generates a functional, Zod‑powered Node so Claude can just fill in `inputSchema`, `outputSchema`, and `execute`.

---
*Exported from Tetrix AI Space*
*Date: 2026-01-27T16:10:48.459Z*