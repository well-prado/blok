# Blok Framework

Blok is a TypeScript-first workflow orchestration framework. It runs
declarative workflows across NodeJS, Python3, Go, Rust, Java, C#, PHP, and Ruby
runtimes. This monorepo uses Bun, TypeScript, Hono, Vitest, Nx, and Biome.

Keep this file, `CLAUDE.md`, and
`docs/d/fundamentals/context-and-state.mdx` in sync when workflow authoring
rules change.

## Monorepo Structure

```txt
blok/
├── core/
│   ├── core/                # @blokjs/core - public authoring surface
│   ├── runner/              # @blokjs/runner - execution engine
│   ├── shared/              # @blokjs/shared - shared runtime types
│   └── workflow-helper/     # @blokjs/helper - legacy/object workflow DSL + schemas
├── apps/studio/             # @blokjs/studio - trace visualization UI
├── packages/
│   ├── cli/                 # blokctl
│   ├── client/              # typed client
│   ├── lsp-server/
│   └── vscode-extension/
├── sdks/                    # language SDKs
├── triggers/                # http, mcp, grpc, webhook, websocket, sse, cron, pubsub, worker
├── nodes/                   # built-in nodes
└── runtimes/                # runtime process definitions
```

## Development Commands

```bash
bun install
bun run build
bun run test
bun run lint
bun run ci:fast

bun run runner:dev
bun run runner:test
bun run helper:dev
bun run helper:test
bun run core:build:dev

bun run http:dev
bun run build:cli
bun run cli:dev
bun run cli:test
bun run nodes:build
```

Use `rg` / `rg --files` for repo searches. Use Biome, not ESLint or Prettier.

## Authoring Surface

New TypeScript workflows use the typed-handle DSL from `@blokjs/core`.

```ts
import { branch, gt, http, step, tpl, workflow } from "@blokjs/core";

export default workflow("order-intake", { version: "1.0.0", trigger: http.post("/orders") }, (req) => {
  const order = step("validate", validateOrder, { body: req.body });
  step("summary", summarize, { line: tpl`order ${order.id}` });
  branch("lane", gt(order.total, 100), {
    then: () => {
      step("premium", routeOrder, { lane: "premium" });
    },
    else: () => {
      step("standard", routeOrder, { lane: "standard" });
    },
  });
});
```

The authoring rule is simple:

- `workflow(name, opts, build)` defines the workflow.
- The `build(entry)` callback receives the trigger entry handle.
- `step(id, node, inputs, opts?)` runs a node and returns a typed output handle.
- Pass handles into later step inputs directly.
- Use `tpl` when a string contains handles.
- Use `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, or `not` for branch conditions.
- Use the `js` tagged template only for non-structural escape hatches.

Do not write new workflow data flow with `$` proxies, `js/` strings, or raw
`ctx` condition strings. Those are legacy/compiled forms, not the authoring
model.

## Entry Handles

Name the callback argument by trigger kind:

| Trigger | Entry handle | Reads |
|---|---|---|
| HTTP | `req` | `req.body`, `req.params`, `req.query`, `req.headers` |
| Worker | `job` | `job.body`, `job.params.queue`, `job.params.jobId`, `job.params.attempt` |
| Webhook | `event` | `event.body`, `event.headers`, `event.params` |
| Pub/Sub | `msg` | `msg.body`, `msg.headers`, `msg.params` |
| Cron | `tick` | `tick.params`, `tick.headers` |
| gRPC | `rpc` | `rpc.body`, `rpc.params`, `rpc.headers` |
| SSE | `stream` | `stream.params`, `stream.query`, `stream.headers` |
| WebSocket | `conn` | `conn.body`, `conn.params`, `conn.headers` |
| MCP | `call` | `call.body`, `call.headers` |

All entry handles point at the trigger payload in the runtime context; the
names and types help authors pick the right mental model.

## Nodes

Always author nodes with `defineNode()` from `@blokjs/core`.

```ts
import { defineNode } from "@blokjs/core";
import { z } from "zod";

