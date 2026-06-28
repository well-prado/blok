# AGENTS.md — Building with Blok

This is the **authoring guide** for this Blok project. It teaches an AI agent (and you)
the one correct way to build nodes, workflows, and triggers. Read it before writing code.

Blok is a **multi-trigger, multi-runtime workflow framework**. You compose small,
typed, single-purpose **nodes** into declarative **workflows**. The runner resolves
data between steps and persists state automatically.

Two facts shape everything here:

- **HTTP is ONE of 9 triggers, not the default.** Every workflow declares exactly one
  trigger. Reflexively picking `http` is the most common mistake — start from the
  decision table in §6.
- **Nodes run in 8 runtimes.** TypeScript runs in-process; the other 7 (`go`, `rust`,
  `java`, `csharp`, `php`, `ruby`, `python3`) run as gRPC sidecars. A step routes to a
  sidecar with `type: "runtime.<lang>"`.

> **Read `.blok/config.json` first.** It records which triggers and runtimes this project
> was scaffolded with. Author for THOSE — if it's a worker/cron project, don't write an
> HTTP endpoint. Match the existing workflows under `src/workflows/`.

---

## 0. The authoring surface (read this once)

Workflows are authored in **TypeScript** with the **typed-handle DSL** from
`@blokjs/core`. Every value flows through a **handle** — a typed reference to a prior
step's output. There is **no `$`, no `js/`, no raw `ctx` strings** in authoring.

```ts
import { workflow, step, branch, forEach, switchOn, tryCatch, http, tpl, gt } from "@blokjs/core";

export default workflow("order-intake", { version: "1.0.0", trigger: http.post("/orders") }, (req) => {
  // step(id, node, inputs) returns a TYPED handle shaped like the node's output.
  const order = step("validate", validateOrder, { qty: req.body.qty });

  // Reference a handle field anywhere downstream — it records a ref the runner resolves.
  step("summary", summarize, { line: tpl`order of ${order.qty} item(s)` });

  // Control flow: a comparator (gt/eq/lt/…) builds the condition; arms are callbacks.
  branch("lane", gt(order.qty, 10), {
    then: () => { step("bulk", routeOrder, { lane: "bulk" }); },
    else: () => { step("standard", routeOrder, { lane: "standard" }); },
  });
});
```

What you import from `@blokjs/core`:

| Import | Purpose |
|---|---|
| `workflow(name, opts, build)` | Define a workflow. `build` is a callback receiving the trigger's **entry handle**. |
| `step(id, node, inputs, opts?)` | Run a node. Returns a typed **handle** (see §2). |
| `http.{get,post,put,delete,patch,any}(path?, opts?)` | Build an HTTP trigger config. |
| `branch` / `forEach` / `switchOn` / `tryCatch` | Control flow (§3). |
| `eq, ne, gt, gte, lt, lte, not` | Typed comparators for branch conditions. |
| `tpl` | Tagged template that embeds handles in strings safely. |
| `defineNode` | Author a node (§1). |
| `Handle`, `RuntimeNode`, `runtimeNode` (types) | Handle + cross-runtime stub types. |

The full engine lives at `@blokjs/core/runtime`; test utilities at `@blokjs/core/testing`.
The object-style `workflow({ steps: [...] })` from `@blokjs/helper` and JSON workflows are
**legacy-but-supported** (they compile to the same IR) — see §11.

---

## 1. Authoring a node — `defineNode()`

A node is a pure, validated, single-purpose function. Always `export default defineNode(...)`.

```ts
import { defineNode } from "@blokjs/core";
import { z } from "zod";

export default defineNode({
  name: "fetch-user",                              // the canonical `use:` ref (see naming below)
  description: "Fetches a user by ID",             // shown in the node catalog / Studio
  input:  z.object({ userId: z.string().uuid() }), // validated BEFORE execute → 400 on failure
  output: z.object({                               // validated AFTER execute → 500 on failure
    user: z.object({ id: z.string(), name: z.string(), email: z.string().email() }),
  }),
  async execute(ctx, input) {
    const user = await db.users.findById(input.userId); // `input` is type-safe + validated
    return { user };                                    // MUST match the output schema
  },
});
```

### The `execute(ctx, input)` contract

- `input` is already **validated and typed** from your Zod `input` schema.
- The **return value must match** the Zod `output` schema (validated; a mismatch throws 500).
- `ctx` exposes:
  - `ctx.request` — the trigger payload (`body`, `headers`, `params`, `query`, `method`).
  - `ctx.logger` — structured logging (`ctx.logger.log(...)`); surfaces in Studio.
  - `ctx.env` — environment variables.
  - `ctx.signal` — an `AbortSignal`. For long work, pass it to `fetch(url, { signal: ctx.signal })`
    or check `ctx.signal.aborted` periodically to support cooperative cancellation.
  - `ctx.publish(name, value)` — publish a true side-channel value (rare).

