# Blok Framework — authoring guide

Blok is a TypeScript-first workflow orchestration framework. You will be asked
to write **nodes** and **workflows**. This file is the authoring contract; it is
consistent with `AGENTS.md`, `CLAUDE.md` and
`docs/d/fundamentals/context-and-state.mdx` and does not repeat them.

Everything below describes the **current** surface (v2). If you have seen older
Blok code — `Workflow().addStep()`, `Nodes.ts` registries, `set_var`,
`ctx.vars`, `$` proxies, `"js/ctx…"` input strings — do not write it. Some of it
still loads for compatibility; none of it is how you author.

---

## 1. The model

Two building blocks:

- **Node** — one small typed function. Validates input with Zod, does one thing,
  returns output.
- **Workflow** — a declarative pipeline that chains nodes and moves data between
  them.

**Golden rule: a node never imports or calls another node.** A node does not
know other nodes exist. If B needs A's result, write a workflow that runs A then
B and passes A's handle into B's inputs.

Data flow: every step that succeeds has its output persisted at
`ctx.state[<step id>]`. A step that throws writes nothing. `step()` hands you a
typed **handle** to that slot — that handle is the only read path you author.

---

## 2. Nodes — `defineNode`

```ts
// file: nodes.ts
import { defineNode } from "@blokjs/core";
import { z } from "zod";

const OrderSchema = z.object({
  id: z.string(),
  total: z.number(),
  customer: z.object({ email: z.string().email() }),
  items: z.array(z.object({ sku: z.string(), qty: z.number() })),
});

export const validateOrder = defineNode({
  name: "validate-order",
  description: "Parses and validates an incoming order payload",
  input: z.object({ body: z.unknown() }),
  output: OrderSchema.extend({ inStock: z.boolean() }),
  async execute(ctx, input) {
    const order = OrderSchema.parse(input.body);
    ctx.logger.log(`validating order ${order.id}`);
    return { ...order, inStock: order.items.length > 0 };
  },
});

export const chargeCard = defineNode({
  name: "charge-card",
  description: "Charges a card for an order total",
  input: z.object({ orderId: z.string(), amount: z.number() }),
  output: z.object({ receipt: z.string() }),
  async execute(ctx, input) {
    const res = await fetch("https://payments.example/charge", {
      method: "POST",
      body: JSON.stringify(input),
      signal: ctx.signal,
    });
    if (!res.ok) throw new Error(`charge failed: ${res.status}`);
    return { receipt: `rc_${input.orderId}` };
  },
});

export const reserveInventory = defineNode({
  name: "reserve-inventory",
  description: "Reserves one SKU",
  input: z.object({ sku: z.string(), index: z.number() }),
  output: z.object({ reserved: z.boolean() }),
  async execute(_ctx, input) {
    return { reserved: input.sku.length > 0 };
  },
});

export const notify = defineNode({
  name: "notify",
  description: "Sends a notification",
  input: z.object({ message: z.string(), code: z.number().optional() }),
  output: z.object({ sent: z.boolean() }),
  async execute(_ctx, input) {
    return { sent: input.message.length > 0 };
  },
});

export const summarizeReservations = defineNode({
  name: "summarize-reservations",
  description: "Counts reservation results",
  input: z.object({ results: z.array(z.unknown()) }),
  output: z.object({ count: z.number() }),
  async execute(_ctx, input) {
    return { count: input.results.length };
  },
});

export const refundOrder = defineNode({
  name: "refund-order",
  description: "Refunds a charge",
  input: z.object({ reason: z.string() }),
  output: z.object({ refunded: z.boolean() }),
  async execute(_ctx, input) {
    return { refunded: input.reason.length > 0 };
  },
});
```

Hard rules:

1. `defineNode()` only. Never a class extending `BlokService`.
2. Keep both Zod `input` and `output` schemas. The `output` schema is what makes
   handles typed and what `blokctl check` validates references against — a node
   with no `output` schema silently opts out of that checking.
3. One node, one responsibility. Fetching and formatting are two nodes.
4. Never import another node.
5. No `any`. Use `unknown` and narrow (`z.unknown()` + `parse`).
6. Throw on failure. A thrown step writes no state and fails the run.
7. **Never assign to `ctx.state` or `ctx.vars`.** Return the value; the runner
   persists it.

The node-side `ctx` is for runtime concerns only:

