# Blok Framework — Claude Code Guide

Read `AGENTS.md` for full architecture, APIs, and patterns. This file contains Claude-specific operational guidance.

## Quick Commands

```bash
bun install                        # Install dependencies
bun run build                      # Build all packages
bun run test                       # Run all tests
bun run lint                       # Lint with Biome
bun run http:dev                   # Start HTTP trigger dev server
bun run runner:test                # Test runner in watch mode
bun run core:build:dev             # Watch-build all core packages
blokctl dev                        # Full dev server (spawns runtimes + runner)
blokctl create node <name>         # Scaffold a new node
blokctl create workflow <name>     # Scaffold a new workflow
blokctl trace                      # Open Blok Studio
```

## Context Rules (Memorize These)

1. **`ctx.response.data` is OVERWRITTEN every step.** Previous step output is GONE unless stored in vars.
2. **`ctx.vars` PERSISTS across the entire workflow.** Use `set_var: true` on steps or `js/ctx.vars['step-name']` in inputs.
3. **Blueprint Mapper resolves `js/` expressions BEFORE node execution.** The node receives already-resolved values.

When a user has data flow issues, check these three things first.

## Debugging Workflows

### Step 1: Verify workflow JSON structure
- Every `steps[].name` must have a matching key in `nodes`
- `steps[].node` must point to a valid node package or path
- `steps[].type` must be `module`, `local`, or `runtime.*`

### Step 2: Trace data flow through ctx.vars
- Which steps have `set_var: true`? Their output goes to `ctx.vars[stepName]`
- Do `js/` expressions in node inputs reference the correct step names?
- Remember: `ctx.response.data` only has the LAST step's output

### Step 3: Check runtime connectivity
- Is the SDK container running? Check `GET http://localhost:{port}/health`
- Correct ports: Go:9001, Rust:9002, Java:9003, C#:9004, PHP:9005, Ruby:9006, Python3:9007
- Check env vars: `RUNTIME_{LANG}_HOST` and `RUNTIME_{LANG}_PORT`

### Step 4: Inspect Blok Studio traces
- Navigate to `http://localhost:{runner-port}/__blok/runs`
- Each run shows all steps with inputs, outputs, and errors
- Check `depth` field — nested steps come from flow nodes (if-else)

### Common Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `Node type X not found` | Missing runtime resolver | Add `runtime.X` to `nodeTypes()` in Configuration.ts |
| `Validation failed: field (...)` | Zod schema mismatch | Check input schema vs actual data passed to node |
| `Runtime execution error` | SDK container not running | Start runtime, verify health endpoint |
| `ctx.vars['X'] is undefined` | Step X missing `set_var: true` | Add `set_var: true` to step or check step name spelling |
| `Node X not found` | Module not registered | Check GlobalOptions.nodes registration |

## Generating Node Code

Always use `defineNode()`. Never create class-based BlokService nodes.

```typescript
import { defineNode } from "@blok/runner";
import { z } from "zod";

export default defineNode({
  name: "node-name",
  description: "What this node does",

  input: z.object({
    // Define all expected inputs with Zod
  }),

  output: z.object({
    // Define the output shape with Zod
  }),

  async execute(ctx, input) {
    // input is validated and type-safe
    // Return must match output schema
    return { /* output */ };
  },
});
```

### Checklist for generated nodes:
- Zod input schema covers all expected inputs
- Zod output schema matches what execute() returns
- Node name matches what workflows will reference
- Error cases throw Error (auto-wrapped to GlobalError with 500)
- No `any` types — use `z.unknown()` if truly dynamic

## Generating Workflow JSON

```json
{
  "name": "Workflow Name",
  "version": "1.0.0",
  "trigger": {
    "http": { "method": "POST", "path": "/api/endpoint", "accept": "application/json" }
  },
  "steps": [
    { "name": "step-name", "node": "node-package", "type": "module" }
  ],
  "nodes": {
    "step-name": {
      "inputs": { "key": "value or js/expression" }
    }
  }
}
```

### Checklist for generated workflows:
- Every step name appears as a key in `nodes`
- `js/` expressions reference correct `ctx.vars` keys (check step order)
- Steps that provide data to non-adjacent downstream steps have `set_var: true`
- Condition expressions in if-else are valid JavaScript
- Version follows semver (x.x.x)

## Helping Users with Blok Studio

- **Launch**: `blokctl trace` or navigate to `/__blok` on the running trigger
- **Run list**: Shows all workflow executions with status (running/completed/failed)
- **Run detail**: Expand to see each step's inputs, outputs, errors, and timing
- **Live updates**: SSE streaming updates runs in real-time
- **Metrics**: Shows execution count, duration, memory, CPU per workflow

Common user questions:
- "No output on step" → Node's execute() might not be returning data, or Zod output validation failed
- "Step shows error" → Expand error details, check if it's Zod validation (400) or runtime error (500)
- "Variables not passing" → Check that source step has `set_var: true` and target input uses `js/ctx.vars['name']`
- "Flow node skipping branches" → Check condition expression syntax in workflow JSON

## Do NOT

- Do NOT suggest class-based BlokService for new nodes — always use `defineNode()`
- Do NOT generate code with `any` types
- Do NOT assume `ctx.response.data` persists across steps
- Do NOT skip Zod schemas when creating nodes
- Do NOT use ESLint/Prettier — this project uses Biome
- Do NOT edit files in `.blok/runtimes/` — they are auto-generated
