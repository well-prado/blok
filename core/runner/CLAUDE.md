# @blok/runner — Internals

## Key Files

| File | Purpose |
|------|---------|
| `src/defineNode.ts` | `defineNode()` API — function-first node definition with Zod |
| `src/Blok.ts` | `BlokService` base class — `run()` orchestrates config→validate→handle→output |
| `src/RunnerSteps.ts` | `runSteps()` — core step execution loop, flow node handling |
| `src/Configuration.ts` | Loads workflow JSON, resolves nodes, initializes RuntimeRegistry |
| `src/RuntimeRegistry.ts` | Singleton managing all RuntimeAdapter instances |
| `src/RuntimeAdapterNode.ts` | Bridge: wraps RuntimeAdapter into RunnerNode interface |
| `src/TriggerBase.ts` | Base class for triggers — creates Context, runs workflow, handles tracing |
| `src/adapters/HttpRuntimeAdapter.ts` | HTTP adapter for all non-NodeJS SDKs |
| `src/adapters/NodeJsRuntimeAdapter.ts` | In-process adapter for NodeJS/TypeScript nodes |
| `src/tracing/RunTracker.ts` | Trace recording (SQLite/Postgres/In-Memory) |
| `src/tracing/registerTraceRoutes.ts` | `/__blok/*` REST API for Blok Studio |

## Step Execution Flow (RunnerSteps.ts)

```
runSteps(ctx, steps)
  for each step:
    if step.active === false → skip
    if step.stop === true → break
    if step.flow === true:
      → call step.processFlow(ctx) → returns NodeBase[]
      → recursively runSteps(ctx, [...flowSteps, ...remainingSteps], deep=true)
      → break (flow takes over)
    else:
      → call step.process(ctx, step)
      → ctx.response = result.data (OVERWRITES previous)
      → if error: throw GlobalError
```

## Node Resolution (Configuration.ts)

```
nodeTypes() returns:
  "module"           → moduleResolver() — loads from GlobalOptions.nodes
  "local"            → localResolver()  — dynamic import from NODES_PATH
  "runtime.python3"  → runtimeResolver() — RuntimeRegistry → HttpRuntimeAdapter
  "runtime.go"       → runtimeResolver()
  "runtime.rust"     → runtimeResolver()
  "runtime.java"     → runtimeResolver()
  "runtime.csharp"   → runtimeResolver()
  "runtime.php"      → runtimeResolver()
  "runtime.ruby"     → runtimeResolver()
```

## Tests

```bash
pnpm test:dev                      # Watch mode
pnpm test                          # Single run
pnpm test:integration              # Integration tests
pnpm test:all                      # Unit + integration
```