export default defineNode({
  name: "fetch-user",
  description: "Fetches a user by ID",
  input: z.object({ userId: z.string().uuid() }),
  output: z.object({
    user: z.object({ id: z.string(), email: z.string().email() }),
  }),
  async execute(ctx, input) {
    ctx.logger.log(`fetching ${input.userId}`);
    const user = await db.users.findById(input.userId, { signal: ctx.signal });
    return { user };
  },
});
```

The node-side `ctx` ABI is kept. Use it for runtime concerns:

| Field | Purpose |
|---|---|
| `ctx.request` | Trigger payload in runtime form. |
| `ctx.logger` | Structured logs that show in traces. |
| `ctx.env` | Environment variables. |
| `ctx.signal` | Cooperative cancellation. |
| `ctx.publish(name, value)` | Rare side-channel publication. Prefer returning data. |
| `ctx.connection` | WebSocket-only connection API. Prefer helper nodes. |
| `ctx.stream` | SSE-only stream API. Prefer helper nodes. |

Hard rules:

- Keep Zod `input` and `output` schemas.
- Return output; never mutate `ctx.state` or `ctx.vars`.
- Do not create class-based `BlokService` nodes.
- Avoid `any`; use `unknown` and narrow.
- Throw plain `Error` for failures unless a specific framework error is needed.

## Handles and Persistence

Every successful step stores its output at `ctx.state[id]`. A failed step writes
nothing. The handle returned by `step()` is how authors read that output later.

```ts
const user = step("load-user", loadUser, { userId: req.params.id });
step("send", sendEmail, { to: user.user.email });
```

Fourth-argument knobs:

| Knob | Effect |
|---|---|
| none | Store at `ctx.state[id]`. |
| `{ as: "name" }` | Store at `ctx.state[name]`; returned handle is rooted there. |
| `{ spread: true }` | Merge returned object keys into top-level state. |
| `{ ephemeral: true }` | Store nothing; returned handle is unreadable. |

`ephemeral: true` is only for side effects such as logging, audit, response
helpers, or emitters. Do not read an ephemeral handle.

## Strings and Escape Hatches

Use `tpl` for strings that contain handles:

```ts
step("notify", notify, { message: tpl`order ${order.id} is ${order.status}` });
```

Use `js` only when structural handles cannot express the value:

```ts
step("classify", classify, {
  lane: js`${order.total} > 100 ? "premium" : "standard"`,
});
```

`js` emits an opaque mapper expression. It is the escape hatch for ternaries,
nullish defaults, `.map`, date/env reads, and similar logic. Prefer handles,
`tpl`, and branch operators first.

`@blokjs/expr` is node-specific: its `expression` input is plain JavaScript for
that node to evaluate. Do not prefix it with a mapper marker.

## Control Flow

Use callback control-flow primitives from `@blokjs/core`.

```ts
branch("route", order.inStock, {
  then: () => {
    step("ship", shipOrder, { id: order.id });
  },
  else: () => {
    step("backorder", backorder, { id: order.id });
  },
});

const reserved = forEach(order.items, (item, index) => {
  step("reserve", reserveInventory, { sku: item.sku, index });
}, { as: "line" });

switchOn(event.body.kind, {
  cases: [
    { when: "payment", do: () => step("payment", handlePayment, { event: event.body }) },
  ],
  default: () => step("unknown", logUnknown, { event: event.body }, { ephemeral: true }),
}, { id: "route-event" });

tryCatch("saga", {
  try: () => step("charge", chargeCard, { order }),
  catch: (err) => step("rollback", refund, { reason: err.message }),
});
```

Branch conditions use typed operators (`eq`, `ne`, `gt`, `gte`, `lt`, `lte`,
`not`) or a boolean handle. `switchOn` case `when` values are static literals.

### Four Footguns

1. Arm-scoped handles do not escape their arm. To use a result downstream,
   use the flow primitive's returned handle when it has one, such as `forEach`
   results, or have every branch/switch/tryCatch arm write to one shared `as`
   key with unique step ids.
2. Ephemeral handles are unreadable.
3. Step ids are one flat namespace, including mutually exclusive arms.
4. `forEach` `as` and `asIndex` keys share the same state namespace as step
   ids and outer loops.

See `docs/d/primitives/handles-and-footguns.mdx`.

## Sub-workflows

Use `subworkflow(id, name, inputs, opts?)` from `@blokjs/core`.

```ts
const receipt = subworkflow("receipt", "send-receipt", { orderId: order.id });
step("respond", RespondNode, { body: receipt.data }, { ephemeral: true });
```

The parent step inputs become the child workflow's request body. With
`wait: true` (default), the child response is stored at the parent step key and
the returned handle points there. The child name must match the registered
workflow name.

## Worker Workflows

Use the same handle DSL. The entry handle is `job`.

```ts
import { step, workflow } from "@blokjs/core";