### Hard rules for nodes (guardrails)

- **Zod `input` and `output` are mandatory.** They are the node's contract.
- **Never write `ctx.state` / `ctx.vars` inside `execute`.** A node is pure — RETURN your
  output and the runner persists it to `ctx.state["<step-id>"]`. Upstream values arrive as
  `input.*` (mapped in the workflow), not by reading `ctx.vars`.
- **No `any`.** Use `z.unknown()` (or a precise schema) if a field is truly dynamic.
- **Throw plain `Error` on failure** → auto-wrapped to a `500`. A Zod validation failure
  → `400` automatically. Don't construct response envelopes inside a node.
- **No class-based `BlokService`.** `defineNode()` is the only supported node form.
- **JSON-serializable output.** No functions, class instances, or non-serializable values.

### Node naming + registration (ADR 0002)

- A node's `name` **is** its `use:` reference. `step("x", fetchUser, …)` resolves `fetchUser`
  by its `name`. Published nodes use a fully-qualified ref (`@blokjs/api-call`); your own
  nodes use a short project-local ref (`fetch-user`).
- **Two nodes must never claim the same `name`** — duplicate refs **throw at startup**
  (silent shadowing of a built-in like `@blokjs/jwt-verify` would be an auth-bypass risk).
- **Local nodes are auto-discovered.** Drop a node at `src/nodes/<name>/index.ts` (default
  export) and it registers automatically by its `name` — you never edit a central map.

### Nodes in another runtime (Go / Rust / Python / …)

A non-TS node runs in a per-language gRPC sidecar and is referenced from a step with
`type: "runtime.<lang>"`. Scaffold one with `blokctl create node <name> --runtime <lang>`.

| Runtime | Step `type` | gRPC port |
|---|---|---|
| Go | `runtime.go` | 9001 |
| Rust | `runtime.rust` | 9002 |
| Java | `runtime.java` | 9003 |
| C# | `runtime.csharp` | 9004 |
| PHP | `runtime.php` | 9005 |
| Ruby | `runtime.ruby` | 9006 |
| Python3 | `runtime.python3` | 9007 |

```ts
// In a workflow, route a step to a Python node:
step("score", riskModel, { features: order.features }, { type: "runtime.python3" });
```

---

## 2. Authoring a workflow — handles + persistence

`workflow(name, opts, build)`:

- `name` — unique workflow name (used by sub-workflow refs + Studio).
- `opts` — `{ version, trigger, middleware?, input?, output? }`.
- `build(entry)` — a callback. `entry` is the trigger's typed **entry handle**, named by
  convention per trigger: `http → req`, `worker → job`, `cron → tick`, `webhook → event`,
  `pubsub → msg`, `grpc → rpc`. Read `req.body`, `req.params.id`, `req.query.q`,
  `req.headers["x-…"]`. (A `cron` `tick` has no body — only `tick.params`.)

### Handles + the four persistence reads

`const h = step("id", node, inputs)` returns a **handle**:

- Every step **auto-persists** its output to `ctx.state["id"]` **on success** (a step that
  throws writes nothing). `h` / `h.field` is how you reference it later — never `$.state.id`.
- Field access (`h.user.id`, `order.qty`) records a typed reference the runner resolves
  before the next node runs. Arrays support index (`items[0]`) but **not** `.map`/`.length`
  in inputs — do that work inside a node.
- `tpl\`…${h.field}…\`` embeds a handle in a string. A bare template literal
  (`` `${h.field}` ``) loses the reference and throws — always use `tpl`.

### Persistence knobs (4th arg to `step`)

| Knob | Effect |
|---|---|
| *(none)* | Store at `ctx.state[id]` (the 95% case). |
| `{ as: "name" }` | Store at `ctx.state[name]` instead of `state[id]`. Mutually exclusive with `spread`. |
| `{ spread: true }` | Shallow-merge the node's `result.data` keys into `ctx.state` (multi-output nodes). |
| `{ ephemeral: true }` | Skip persistence — the handle is **unreadable** downstream. Use for logging / response-only steps. |

Per-step reliability also rides the 4th arg: `idempotencyKey`, `retry`, `maxDuration`,
`type` (§7).

---

## 3. Control-flow primitives

All from `@blokjs/core`. Arms are **callbacks**; `step()` calls inside an arm register into
that arm's sub-pipeline.

