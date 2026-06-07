# SPEC — `@blokjs/client`: a fully-typed Blok client SDK (tRPC-style, for workflows)

**Status:** Proposal / design spec. **Audience:** a BLOK framework work session. Self-contained. Pairs with `SPEC-node-structure-unification.md`.

> **Revision history**
> - **v1** led with codegen + a `/__blok/schema` manifest (the Connect/protobuf model). Over-rotated toward generality.
> - **v2** made **type inference** the primary mode (the tRPC model: `import type { BlokApp }`, zero codegen), demoting codegen to a fallback.
> - **v3 (this doc)** removes the hand-written `defineApp` aggregation (it was a tRPC-ism that doesn't fit Blok's file-scan discovery): the **`BlokApp` type is generated from the workflow registry** Blok already builds — you author nothing but workflows. Adds a detailed **control-flow output-typing** section (`forEach`/`branch`/loops/`tryCatch`) and a **packaging/npm** section.
> - **v4** renames the generated index type `App` → **`BlokApp`** (and the file it lives in, `blok-app.d.ts`, exports `BlokApp`) to avoid confusion with Hono's `AppType`. They are unrelated: Hono is only the HTTP-server library the trigger runs on; `BlokApp` + `@blokjs/client` are Blok's own, modeled on tRPC's `AppRouter`, and the client never touches Hono.

## 1. Context — why
The boundary between a frontend and a Blok backend is hand-written and untyped: apps hand-roll `fetch` (guessing verb/path/shape), hand-roll an SSE parser, and key off free-string event names. None of it is type-checked, so a renamed field, a wrong method, or an unemitted event fails silently at runtime. Blok already has the raw material for a typed bridge — workflows declare a **trigger** (method + path) and nodes are **forced to declare Zod input/output schemas** — it just isn't surfaced as a client.

**Goal:** ship `@blokjs/client` so any Blok app calls `blok.users.list(input)` (typed both ways) and `for await (const ev of blok.jobs.watch.stream(input))` (a typed discriminated union) — **the tRPC developer experience, for Blok workflows.** Delete the hand-written transport/parse glue.

**Non-goal:** an Inertia-style page protocol, or replacing Blok's REST routes (those stay for external/webhook callers).

## 2. The model: inference first (tRPC), codegen as a fallback (Connect)

Two industry models for an end-to-end-typed client; Blok ships **both**, in priority order.

### 2.1 Primary — type inference (the tRPC model)
The client imports the server's **types only** (`import type { BlokApp }`, fully erased from the bundle) and infers every input, output, and event. No generated runtime code, no manifest. This is what you asked for.