| Field | Use |
|---|---|
| `ctx.request` | Trigger payload in runtime form. |
| `ctx.logger` | Structured logs that appear in traces and Studio. |
| `ctx.env` | Environment variables. |
| `ctx.signal` | Cooperative cancellation — pass it to `fetch`/long work. |
| `ctx.publish(name, value)` | Rare side-channel publication. Prefer returning data. |
| `ctx.connection` | WebSocket-only. Prefer helper nodes. |
| `ctx.stream` | SSE-only. Prefer helper nodes. |

Nodes live in `src/nodes/<category>/<name>/index.ts` (`auth/`, `users/`,
`orders/`, `integrations/`, `transforms/`, `db/`, …). There is **no node
registry file** — a `defineNode()` node registers itself when its module is
imported, and published nodes are referenced by package name (`@blokjs/api-call`).

---

## 3. Workflows — the typed-handle DSL

```ts
// file: order-intake.ts
import { branch, gt, http, step, tpl, workflow } from "@blokjs/core";
import { z } from "zod";
import { chargeCard, notify, validateOrder } from "./nodes";

export default workflow(
  "order-intake",
  {
    version: "1.0.0",
    trigger: http.post("/orders"),
    input: z.object({ id: z.string(), total: z.number() }),
  },
  (req) => {
    const order = step("validate", validateOrder, { body: req.body });

    const charge = step("charge", chargeCard, {
      orderId: order.id,
      amount: order.total,
    });

    step("summary", notify, {
      message: tpl`order ${order.id} charged (${charge.receipt})`,
    });

    branch("big-order", gt(order.total, 100), {
      then: () => {
        step("vip", notify, { message: tpl`VIP order ${order.id}` });
      },
      else: () => {
        step("standard", notify, { message: tpl`standard order ${order.id}` });
      },
    });
  },
);
```

The whole authoring rule:

- `workflow(name, opts, build)` defines it. `opts` carries `version`, `trigger`,
  and optionally `input`/`output` Zod schemas (an `input` schema types the entry
  handle's `body`).
- `build(entry)` receives the **entry handle** for the trigger payload.
- `step(id, node, inputs, opts?)` runs a node and returns a typed output handle.
- Pass handles straight into later step inputs — `order`, `order.id`,
  `order.items[0].sku`.
- `tpl` for strings that embed handles.
- `eq`/`ne`/`gt`/`gte`/`lt`/`lte`/`not`, or a boolean handle, for conditions.
- `js` tagged template **only** for what handles cannot express.

Import surface:

```ts
import {
  workflow, step, subworkflow,
  branch, forEach, switchOn, tryCatch,
  tpl, js,
  eq, ne, gt, gte, lt, lte, not,
  http, node, runtimeNode,
  defineNode,
} from "@blokjs/core";
import { runNode, runWorkflow } from "@blokjs/core/testing";
// `state()` (§3) is only on the light DSL subpath, not the root barrel.
import { state } from "@blokjs/core/dsl";
```

### Entry handles

Name the callback argument by trigger kind. All of them lower to the same
trigger payload; the name and type are for clarity and inference.

| Trigger | Handle | Common reads |
|---|---|---|
| `http` | `req` | `req.body`, `req.params.id`, `req.query.q`, `req.headers.authorization` |
| `worker` | `job` | `job.body`, `job.params.queue`, `job.params.jobId`, `job.params.attempt` |
| `webhook` | `event` | `event.body`, `event.headers`, `event.params` |
| `pubsub` | `msg` | `msg.body`, `msg.headers`, `msg.params` |
| `cron` | `tick` | `tick.params`, `tick.headers` |
| `grpc` | `rpc` | `rpc.body`, `rpc.params`, `rpc.headers` |
| `sse` | `stream` | `stream.params`, `stream.query`, `stream.headers` |
| `websocket` | `conn` | `conn.body`, `conn.params`, `conn.headers` |
| `mcp` | `call` | `call.body`, `call.headers` |

### Strings and the escape hatch

```ts
import { http, js, step, tpl, workflow } from "@blokjs/core";
import { notify, validateOrder } from "./nodes";

export default workflow("strings", { version: "1.0.0", trigger: http.post("/strings") }, (req) => {
  const order = step("validate", validateOrder, { body: req.body });

  // Structural — preferred. Survives static analysis, Studio, and blokctl check.
  step("notify", notify, { message: tpl`order ${order.id} totals ${order.total}` });

  // Escape hatch — opaque to all of the above. Use only when nothing else fits:
  // ternaries, `??` defaults, `.map`, `Date.now()`, env reads.
  step("classify", notify, {
    message: js`${order.total} > 100 ? "premium" : "standard"`,
  });
});
```

`@blokjs/expr` is the one exception to every rule here: its `expression` input
is plain JavaScript that node evaluates. Do not prefix it.

### Persistence knobs (fourth argument)

| Knob | Effect |
|---|---|
| none | Store at `ctx.state[id]`. |
| `{ as: "name" }` | Store at `ctx.state[name]`; the handle roots there. |
| `{ spread: true }` | Shallow-merge the output's keys into top-level state; read per key. |
| `{ ephemeral: true }` | Store nothing. The handle is deliberately unreadable. |

`as` and `spread` are mutually exclusive. `ephemeral` is for side effects only —
logging, audit, response helpers, emitters.

### The four footguns

1. **Arm-scoped handles do not escape their arm.** A handle made inside
   `then`/`else`/`case`/`try`/`catch` is readable only there. To use a value
   afterwards: use the primitive's own returned handle (`forEach` results), or
   have every arm write to one shared `as` key with distinct step ids.
2. **Ephemeral handles are unreadable.** Reading one is a compile error and a
   runtime throw.
3. **Step ids are one flat namespace**, including ids in mutually exclusive
   arms. Duplicates throw at authoring time.
4. **`forEach` `as`/`asIndex` keys share that same namespace.** `forEach` writes
   the item to `ctx.state[as]` and the index to `ctx.state[as + "Index"]`. Never
   name them after a step id or an outer loop key.

`state("key")` (from `@blokjs/core/dsl`) mints an untyped `Handle<unknown>` for
a state key no node's output declares — a `ctx.publish` key, a cross-runtime
`vars_delta`. Reach for it only then; prefer the typed step handle.

---

## 4. Control flow

```ts
import { type Handle, branch, forEach, http, step, subworkflow, switchOn, tpl, tryCatch, workflow } from "@blokjs/core";
import { chargeCard, notify, refundOrder, reserveInventory, summarizeReservations, validateOrder } from "./nodes";

export default workflow("control-flow-tour", { version: "1.0.0", trigger: http.post("/tour") }, (req) => {
  const order = step("validate", validateOrder, { body: req.body });

  // A boolean handle is a truthiness check; `else` is optional.
  branch("stock", order.inStock, {
    then: () => {
      step("reserve-all", notify, { message: "reserving" });
    },
  });

  // `results` is readable after the loop; `item`/`index` are not.
  const results = forEach(
    order.items,
    (item, index) => {
      step("reserve", reserveInventory, { sku: item.sku, index });
    },
    { as: "line" },
  );
  step("summarize", summarizeReservations, { results });

  // `when` values are STATIC LITERALS — never a handle. First match wins.
  switchOn(
    order.customer.email,
    {
      cases: [
        { when: "vip@example.com", do: () => step("vip", notify, { message: "vip" }) },
        { when: ["a@example.com", "b@example.com"], do: () => step("known", notify, { message: "known" }) },
      ],
      default: () => step("unknown-customer", notify, { message: "unknown" }, { ephemeral: true }),
    },
    { id: "route-customer" },
  );

  // `error` models the catch envelope: message/name always, stack/code/stepId optional.
  tryCatch("payment", {
    try: () => {
      step("charge", chargeCard, { orderId: order.id, amount: order.total });
    },
    catch: (error) => {
      step("refund", refundOrder, { reason: error.message });
      step("alert", notify, { message: error.message, code: error.code });
    },
    finally: () => {
      step("metric", notify, { message: "payment attempted" }, { ephemeral: true });
    },
  });

  // Another named workflow as a step. Inputs become the child's request body.
  // `subworkflow()` returns an UNTYPED `Handle<unknown>` (no node schema to
  // infer from), so passing it whole is fine but a field read needs a cast.
  const receipt = subworkflow("receipt", "send-receipt", { orderId: order.id }) as Handle<{ data: string }>;
  step("respond", notify, { message: tpl`receipt ${receipt.data}` }, { ephemeral: true });
});
```

Notes that bite:

- `switchOn` matches `case.when` literally with no resolution. A handle there
  would never match.
- `branch` conditions come from the comparators or a boolean handle. Do not
  hand-write condition strings.
- `forEach` derives its ids: the results land at `<as>Results` (here
  `lineResults`) and the item/index at `<as>` / `<as>Index`. All three share the
  step-id namespace — footgun 4.
- `subworkflow(id, name, inputs, opts?)` defaults to `wait: true`. With
  `wait: false` the parent gets dispatch metadata, not the child's result. A
  handle as `name` gives polymorphic dispatch — pair it with `allowList`
  whenever the value comes from the caller.
- `wait` (a mid-flight pause) is **not** in this DSL. It is an object/JSON step
  shape — see §5 and §8.

---

## 5. Fields that fail silently — read this before using them

Two field families do **not** behave like step inputs. Getting the form wrong
produces no error, no warning, and wrong behaviour that looks like success.

### 5.1 Literal-only: `wait.for` / `wait.until`

A `wait` step's duration is parsed at workflow **load** time, before any request
context exists, and no Mapper pass ever runs over it. An expression there — a
handle, a `{$ref}`, a `tpl`, a `"js/…"` string — is stored verbatim and then
fails to parse (or waits for a nonsense deadline). **Dynamic delays are not
expressible today** (issue #704).

```json
{ "id": "throttle", "wait": { "for": "500ms" } }
{ "id": "until-midnight", "wait": { "until": "2026-01-01T00:00:00Z" } }
```

`for` takes a duration string (`"500ms"`, `"30s"`, `"5m"`, `"3h"`) or a number
of milliseconds; `until` takes an ISO timestamp or epoch millis. Set exactly
one. If you need a computed delay, split the workflow and put `delay` on the
continuation's trigger, or sleep inside a node and accept that it burns a worker
slot.

### 5.2 Expression-required: `idempotencyKey`, `concurrencyKey`, `debounce.key`

These resolve a key per request. The resolver evaluates the value **only** if it
is a `js/`-prefixed string; anything else is taken as a **literal key** (issue
#706). So a plain string that looks like an expression becomes one constant key
shared by every request:

- `idempotencyKey` constant ⇒ the cache namespace
  `(workflow, stepId, key)` is identical for everyone, so the first response is
  replayed to every later caller for the 24h TTL. On a payment or order step
  that is cross-customer data bleed.
- `concurrencyKey` constant ⇒ every tenant collapses into one bucket, so a
  per-tenant limit of N becomes a global limit of N.

In the TS DSL, pass a **handle** for a step's `idempotencyKey` — `step()` lowers
it to the correct form for you:

```ts
import { http, step, workflow } from "@blokjs/core";
import { chargeCard, validateOrder } from "./nodes";

export default workflow(
  "reliable-charge",
  {
    version: "1.0.0",
    trigger: http.post("/charge", {
      // Trigger config is resolved at run-entry, before any handle exists, so
      // these two are strings — and they MUST carry the `js/` prefix.
      concurrencyKey: "js/ctx.request.body.tenantId",
      concurrencyLimit: 5,
    }),
  },
  (req) => {
    const order = step("validate", validateOrder, { body: req.body });
    step(
      "charge",
      chargeCard,
      { orderId: order.id, amount: order.total },
      // A handle — lowered for you. A deliberate literal ("nightly-batch") is
      // also valid. What is NOT valid is an expression without the prefix.
      { idempotencyKey: order.id },
    );
  },
);
```

Rule of thumb: **step** `idempotencyKey` → pass a handle. **Trigger config**
(`concurrencyKey`, `debounce.key`, trigger-level `idempotencyKey`) → a
`js/`-prefixed string, or a literal you actually meant to be constant.

### 5.3 The other control positions

`branch.when` / `loop.while` (raw `ctx.*`, no prefix), `switch.on`,
`forEach.in`, `subworkflow` — in JSON these are path strings, not structural
refs. In the TS DSL you never write them: `branch`, `switchOn`, `forEach` and
`subworkflow` take handles and emit the right form.

---

## 6. Testing

`runNode` / `runWorkflow` from `@blokjs/core/testing`. No server, no Docker, no
vitest config, no manual node registration. Write tests this way.

```ts
import { runNode, runWorkflow } from "@blokjs/core/testing";
import orderIntake from "./order-intake";
import { validateOrder } from "./nodes";

declare function test(name: string, fn: () => Promise<void>): void;
declare function expect(value: unknown): { toBe(v: unknown): void; toEqual(v: unknown): void };

test("validate-order accepts a well-formed order", async () => {
  const out = await runNode(validateOrder, {
    body: { id: "o-1", total: 120, customer: { email: "a@b.co" }, items: [{ sku: "x", qty: 1 }] },
  });
  expect(out.inStock).toBe(true);
});

test("order-intake charges and takes the VIP arm", async () => {
  const run = await runWorkflow(
    orderIntake,
    { id: "o-1", total: 120, customer: { email: "a@b.co" }, items: [{ sku: "x", qty: 1 }] },
    { mock: { "charge-card": async () => ({ receipt: "rc_1" }) } },
  );

  expect(run.ok).toBe(true);
  expect(run.state("charge")).toEqual({ receipt: "rc_1" });
  expect(run.step("vip")?.executed).toBe(true);
  expect(run.step("standard")?.executed).toBe(false);
});
```

- `runNode(node, input, opts?)` runs one node through its real Zod-validated
  path and returns its typed output. A Zod violation or a throw **rejects** —
  assert failures with `await expect(runNode(...)).rejects.toThrow(...)`.
- `runWorkflow(wf, input, opts?)` takes the `workflow()` export directly and
  runs the real engine. `run.ok`, `run.response`, `run.error`, `run.state(id)`,
  `run.step(id)` (`inputs` after the Mapper resolved them, `output`, `executed`,
  `calls`), `run.steps`, `run.stateAll`.
- `opts.mock` replaces nodes **by node key** and validates each mock's return
  against that node's real Zod output schema — a mock cannot promise a field the
  node never returns. Also `opts.nodes`, `opts.env`, `opts.timeout`.
- `NodeTestHarness` / `WorkflowTestRunner` are the classes underneath. Reach for
  them only when you need the raw result envelope.

Author docs: `docs/d/fundamentals/testing.mdx`.

---

## 7. Triggers and runtimes

| Trigger | Key config |
|---|---|
| `http` | `method`, `path`, `accept` |
| `worker` | `queue`, `concurrency`, `retries`, `provider` |
| `cron` | `schedule`, `timezone` |
| `pubsub` | `provider`, `topic`, `subscription` |
| `webhook` | `source`, `events`, `secret` |
| `websocket` | `events`, `path` |
| `sse` | `events`, `channels`, `path` |
| `grpc` | `service`, `method`, `proto` |
| `mcp` | `path`, `serverName`, `tool` or `resource`, `transports` |

There is no `queue` trigger — use `worker`. For an HTTP wildcard use `"ANY"` or
`http.any()`, never `"*"`. `http.get/post/put/patch/delete/any(path?, opts?)`
builds the trigger block; omit `path` for file-based routing.

A worker workflow is the same DSL with `job` as the entry handle:

```ts
import { step, workflow } from "@blokjs/core";
import { notify } from "./nodes";

export default workflow(
  "process-background-job",
  { version: "1.0.0", trigger: { worker: { queue: "background-jobs", concurrency: 5, retries: 3 } } },
  (job) => {
    step("process", notify, { message: job.params.jobId });
  },
);
```

TypeScript nodes run in-process. Other languages run as gRPC sidecars; a step
targets them with `type: "runtime.<lang>"`, which `runtimeNode()` emits for you.

| Runtime | Step type | Default port |
|---|---|---|
| Go | `runtime.go` | 9001 |
| Rust | `runtime.rust` | 9002 |
| Java | `runtime.java` | 9003 |
| C# | `runtime.csharp` | 9004 |
| PHP | `runtime.php` | 9005 |
| Ruby | `runtime.ruby` | 9006 |
| Python3 | `runtime.python3` | 9007 |

```ts
import { http, runtimeNode, step, workflow } from "@blokjs/core";

// `blokctl nodes sync` generates these stubs; hand-writing one is fine too.
const classify = runtimeNode<{ text: string }, { label: string }>("classify", "runtime.python3");

export default workflow("classify-text", { version: "1.0.0", trigger: http.post("/classify") }, (req) => {
  step("classify", classify, { text: req.body });
});
```

Hosts/ports come from `RUNTIME_<LANG>_HOST` / `RUNTIME_<LANG>_PORT`. Never
hardcode them. Your runtime nodes live in `runtimes/<lang>/nodes/`; never edit
the generated SDK under `.blok/runtimes/`.

---

## 8. JSON workflows

JSON has no `step()` call to return a handle, so it carries the same references
**structurally** in step `inputs`:

```json
{
  "name": "order-intake",
  "version": "1.0.0",
  "trigger": { "http": { "method": "POST", "path": "/orders" } },
  "steps": [
    { "id": "validate", "use": "validate-order",
      "inputs": { "body": { "$ref": { "step": "@trigger", "path": ["body"] } } } },
    { "id": "charge", "use": "charge-card",
      "inputs": {
        "orderId": { "$ref": { "step": "validate", "path": ["id"] } },
        "amount":  { "$ref": { "step": "validate", "path": ["total"] } }
      },
      "idempotencyKey": "js/ctx.state.validate.id" },
    { "id": "summary", "use": "notify",
      "inputs": { "message": { "$tpl": ["order ", { "$ref": { "step": "validate", "path": ["id"] } }, " charged"] } } }
  ]
}
```

- `{"$ref": {"step": "<id>", "path": [...]}}` — `path: []` is the whole output.
- `"@trigger"` is the trigger payload; `"@error"` is the caught error envelope
  inside a `tryCatch` catch arm.
- `{"$tpl": ["text", {"$ref": …}, "more"]}` for a string embedding a reference.
- A load-boundary pass compiles these to the runtime wire format. You never
  write that wire format.

Hand-written `"js/ctx…"` step inputs still load, but warn once per workflow at
boot (`BLOK_SUPPRESS_LEGACY_EXPR_WARNING=1` silences) and are removed next
major. **`blokctl migrate refs` rewrites them** — run it instead of editing by
hand. See `docs/c/migration-guides/legacy-expression-strings.mdx`.

Control and trigger-config positions are not step inputs and keep their own
forms — see §5.

---

## 9. blokctl

```bash
blokctl create project --name my-app --triggers http --runtimes node,python3 --examples
blokctl create node --style function --runtime typescript
blokctl create workflow

blokctl dev              # runtimes + triggers, health-checked, one process tree
blokctl check            # static validation: refs, schemas, footguns 1/2/4
blokctl nodes sync       # regenerate typed cross-runtime node stubs
blokctl migrate refs     # "js/ctx…" inputs → structural {$ref}/{$tpl}
blokctl migrate workflows # v1 shapes (set_var, name/node steps) → v2
```

Repo commands: `bun install`, `bun run build` (never a bare
`nx run-many -t build` — the root script appends the Node-ESM fixup),
`bun run test`, `bun run lint`, `bun run ci:fast`.

Scaffolded layout: `src/nodes/<category>/<name>/index.ts`,
`src/workflows/<trigger>/<name>.ts`, JSON workflows under `workflows/json/`.
Routing is file-based — there is no `Nodes.ts` and no `Workflows.ts` to update.

---

## 10. Do NOT

- Do not author data flow with `"js/ctx…"` strings, raw `ctx` condition strings,
  or `$` proxies (`$` is deleted — the import does not compile).
- Do not write `ctx.state` or `ctx.vars` inside a node.
- Do not read an ephemeral handle.
- Do not reuse a step id anywhere in a workflow, including across arms.
- Do not name a `forEach` `as` key after a step id or an outer loop key.
- Do not put an expression in `wait.for` / `wait.until` (§5.1).
- Do not put an unprefixed expression in `idempotencyKey` / `concurrencyKey` /
  `debounce.key` (§5.2).
- Do not create class-based `BlokService` nodes.
- Do not skip Zod schemas.
- Do not use `any`.
- Do not use a `queue` trigger; use `worker`.
- Do not use `"*"` for the HTTP wildcard; use `"ANY"` / `http.any()`.
- Do not edit generated `.blok/runtimes/` files.
- Do not use ESLint or Prettier; this repo uses Biome.

---

## 11. Debugging checklist

| Symptom | Cause |
|---|---|
| "Node not found" | The node module was never imported, or the `use` key does not match the node's `name`. |
| "Duplicate step id" | Footgun 3 — ids are flat, including across mutually exclusive arms. |
| Zod validation error on a step | The producing node's output shape does not match what the consumer's `input` schema declares. |
| `ctx.state["x"]` undefined | The step threw (a failed step writes nothing), or it is `ephemeral`, or the id is a typo. |
| Compile error reading a handle | Footgun 1 (arm-scoped) or 2 (ephemeral). Both are deliberate. |
| A `switch` case never matches | `when` must be a static literal — a handle there never matches. |
| Step input arrives as the literal expression text | A mapper expression failed to resolve. `BLOK_MAPPER_MODE=strict` (the default) throws instead; `warn` logs and passes it through. |
| Every request gets the first request's response | Constant `idempotencyKey` — §5.2. |
| A per-tenant limit behaves globally | Constant `concurrencyKey` — §5.2. |
| A `wait` never fires, or fires immediately | An expression in `wait.for`/`until` — §5.1. |
| "set_var was removed in v0.5" | Drop `set_var: true`; `set_var: false` becomes `ephemeral: true`. Run `blokctl migrate workflows`. |
| Runtime step fails to dispatch | The sidecar is not running, or `RUNTIME_<LANG>_*` env points elsewhere. |