### `branch(id, condition, { then, else? })`

`condition` is a typed comparator (`gt(order.qty, 10)`) or a boolean handle (`stock.inStock`).

```ts
branch("route", stock.inStock, {
  then: () => { step("ship", shipNode, { id: order.id }); },
  else: () => { step("backorder", boNode, { id: order.id }); },
});
```

### `forEach(iterable, (item, index) => { … }, opts?)`

`iterable` is a handle to an array. `item`/`index` are per-iteration handles (readable only
inside the loop). The loop's result array is readable after it. `opts`: `{ as?, mode?, concurrency? }`
— `mode: "parallel"` bounds with `concurrency` (default 10).

```ts
const results = forEach(order.items, (item, i) => {
  step("reserve", reserveNode, { sku: item.sku, n: i });
}, { as: "line" });
step("count", countNode, { total: results.length });
```

### `switchOn(discriminant, { cases, default? }, { id })`

`discriminant` is a handle. Each `case.when` is a **static literal** (string/number/boolean,
or an array of them) — a handle never matches.

```ts
switchOn(event.kind, {
  cases: [
    { when: "payment",  do: () => { step("pay", payNode, { e: event.body }); } },
    { when: ["a", "b"], do: () => { step("ab", abNode, { e: event.body }); } },
  ],
  default: () => { step("unknown", logUnknown, { e: event.body }, { ephemeral: true }); },
}, { id: "route" });
```

### `tryCatch(id, { try, catch, finally? })`

`catch` receives a typed **error handle**: `.message`, `.name`, `.stack`, `.code` (upstream
HTTP status), `.stepId` (which step failed).

```ts
tryCatch("signup", {
  try:     () => { step("create", createUser, { email: req.body.email }); },
  catch:   (err) => { step("alert", notify, { message: err.message, code: err.code }); },
  finally: () => { step("metric", emitMetric, { event: "signup" }, { ephemeral: true }); },
});
```

### The four footguns ⚠️

1. **Arm-scoped handles don't escape their arm.** A handle minted inside a
   `branch`/`switchOn`/`tryCatch`/`forEach` arm is unreadable outside it (resolves to
   `undefined`). To use a result downstream, write **both arms to one `as:` key**
   (`step("a", …, { as: "result" })` in `then`, `step("b", …, { as: "result" })` in `else`),
   then read `result`.
2. **Ephemeral handles are unreadable.** Reading an `{ ephemeral: true }` step's handle
   resolves to `undefined`.
3. **Never reuse a step `id`** — including across mutually-exclusive arms. Ids are a flat
   per-workflow map; the runner **throws at load time**. Use `as:` when two arms must write
   the same downstream key.
4. **Never name a `forEach` `as:`/`asIndex` after an existing step id** (or another loop's
   `as`) — they share `ctx.state`; the runner **throws at load time**.

---

## 4. Context & state — the rules

- **Every step's output auto-persists to `ctx.state[id]` — on success only.** A step that
  errors writes nothing, so `ctx.state[<id>] === undefined` is a truthful "did it succeed?"
  check inside a `tryCatch.catch` arm.
- In authoring you never touch `ctx` directly — you reference **handles** returned by `step()`.
- Inside a node, `ctx` is the execution context (request/logger/env/signal) — read it, never
  write `ctx.state` from a node.
- The `branch`/`switchOn` `when` condition is evaluated by raw `Function("ctx", …)`. The typed
  comparators (`eq`/`gt`/…) emit the correct bare `ctx.*` form for you — **always use them**.
  A hand-written `js/…` or `$.…` condition string throws at runtime.

---

## 5. Controlling the HTTP response

By default the final step's output is the body (object → JSON, string → verbatim, both at
status 200). For status / headers / cookies / redirect / binary, end with **`@blokjs/respond`**
(auto-registered) and mark it `ephemeral: true`.

```ts
// Redirect
step("go", respond, { status: 302, headers: { Location: "/dashboard" } }, { ephemeral: true });

// Session cookie (cookies is an ARRAY of raw Set-Cookie strings)
step("login", respond, { body: { ok: true }, cookies: ["session=abc; Path=/; HttpOnly; SameSite=Lax"] }, { ephemeral: true });

// Binary download
step("file", respond, { body: pdf.bytes, contentType: "application/pdf",
  headers: { "Content-Disposition": 'attachment; filename="report.pdf"' } }, { ephemeral: true });
```

`@blokjs/respond` inputs: `body?` (string → verbatim, `Buffer`/`Uint8Array` → raw bytes, else
JSON), `status?` (default 200), `contentType?`, `headers?`, `cookies?` (`string[]`).