**Why it works despite Blok's "generic dispatcher" route handler.** tRPC doesn't infer from route handlers (that's Hono `hc`); it infers from a **typed procedure tree** and routes calls **by name through one mount** (`/trpc/<proc>`), so the client never needs per-route info. Blok mirrors this with three pieces (detailed in §5):
1. `workflow()` carries its I/O as **phantom types** (`Workflow<Input, Output, Events>`).
2. A **generated `BlokApp` type** indexes every workflow (from the registry — you don't hand-write it).
3. One internal mount, **`POST /__blok/rpc/:name`** (+ SSE), runs a workflow by name. The client needs only the dotted name (the proxy already has it) + the types ⇒ **no manifest, no codegen.**

### 2.2 Fallback — codegen from a manifest (the Connect model)
When the client can't `import type` the server (JSON-authored workflows; non-TS clients like Swift/Kotlin; cross-repo frontends without a shared tsconfig), `blokctl gen client` reads `GET /__blok/schema` (JSON-Schema per workflow) and emits a self-contained typed client. Same runtime, same RPC mount — only the *source of types* differs.

### 2.3 What's identical in both modes
The transport runtime (`createBlokClient` + the SSE reader), the RPC mount, the TanStack hooks, and the **backend prerequisites**: every workflow must be able to declare an **`output`** and (if streaming) an **`events`** vocabulary. That requirement is independent of the client strategy — a Blok workflow is a *runtime-assembled pipeline of steps*, not a typed function, so its result type can't be derived without a declaration. §4 is the load-bearing work regardless of mode.

## 3. Current-state ground truth

| Need | Today | Gap |
|---|---|---|
| Workflow list + trigger (method/path) | ✅ `WorkflowRegistry.list()` → `_config.trigger` (MCP trigger reads this, `triggers/mcp/src/McpTrigger.ts:274`) | — |
| Workflow **input** schema | ⚠️ optional `input?: ZodType` on `_config` (`WorkflowOpts.ts:93`) | **Stripped by `WorkflowNormalizer`** → absent on the runner `Config`; readable only off `_config`. |
| Workflow **output** type | ❌ **does not exist** | The headline gap. Terminal `ctx.response.data` is the de-facto return — untyped, ambiguous under control flow. |
| Streaming **event vocabulary** | ❌ free-string `event` + `data: unknown` (`@blokjs/sse-emit`, `StreamContext.writeSSE`) | No declared "this workflow emits these events with these shapes." |
| A name-keyed run entrypoint | ⚠️ sub-workflows run by name via `WorkflowRegistry.get()` + the runner; no HTTP surface | Need a thin `/__blok/rpc/:name` mount (unary + SSE). |
| **Node** I/O schemas (codegen fallback) | ⚠️ module nodes carry Zod; runtime nodes' schemas live only in their SDK | gRPC `ListNodes` returns **empty** schema fields today. |

## 4. Backend changes (load-bearing — needed for BOTH modes)

### 4.1 Workflow-level `output` schema (the critical one)
Add optional `output?: ZodType` to `WorkflowOpts` / `WorkflowV2Schema` (sibling of `input`). `workflow()` infers `Output = z.infer<output>` into its phantom type.
```ts
workflow({
  name: "users.list",
  trigger: { http: { method: "GET", path: "/api/users" } },
  input:  z.object({ q: z.string().optional(), limit: z.number().int().min(1).max(100).default(20) }),
  output: z.object({ users: z.array(UserSchema), total: z.number().int() }),   // ← NEW
  steps: [ /* … */ ],
});
```
- **Carry it through.** Thread `input`/`output` onto `InternalWorkflow` + the runner `Config` (today even `input` is stripped at normalization) so both the type layer and `/__blok/schema` can read them.
- **Optional runtime enforcement** (`BLOK_VALIDATE_WORKFLOW_OUTPUT=true`, off by default): validate terminal `ctx.response.data` against `output`, fail loud on drift — the server-side "loud seam," mirroring `BLOK_MAPPER_MODE=strict`. **This is the payoff of declaring** (§6 shows why it matters for control flow).

### 4.2 Workflow-level `events` vocabulary (typed streaming)
Add optional `events?: Record<string, ZodType>` to streaming workflows. Add `@blokjs/sse-emit-typed` (or a typed mode on `sse-emit`) whose `event` is constrained to `keyof events` and whose `data` is validated against `events[event]` — emitting an undeclared event or a wrong shape becomes a load/run error, not a silent omission.
```ts
events: {
  progress: z.object({ pct: z.number().min(0).max(100) }),
  log:      z.object({ line: z.string() }),
  done:     z.object({ result: ResultSchema }),
  error:    z.object({ message: z.string() }),
}
```

### 4.3 The name-keyed RPC mount (makes zero-codegen inference possible)
Add, alongside the existing `/__blok/*` Studio API:
- `POST /__blok/rpc/:name` — body = input; looks the workflow up in `WorkflowRegistry`, runs it through the normal runner, returns the output as JSON. (Reuses the registry path sub-workflows already use.)
- `POST /__blok/rpc/:name` with `Accept: text/event-stream` (or `/__blok/rpc/:name/stream`) — runs a streaming workflow, forwards its SSE frames.

The workflow's own REST route (`GET /api/users`) is unchanged — external callers use it; the typed first-party client uses the RPC mount. *(Alternative: target the REST routes directly — avoids a second surface but needs a tiny `name → {method,path}` runtime manifest, so it's no longer pure inference. The RPC mount is the cleaner tRPC parity.)*

### 4.4 Schema manifest — `GET /__blok/schema` (fallback + Studio only)
Serves every workflow's `{ name, trigger, input, output, events }` as JSON Schema (via `zod-to-json-schema`, already a dep). **Not needed for inference mode** — only for codegen (§2.2) and Studio's catalog. Runtime-node reflection (`ListNodes` schemas, SPEC-node-unification §3.3) feeds typed output for workflows whose terminal step is a `runtime.*` node.

## 5. How it actually works (detailed)

### 5.1 You author only workflows
Each `workflow({ input, output })` is the typed contract — a self-contained unit. The **only** addition vs. today is the `output` schema. `workflow()` is typed so the schemas flow into phantom type parameters:
```ts
// in @blokjs/helper
function workflow<I extends ZodTypeAny, O extends ZodTypeAny, E extends EventMap = {}>(
  opts: { input?: I; output?: O; events?: E; name: string; trigger: …; steps: … },
): Workflow<InferOr<I, unknown>, InferOr<O, unknown>, EventUnion<E>>;

type Workflow<I, O, E> = { readonly __brand: "blok.workflow"; readonly _in: I; readonly _out: O; readonly _ev: E };
type EventUnion<E> = { [K in keyof E]: { type: K; data: z.infer<E[K]> } }[keyof E];   // discriminated union
```
So `typeof usersList` is `Workflow<{q?:string;limit?:number}, {users:User[];total:number}, never>` — the types are *in the value's type*, carried automatically.

### 5.2 The `BlokApp` type is GENERATED from the registry (you write nothing)
TypeScript can't discover types from a folder — they only flow through imports. So *one* type must index all workflows. **You don't hand-write it; `blokctl gen app-types` walks the `WorkflowRegistry` Blok already builds and emits a types-only file** (no runtime code, no re-declaration — it just points at your existing workflow files):
```ts
// blok-app.d.ts — GENERATED. Regenerated on `blokctl dev` / prebuild when workflow files change.
import type usersList   from "./workflows/users/list";
import type usersCreate from "./workflows/users/create";
import type jobsWatch   from "./workflows/jobs/watch";

export type BlokApp = {
  users: { list: typeof usersList; create: typeof usersCreate };   // grouping derived from the dotted name / file path
  jobs:  { watch: typeof jobsWatch };
};
```
This file carries **zero new information** — the workflow files remain the single source of truth; the generator just collects their types. *(If you'd rather not run a generator, you can hand-write the equivalent barrel — that's all the old `defineApp` was — but generated-from-the-registry is the default, because Blok already knows your workflows.)*

### 5.3 The client maps the `BlokApp` type to a callable surface
`@blokjs/client` ships a generic whose **return type** is computed from `BlokApp` via mapped/conditional types — written once, this is the genuinely-hard part (tRPC-level):
```ts
// in @blokjs/client (.d.ts)
type Client<T> = {
  [K in keyof T]: T[K] extends Workflow<infer I, infer O, infer E>
    ? IsNever<E> extends true
        ? UnaryCall<I, O>        // not streaming
        : StreamCall<I, E>       // streaming
    : Client<T[K]>;              // recurse into groups (users, jobs, …)
};
type UnaryCall<I, O>  = ((input: I) => Promise<O>) & { useQuery(i: I): UseQueryResult<O>; useMutation(): …; queryKey(i?: I): QueryKey };
type StreamCall<I, E> = { stream(input: I): AsyncIterable<E>; useStream(input: I): { events: E[]; status: … } };

export function createBlokClient<BlokApp>(cfg: ClientConfig): Client<BlokApp>;
```
Result: `blok.users.list` is `(input) => Promise<{users;total}>`, `blok.jobs.watch.stream` is `(input) => AsyncIterable<JobEvent>`. Full autocomplete, both ways, with **no generated runtime code**.

### 5.4 At runtime, a Proxy turns the access path into a named RPC call
`createBlokClient` has no per-endpoint code. A single `Proxy` records the property path and, on call, dispatches by name:
```ts
function createBlokClient(cfg) {
  const build = (path) => new Proxy(function(){}, {
    get: (_t, key) => (key === "stream" || key === "useQuery" || key === "useMutation" || key === "useStream" || key === "queryKey")
        ? makeMethod(key, path)             // leaf method
        : build([...path, key]),            // descend: users → list
    apply: (_t, _this, [input]) => unaryCall(path.join("."), input, cfg),   // blok.users.list(input)
  });
  return build([]);
}
// unaryCall("users.list", input):  POST {baseUrl}/__blok/rpc/users.list, JSON body = input → res.json() as O
// stream("jobs.watch", input):     POST …/__blok/rpc/jobs.watch  Accept: text/event-stream → SSE reader → AsyncIterable<E>
```
**Unary vs. streaming is disambiguated by call style, not by runtime metadata** — `blok.users.list(input)` (direct call) is unary; `blok.jobs.watch.stream(input)` is streaming. The type layer only exposes the legal one per workflow (a streaming workflow has no direct-call signature; a unary one has no `.stream`). This is why **no runtime manifest is needed** even for the unary/stream split — the call site encodes the transport, exactly like tRPC's `.query()`/`.mutation()`/`.subscription()`.

### 5.5 The wire
- Unary: `POST /__blok/rpc/users.list` `{ "q": "ada" }` → `200 { "users": [...], "total": 42 }`.
- Streaming: `POST /__blok/rpc/jobs.watch` `Accept: text/event-stream` → the runner's SSE frames (`event: progress\ndata: {"pct":40}\n\n` …). The client's **owned, spec-correct SSE reader** (handles `event:`/`data:`/`id:`/multi-line/`Last-Event-Id` reconnect) yields `{ type: "progress", data: { pct: 40 } }`. **Any unparseable or unknown frame is metered + warned, never `catch{continue}`** — the client half of `BLOK_MAPPER_MODE=strict`. (This reader must be framework-owned because native `EventSource` is GET-only / can't send a body or auth headers — the reason streaming clients get hand-rolled.)

## 6. Output typing with control flow (`forEach` / `branch` / loops / `tryCatch`)

**The crux: the typed output never comes from analyzing your steps. It comes from the declared `output` schema.** Control flow is the *private body*; `output` is the *public return type*. The client and the type system only ever see `output`. So however gnarly the internals, the contract is one declared schema — and where the body can produce multiple shapes, you declare a Zod **union** or **array** and the client gets a typed value it must narrow.

### `forEach` → declare `z.array(...)`
```ts
workflow({
  name: "users.enrich",
  input:  z.object({ ids: z.array(z.string()) }),
  output: z.object({ users: z.array(EnrichedUser) }),       // the loop result, declared as an array
  steps: [
    forEach({ id: "loop", items: "$.req.body.ids", as: "users",
      body: [ /* per-item steps; each iteration yields one EnrichedUser */ ] }),
    { id: "out", use: "@blokjs/respond", inputs: { body: { users: "$.state.users" } }, ephemeral: true },
  ],
});
```
```ts
const { users } = await blok.users.enrich({ ids });   // users: EnrichedUser[] — the N iterations are invisible
```

### `branch` / if-else → declare a discriminated union
When arms return different shapes, the union *is* the contract — and TS forces the client to narrow:
```ts
workflow({
  name: "payments.process",
  input:  z.object({ amount: z.number(), method: z.string() }),
  output: z.discriminatedUnion("status", [
    z.object({ status: z.literal("paid"),     receiptId: z.string() }),
    z.object({ status: z.literal("declined"), reason: z.string() }),
  ]),
  steps: [
    branch({ id: "route", when: "$.state.charge.ok",
      then: [ /* … leaves { status: "paid",     receiptId } */ ],
      else: [ /* … leaves { status: "declined", reason }    */ ] }),
    { id: "out", use: "@blokjs/respond", inputs: { body: "$.prev" }, ephemeral: true },
  ],
});
```
```ts
const res = await blok.payments.process({ amount, method });
if (res.status === "paid") showReceipt(res.receiptId);   // narrowed to the "paid" arm
else                       showError(res.reason);          // narrowed to the "declined" arm
// res.receiptId before the check → compile error
```
The if-else's two outcomes become two typed cases the client *must* handle — a feature, not a workaround.

### loops / `while` → array or accumulator
Same as `forEach`: declare `z.array(ItemSchema)` for a collected list, or the accumulator's object shape for a reduce-style loop.

### `tryCatch` → union of success and failure shapes
```ts
output: z.union([
  z.object({ ok: z.literal(true),  data: PayloadSchema }),
  z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) }),
]),
// branch/tryCatch arms leave either shape; client narrows on `ok`
```

### nested control flow → the union/array just nests
A `branch` whose `then` contains a `forEach` and whose `else` is a single object → `z.discriminatedUnion("kind", [ z.object({ kind: literal("many"), items: z.array(...) }), z.object({ kind: literal("one"), item: ... }) ])`. You declare the *outcomes*, never trace the *path*.

### streaming + loops → declare it in `events`, not `output`
A workflow that `forEach`-emits a `progress` event per item declares the **event vocabulary** (§4.2); the loop is invisible, the client just receives a typed stream of `progress | done | …`.

### Why declare-not-infer is the correct design (not a limitation)
1. **Inference through control flow is ambiguous + fragile.** Tracing the terminal type through `branch → forEach → tryCatch → @blokjs/respond` yields an implicit union the author never reviewed — Blok genuinely has *multiple* terminal steps there. Declaration makes the contract explicit and reviewed.
2. **Declaration buys a runtime guarantee inference can't.** With `BLOK_VALIDATE_WORKFLOW_OUTPUT=true`, the runner validates the *actual* result against `output` — so if a branch arm drifts and produces a shape outside the declared union, it **fails loud** instead of silently shipping a wrong type. That's only possible because you declared.

### The one shortcut for the trivial case
A **linear workflow ending in a single node** can auto-type its output from that node's `output` Zod schema (or, for a `runtime.*` node, its `ListNodes` reflection). The moment you add control flow there's no single terminal node, so you declare. Net rule: **trivial workflows auto-type; anything with `forEach`/`branch`/`tryCatch` declares `output` (usually a union or array).**

## 7. Packaging & distribution (the npm question)

**One new published package + additive changes to existing ones + new CLI subcommands. The per-project `BlokApp` type is generated locally, not published.**

| Artifact | Published to npm? | Notes |
|---|---|---|
| **`@blokjs/client`** | ✅ **new package**, lockstep with the 16 existing `@blokjs/*` | The runtime (`createBlokClient`, the SSE reader, TanStack hooks) + the type machinery (`.d.ts`). The frontend installs it: `npm i @blokjs/client`. |
| `output`/`events` on `workflow()` | ✅ inside existing `@blokjs/helper` | Additive DSL fields. |
| `@blokjs/sse-emit-typed` (or typed `sse-emit`) | ✅ inside existing `@blokjs/helpers` | New helper node. |
| `/__blok/rpc/:name` mount + `/__blok/schema` + carry `output` through normalizer | ✅ inside existing `@blokjs/runner` + the http trigger | Additive routes/fields. |
| `blokctl gen app-types` / `blokctl gen client` | ✅ inside existing `blokctl` CLI | New subcommands, not a new package. |
| **The generated `BlokApp` type** (`blok-app.d.ts`) | ❌ **not published** | App-specific; committed in *your* repo (or regenerated at build). Exactly like tRPC's `AppRouter` type. |

**Consumption depends on repo layout:**
- **Monorepo (server + frontend together):** frontend does `npm i @blokjs/client` and `import type { BlokApp } from "../server/blok-app"`. Pure inference, nothing extra published. *(The common case.)*
- **Separate repos:** `import type` can't cross the repo boundary, so either (a) publish the generated types as a small private package (e.g. `@yourco/blok-app-types`, internal registry) that the frontend installs, **or** (b) use the **codegen fallback** (§2.2) — `blokctl gen client --from https://api.yourco.com/__blok/schema` produces a self-contained client with no shared types. This is precisely why Mode B exists.
- **Non-TS frontend (Swift/Kotlin/etc.):** Mode B only — generate from `/__blok/schema`.

So: **`@blokjs/client` on npm = yes.** Your typed surface = generated locally (monorepo) or generated/published-as-types (split repos). Strict-lockstep release applies: adding `@blokjs/client` bumps it in step with all `@blokjs/*` (update `scripts/release.ts` `PUBLISHABLE`, dep ranges, CLI constants, lockfile, tag), per the release runbook.

## 8. Phasing
1. **P1 — `output` + carry-through + `POST /__blok/rpc/:name` (unary) + `@blokjs/client` (unary) + `blokctl gen app-types`.** Typed CRUD via inference. *Smallest surface, highest value.*
2. **P2 — TanStack hooks** (`useQuery`/`useMutation`).
3. **P3 — typed streaming:** `events` + typed `sse-emit` + SSE RPC mount + the owned SSE reader + `.stream`/`useStream`.
4. **P4 — codegen fallback:** `GET /__blok/schema` + `blokctl gen client` + runtime-node reflection (`ListNodes`) for non-TS / JSON / cross-repo.

## 9. Risks / open questions
- **Output-declaration burden.** No declaration → type is `unknown` (nothing breaks → incremental adoption). Mitigations: `--infer-output` to pre-fill linear cases; a lint flagging http workflows lacking `output`.
- **Control-flow contracts are author-declared unions** — the author must keep the declared union in sync with the arms. `BLOK_VALIDATE_WORKFLOW_OUTPUT=true` catches drift at runtime; a future check could compare declared arms vs. reachable terminal steps.
- **Second call surface** (`/__blok/rpc`) parallel to REST. Additive + internal; REST-reuse is the documented single-surface alternative.
- **Generated `BlokApp` type vs. file-scan discovery** — regeneration must be wired into `blokctl dev` (watch) + prebuild so it never goes stale; a stale `BlokApp` is a type-vs-runtime mismatch.
- **TS type-machinery complexity** lives in `@blokjs/client`'s `.d.ts` — written once, but the genuinely hard part; budget for it.
- **Versioning / drift** (codegen mode only): `/__blok/schema` carries a hash so a stale generated client is detectable. Inference mode can't drift (types come straight from source).

## 10. The cultural companion (cheap, do regardless)
**One end-to-end test per live feature asserting incremental truth** (for a stream: "length strictly increases across N samples; the expected event kinds all appear"). Untyped bridges fail in ways unit tests + curl + schema checks miss because nothing asserts *what the eyeball sees*. The SDK shrinks the bug surface structurally; this test catches what still leaks. Hours of work, independent of the SDK — ship it first.
