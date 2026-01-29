# Module Reference: Workflow Helper

> **Package:** `@nanoservice-ts/helper`
> **Path:** `core/workflow-helper/`
> **Purpose:** Programmatic workflow builder DSL (TypeScript API for composing workflows)

## What It Does

The workflow helper provides a fluent builder API for composing workflows programmatically in TypeScript instead of writing raw JSON files. It supports building triggers, steps, conditions (if/else), and responses.

## Source Directory Structure

```
core/workflow-helper/src/
├── index.ts                    # Main export — the Workflow builder class
│
├── components/                 # Builder components
│   ├── Workflow.ts             # Main workflow builder
│   ├── Trigger.ts              # Trigger definition builder
│   ├── StepNode.ts             # Step/node builder
│   ├── AddIf.ts                # Conditional (if) builder
│   ├── AddElse.ts              # Conditional (else) builder
│   ├── Response.ts             # Response builder
│   └── HelperResponse.ts       # Helper response type
│
└── types/                      # Type definitions
    ├── WorkflowOpts.ts         # Workflow options
    ├── TriggerOpts.ts          # Trigger configuration types (ALL trigger types)
    └── StepOpts.ts             # Step configuration types
```

## Key APIs

### Workflow Builder
```typescript
import { Workflow } from "@nanoservice-ts/helper";

const workflow = new Workflow()
  .trigger("http", { method: "POST", path: "/api/users" })
  .addStep("validate", "input-validator", { /* inputs */ })
  .addStep("create-user", "db-insert", { /* inputs */ })
  .addIf("ctx.response.data.exists", {
    then: "send-welcome-email",
    else: "send-error-response"
  })
  .response({ status: 200, body: "ctx.vars.result" })
  .build();
```

### Trigger Types (TriggerOpts.ts)

The TriggerOpts type supports all 10 trigger types:
- `http` — method, path, accept
- `grpc` — service, method
- `queue` — provider, topic, subscription, consumerGroup, deadLetterQueue
- `pubsub` — provider, channel, pattern
- `worker` — queue, concurrency, timeout, retries
- `cron` — schedule (cron expression), timezone
- `webhook` — source, events, secret
- `sse` — path
- `websocket` — path
- `manual` — (no options)

### Step Options (StepOpts.ts)

Each step in a workflow defines:
- `node` — which node to execute (by name)
- `inputs` — input mapping (JSONPath from context)
- `runtime` — which runtime to use (optional, defaults to nodejs)
- `condition` — conditional execution
- `onError` — error handling strategy

## Tests

```
core/workflow-helper/tests/
├── addElse.test.ts
├── addIf.test.ts
├── helperResponse.test.ts
├── schemas.test.ts
└── trigger.test.ts
```

## What to Document

1. **Workflow Builder API** — Complete fluent API reference
2. **Trigger configuration** — All trigger types with examples
3. **Step configuration** — Input mapping, runtime selection, conditions
4. **Conditional logic** — if/else branching patterns
5. **Response configuration** — How to define workflow responses
6. **JSON vs TypeScript** — When to use builder vs raw JSON
