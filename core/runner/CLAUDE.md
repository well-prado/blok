# @blokjs/runner — Internals

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
| `src/adapters/grpc/GrpcRuntimeAdapter.ts` | gRPC adapter for all non-NodeJS SDKs (default since Phase 6) |
| `src/adapters/HttpRuntimeAdapter.ts` | HTTP adapter — **deprecated**, removed in v0.4.0. Resolves only via `RUNTIME_TRANSPORT=http` opt-in (see `transport.ts:resolveTransportForKind`); emits a once-per-process stderr warning. |
| `src/adapters/NodeJsRuntimeAdapter.ts` | In-process adapter for NodeJS/TypeScript nodes |
| `src/adapters/transport.ts` | Resolves which transport a runtime kind uses. Default `grpc`; `RUNTIME_TRANSPORT=http` and per-kind `RUNTIME_<K>_TRANSPORT=http` are honored with a deprecation warning. |
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
  "runtime.python3"  → runtimeResolver() — RuntimeRegistry → GrpcRuntimeAdapter (HTTP via opt-in)
  "runtime.go"       → runtimeResolver()
  "runtime.rust"     → runtimeResolver()
  "runtime.java"     → runtimeResolver()
  "runtime.csharp"   → runtimeResolver()
  "runtime.php"      → runtimeResolver()
  "runtime.ruby"     → runtimeResolver()
```

Transport selection lives in `src/adapters/transport.ts`. The default is `grpc`
since Phase 6 (master plan §11/§14). `RUNTIME_TRANSPORT=http` and per-kind
`RUNTIME_<KIND>_TRANSPORT=http` overrides remain functional **until v0.4.0**;
they emit a once-per-process stderr warning on resolve.

## Persistence model (v2)

Step output flows through `src/workflow/PersistenceHelper.ts:applyStepOutput`.
Rules in order:

1. `step.ephemeral === true` → no-op. Available only via `ctx.prev`.
2. Legacy `step.set_var === false` → also no-op (back-compat).
3. `step.spread === true` AND data is a plain object → shallow-merge into `ctx.state`.
4. Default → `ctx.state[step.as ?? step.name] = result.data`.

`set_var` is **passed through verbatim** by `Configuration.getSteps`,
`Configuration.getFlow`, and `Configuration.runtimeResolver` — they never
default it to `false`. NodeBase initializes `set_var` to `undefined` so the
default-store rule can fire. Defaulting to `false` here would silently
disable persistence for every step that didn't explicitly set the field
(which is every v2 step) — that exact regression broke
cross-runtime-chain in Phase 6 and is now covered by
`__tests__/unit/RuntimeAdapterNode.test.ts`.

## Tests

```bash
pnpm test:dev                      # Watch mode
pnpm test                          # Single run
pnpm test:integration              # Integration tests
pnpm test:all                      # Unit + integration
```