---

## 6. Choosing a trigger (do this FIRST, every time)

| What you're building | Trigger | Why not http |
|---|---|---|
| Respond to an HTTP/REST request; JSON API; HTML page; file download | **`http`** | — |
| Background / queued / async job; offload slow work | **`worker`** | http blocks the caller; jobs need a queue + retries + DLQ |
| Run on a schedule (nightly, hourly, cron) | **`cron`** | http only fires on a request |
| React to cloud topic/subscription events (cross-service) | **`pubsub`** | http isn't subscribed to a broker |
| One-way live push to a browser (tokens, progress, feed) | **`sse`** | a plain http response is one-shot |
| Bidirectional realtime (chat, live cursors) | **`websocket`** | http is half-duplex, no server push-back |
| Receive a signed provider webhook (Stripe / GitHub / Slack / Shopify / Svix) | **`webhook`** | http won't verify the HMAC signature |
| Expose a workflow as a tool/resource to an AI client (Cursor, Claude) | **`mcp`** | http isn't MCP |
| High-throughput typed RPC with a `.proto` contract | **`grpc`** | http/REST overhead is too high |

**Tie-breakers:** one-way stream → `sse`; two-way → `websocket`. Queue consumer → **`worker`**
(the `queue` trigger is **dead** — it throws at load; never emit `trigger: { queue: … }`).
Same-port family (`http`, `sse`, `websocket`, `webhook`, `mcp`) shares one Hono port;
cross-process family (`worker`, `cron`, `pubsub`, `grpc`) runs in its own process.

### Trigger config in the handle DSL

HTTP uses the `http.*` helper; everything else passes a raw block as `opts.trigger`:

```ts
workflow("jobs.process", { version: "1.0.0", trigger: { worker: { queue: "emails", retries: 3 } } }, (job) => {
  step("send", sendEmail, { to: job.body.to, jobId: job.params.jobId });
});

workflow("nightly.digest", { version: "1.0.0", trigger: { cron: { schedule: "0 8 * * *", timezone: "America/New_York" } } }, (tick) => {
  step("build", buildDigest, { day: tick.params.scheduledTime });
});
```

Config shapes (key fields; all triggers also accept the concurrency/scheduling knobs in §7):

- **http** — `{ method, path?, accept?, headers?, middleware? }`. `method` is
  `GET|POST|PUT|DELETE|PATCH|ANY` (use `"ANY"`, not `"*"`). Omit `path` for file-based routing.
- **worker** — `{ queue, provider?, concurrency?, timeout?, retries?, deadLetterQueue? }`.
  Providers: `in-memory` (default) / `nats` / `bullmq` / `kafka` / `rabbitmq` / `sqs` / `redis` / `pg-boss`.
  Read the job via `job.body`; metadata via `job.params.{queue,jobId,attempt}`.
- **cron** — `{ schedule, timezone? }`. `tick` has only `tick.params`, no body.
- **pubsub** — `{ provider?, topic, subscription?, ack?, maxMessages? }`.
- **webhook** — `{ provider?, path?, events?, signature?, tolerance? }`. Sources: `github`/`stripe`/`slack`/`shopify`/`svix`.
- **sse** — `{ events?, channels?, path?, heartbeatInterval? }`.
- **websocket** — `{ events?, rooms?, path?, maxConnections? }`.
- **mcp** — `{ path?, serverName?, tool?, resource? }`. The workflow's `input` Zod schema
  becomes the tool's `inputSchema`.

---

## 7. Reliability — per-step vs per-trigger

**On a STEP** (4th arg to `step`):

- `idempotencyKey: req.body.requestId` — cache by `(workflow, step.id, key)`; on a rerun with
  the same key the cached result replays and `execute` is skipped. Default TTL 24h
  (`idempotencyKeyTTL` to override).
- `retry: { maxAttempts: 3, minTimeoutInMs: 500, maxTimeoutInMs: 10000, factor: 2 }` — capped
  exponential backoff. Default is no retry.
- `maxDuration: "30s"` — per-attempt timeout; on the final attempt the run flips to `"timedOut"`.

**On the TRIGGER block** (cross-cutting):

- `concurrencyKey: req.body.tenantId` + `concurrencyLimit: 5` + `onLimit: "throw" | "queue"`
  — per-tenant rate limiting. On denial: HTTP `429` (+ `Retry-After`) or, with `"queue"`,
  `202 Accepted` and a deferred retry.
- `delay: "1h"` / `ttl: "30m"` / `debounce: { key, mode, delay, maxDelay? }` — schedule, expire,
  or collapse rapid same-key triggers.