export default workflow(
  "process-background-job",
  { version: "1.0.0", trigger: { worker: { queue: "background-jobs", concurrency: 5, retries: 3 } } },
  (job) => {
    step("process", processJob, {
      payload: job.body,
      jobId: job.params.jobId,
      attempt: job.params.attempt,
    });
  },
);
```

Runtime mapping:

```txt
job.body                 -> job payload
job.params.queue         -> queue name
job.params.jobId         -> job id
job.params.attempt       -> current attempt
ctx.vars._worker_job     -> full runtime metadata inside node execute only
```

`trigger.queue` is not a usable trigger kind. Use `worker`.

## Trigger Types

| Trigger | Key config |
|---|---|
| `http` | `method`, `path`, `accept` |
| `grpc` | `service`, `method`, `proto` |
| `cron` | `schedule`, `timezone` |
| `pubsub` | `provider`, `topic`, `subscription` |
| `webhook` | `source`, `events`, `secret` |
| `websocket` | `events`, `path` |
| `sse` | `events`, `channels`, `path` |
| `mcp` | `path`, `serverName`, `tool` or `resource`, `transports` |
| `worker` | `queue`, `concurrency`, `retries`, `provider` |

Trigger-level middleware, scheduling, concurrency keys, and reliability options
apply across trigger kinds when supported by their schema.

## Runtime Nodes

TypeScript nodes run in-process. Other runtimes use `type: "runtime.<lang>"`
through sidecars.

| Runtime | Step type | Default port |
|---|---|---|
| Go | `runtime.go` | 9001 |
| Rust | `runtime.rust` | 9002 |
| Java | `runtime.java` | 9003 |
| C# | `runtime.csharp` | 9004 |
| PHP | `runtime.php` | 9005 |
| Ruby | `runtime.ruby` | 9006 |
| Python3 | `runtime.python3` | 9007 |

Use generated runtime stubs when available, then pass the stub node value to
`step()`.

## Legacy Object/JSON Workflows

The object-style `workflow({ steps: [...] })` surface in `@blokjs/helper` and
JSON workflows remain supported for compatibility and migration. New TypeScript
workflows should use callback handles.

| Legacy v1 / mapper form | v2 IR meaning | Handle DSL authoring |
|---|---|---|
| `steps[].name` + `nodes[name].inputs` | `steps[].id` + inline `inputs` | `step("id", node, inputs)` |
| `steps[].node` | `steps[].use` | pass the node object to `step()` |
| `set_var: true` | default persistence | no option needed |
| `set_var: false` | `ephemeral: true` | `step("id", node, inputs, { ephemeral: true })` |
| previous response reads | previous step result | keep and pass the producing handle |
| request/body reads | trigger request | read the entry handle |
| template strings | mapper template | `tpl` |
| raw branch comparison | branch expression | branch operators or boolean handle |

`blokctl migrate workflows` converts old workflow shapes. The runner rejects
the removed `set_var` field at load time.

## Testing

Use Vitest. Focus tests around the touched package, then run broader pipelines
for shared behavior.

```bash
bun run --filter @blokjs/runner test
bun run --filter blokctl test
bun run --filter @blokjs/runner typecheck
bun run lint:check
bun run ci:fast
```

Testing utilities:

- `NodeTestHarness` for individual nodes.
- `WorkflowTestRunner` for workflow integration tests.
- `@blokjs/core/testing` re-exports the public test surface.

## Blok Studio

Studio lives in `apps/studio` and is served at `/__blok` by triggers that enable
tracing. It shows runs, step inputs/outputs, errors, logs, metrics, queues, and
concurrency state.

## Import Patterns

```ts
// New authoring surface
import { defineNode, workflow, step, branch, forEach, switchOn, tryCatch, tpl, js, http } from "@blokjs/core";
import { eq, ne, gt, gte, lt, lte, not } from "@blokjs/core";

// Runtime/testing internals when needed
import { Configuration, Runner } from "@blokjs/core/runtime";
import { NodeTestHarness, WorkflowTestRunner } from "@blokjs/core/testing";

// Shared runtime types
import type { Context, RequestContext, ResponseContext } from "@blokjs/shared";

// Zod
import { z } from "zod";
```

## Do Not

- Do not author new workflow data flow with `$` proxies, mapper strings, or raw
  condition strings.
- Do not mutate `ctx.state` or `ctx.vars` inside nodes.
- Do not read ephemeral handles.
- Do not reuse step ids anywhere in a workflow.
- Do not name a `forEach` `as` key after an existing step id or outer loop key.
- Do not create class-based nodes.
- Do not skip Zod schemas.
- Do not use `any` unless there is no reasonable alternative.
- Do not hardcode runtime ports when env vars exist.
- Do not edit generated `.blok/runtimes/` files.
- Do not use ESLint/Prettier.

## Do

- Keep GitHub Project issue/PR status current when doing roadmap work.
- Use one branch and one PR per issue.
- Use `defineNode()` for nodes and callback handles for workflows.
- Keep nodes small and single-purpose.
- Run focused tests first, then the local pipeline relevant to the change.