Cancellation: every run carries `ctx.signal`. `POST /__blok/runs/:id/cancel` aborts it; nodes
that consult `ctx.signal.aborted` (or pass it to `fetch`) stop cooperatively.

---

## 8. Sub-workflows

Invoke another workflow as a step:

```ts
step("receipt", null, { user: order.user, order: order.id }, {
  subworkflow: "send-receipt-email",  // or a $-path expression for polymorphic dispatch
  // wait: true (default) — parent blocks; child's response lands on state["receipt"]
  // wait: false — fire-and-forget; returns { runId, workflowName, scheduledAt }
});
```

The child runs in its own isolated `ctx`; the parent step's `inputs` becomes the child's
`ctx.request.body`. With `wait: true` + `idempotencyKey`, a cache hit skips the child entirely
(including side effects). Recursion is capped (`BLOK_MAX_SUBWORKFLOW_DEPTH`, default 10). For
caller-supplied workflow names, constrain with `allowList: ["a", "b"]`.

> In JSON / object-style workflows the shape is `{ id, subworkflow, inputs, wait? }` (no node).

---

## 9. Testing

Import the harnesses from `@blokjs/core/testing` and use them with Vitest.

```ts
import { NodeTestHarness, WorkflowTestRunner } from "@blokjs/core/testing";
import fetchUser from "../src/nodes/fetch-user";

// Unit-test a node
const harness = new NodeTestHarness(fetchUser);
const result = await harness.execute({ userId: "abc-123" });
harness.assertSuccess(result);
harness.assertOutput(result, { user: { id: "abc-123", name: "…", email: "…" } });

// Integration-test a workflow
const runner = new WorkflowTestRunner({ verbose: true });
runner.registerNode("validate", ValidateNode);
runner.mockNode("external-api", async (input) => ({ result: "mocked" }));
runner.loadWorkflow(myWorkflowDefinition);
const run = await runner.execute({ input: "data" });
expect(run.success).toBe(true);
expect(run.trace).toHaveLength(2); // inspect the per-step execution trace
```

---

## 10. Project layout, CLI, and Studio

```
src/
  nodes/<name>/index.ts   # a node — AUTO-DISCOVERED (no central map edit)
  workflows/**.ts         # TypeScript workflows (organize by domain)
  Nodes.ts                # published-node registration + auto-discovery (don't hand-edit for your nodes)
  Workflows.ts            # workflow registration
workflows/json/**.json    # optional JSON workflows (file-based routing)
.blok/config.json         # scaffolded triggers + runtimes — READ THIS FIRST
```

| Command | Does |
|---|---|
| `blokctl dev` | Start the trigger(s) + spawn configured runtimes. |
| `blokctl create node <name> [--runtime <lang>]` | Scaffold a node. |
| `blokctl create workflow <name>` | Scaffold a workflow. |
| `blokctl trace` | Open **Blok Studio** (also at `/__blok` on the running server) — per-run traces with each step's inputs/outputs/errors/timing. |

---

## 11. Legacy surfaces (supported, not preferred)

These compile to the same IR and keep working — recognize them, but author new TypeScript
workflows with the handle DSL above.

- **Object-style** (`@blokjs/helper`): `workflow({ name, version, trigger, steps: [...] })`
  with `$.state.<id>` / `$.req.body` references and `branch: { when, then, else }`.
- **JSON** (`workflows/json/**.json`): the same shape as a string; reference outputs as
  `"$.state.<id>"`; branch `when` is a raw `"ctx.state.x > 10"` string (never `js/…` or `$.…`).

---

## Do NOT

- Do **not** write `ctx.state` / `ctx.vars` inside a node's `execute` — return your output.
- Do **not** reuse a step `id` (including across `branch`/`switch`/`tryCatch` arms) — it throws at load.
- Do **not** read an arm-local or `ephemeral` handle from outside its scope — it resolves to `undefined`.
- Do **not** pass a `js/…` or `$.…` string to a `branch`/`switch` `when` — use the typed comparators.
- Do **not** use the `queue` trigger (dead) — use `worker`. Do not use `"*"` for the HTTP method — use `"ANY"`.
- Do **not** use class-based `BlokService`, or `any` types (use `z.unknown()`), or skip Zod schemas.
- Do **not** name two nodes the same `name` — duplicate `use:` refs throw at startup.
- Do **not** build a response object inside a node — use `@blokjs/respond` (or just return data).

---

*Generated by `blokctl`. Keep this file in your repo — it's the context an AI agent reads to
build Blok apps correctly.*
