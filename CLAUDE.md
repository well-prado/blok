# CLAUDE.md - Blok quick reference

Read `AGENTS.md` for the full repo guide. Keep this file and
`docs/d/fundamentals/context-and-state.mdx` in sync when authoring rules change.

## Commands

```bash
bun install
bun run build
bun run test
bun run lint
bun run ci:fast
bun run ci:packaging
bun run http:dev
bun run cli:test
bun run runner:test
blokctl dev
```

## Authoring

New TypeScript workflows use the typed-handle DSL from `@blokjs/core`.
Do not author workflow data flow with `js/` strings or raw `ctx` condition
strings. (The `$` proxy that used to be a third way to do this is gone —
see the migration guide's "$ removal" entry.)

```ts
import { branch, gt, http, step, tpl, workflow } from "@blokjs/core";

export default workflow("Process Order", { version: "1.0.0", trigger: http.post("/orders") }, (req) => {
  const order = step("validate", orderValidator, { body: req.body });
  step("summary", summarize, { line: tpl`order ${order.id}` });
  branch("big", gt(order.total, 100), {
    then: () => {
      step("vip", flagVip, { id: order.id });
    },
  });
});
```

- The callback argument is the trigger entry handle: `req`, `job`, `event`,
  `msg`, `tick`, `rpc`, `conn`, `stream`, or `call`.
- `step()` returns a typed output handle. Read `h` or `h.field` downstream.
- Use `tpl` for strings containing handles.
- Use branch operators `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `not`, or a
  boolean handle.
- Use `js` tagged templates only for non-structural escape hatches.

## Nodes

Kotlin uses the coroutine-first `sdks/kotlin` sidecar and `runtime.kotlin` on
default gRPC port `10011`; it targets JVM 17+ and does not claim Android,
Kotlin/JS, or Kotlin/Native.

Use `defineNode()` from `@blokjs/core`. Keep `input` and `output` Zod schemas.
Inside `execute(ctx, input)`, upstream workflow values arrive through `input`.
The node-side `ctx` ABI is kept for runtime concerns: `ctx.request`,
`ctx.logger`, `ctx.env`, `ctx.signal`, `ctx.publish`, and trigger-specific
`ctx.connection` / `ctx.stream`.

Never write `ctx.state` or `ctx.vars` inside a node. Return output and let the
runner persist it.

JavaScript/TypeScript execution targets are selected independently from the
orchestrator host and package manager: project values are `node`, `bun`, and
`deno`, with step kinds `runtime.nodejs`, `runtime.bun`, and `runtime.deno`.
Legacy `nodejs`/`typescript`/`ts` aliases normalize to Node.js with a
diagnostic. See `docs/architecture/adr-0016-javascript-runtimes.md`.

Cross-language sidecars use the canonical `runtime.<lang>` gRPC contract.
Swift is a Linux-capable Swift 6.1+ sidecar at `runtime.swift` (default gRPC
port `10008`); Apple source compatibility is not a production-platform claim.
Dart is a Dart 3.11+ sidecar at `runtime.dart` (default gRPC port `10009`).
The Elixir SDK is a first-class `runtime.elixir` gRPC sidecar on port 10010;
see `docs/architecture/adr-0017-elixir-beam-runtime.md`.

Nodes and workflows may declare `capabilityManifest` v1 metadata. Declare only
the effects and authority the implementation actually uses; secret entries are
opaque reference names, never values. Missing metadata preserves ordinary
execution compatibility but is not agent-safe. Only a valid
`agent-compatible` manifest may reach later agent policy evaluation;
`trusted-legacy`, `denied-to-agents`, missing, and invalid metadata fail closed.
See `docs/d/fundamentals/capability-manifests.mdx` and ADR 0003.

A step marked `{ precognition: true }` is the workflow's validation boundary
for Inertia Precognition: when the request carries `Precognition: true` the
runner STOPS after that step and answers `204` (+ `Precognition-Success: true`)
or `422 { errors }` from its `{ ok, errors }` output, filtered by
`Precognition-Validate-Only`. Nothing after it runs. Requests without the header
run the workflow unchanged, so one workflow serves both live validation and the
real submit. Use `@blokjs/validate` for the step itself — it returns
`{ ok, data, errors }` with dot-path error keys instead of throwing.

Agent-facing steps may declare `agentStep`, `approval`, `assertionGate`,
`evidenceGate`, and `outputTrust` metadata. The runner requires explicit agent
completion, routes approval `ask` through the durable H1-01 interaction port,
and validates assertion/evidence gates before publishing state. Model output
cannot establish trusted provenance; `outputTrust: "trusted"` requires a
deterministic non-agent implementation and valid capability manifest.

## State

- Every successful step persists to `ctx.state[id]`.
- A thrown step writes nothing.
- The handle returned by `step()` is the authoring read path.
- Fourth-arg knobs: `{ as: "name" }`, `{ spread: true }`,
  `{ ephemeral: true }`, `{ precognition: true }`, plus reliability fields such
  as `idempotencyKey`, `retry`, and `maxDuration`.
- `ephemeral: true` means no state slot; do not read the returned handle.

## SPA / Inertia

Blok speaks Inertia **v3** against the stock `@inertiajs/react | vue3 | svelte`
client. A page is a workflow, a prop is a step. Declare the contract ONCE with
`definePage()`, outside the workflow callback, so the frontend can
`import type` it.

```ts
import { always, defer, definePage, shared } from "@blokjs/inertia";

export const Dashboard = definePage("Dashboard", {
  auth: always(currentUser),
  orders: listOrders,
  stats: defer(heavyStats, { group: "dashboard" }),
});

export default workflow("dashboard", { version: "1.0.0", trigger: http.get("/") }, (req) => {
  Dashboard.render(req, "page", "/", { orders: { userId: shared(currentUser, "auth").id } });
});
```

- `render(req, id, url, inputs, opts?)` takes node INPUTS per prop and emits one
  `page` control step; props resolve in parallel as `<id>.<key>`, so one prop
  can never read another's output.
- Modes: `always`, `optional`, `defer`, `merge`, `once`, `scroll`.
- Middleware is the existing system, registered by name: `inertia.shared`,
  `inertia.auth`, `inertia.csrf`. **`auth` and `flash` are reserved step ids.**
- No session store: flash rides a signed cookie; `BLOK_FLASH_SECRET` required.
- Test with `runPage()` / `runPrecognition()`; never hand-roll the page object.
- Deployment modes: in-project (`client/dist` served via `BLOK_STATIC_DIR`) or
  standalone (separate origin + `BLOK_CORS_ORIGIN`).
- Commands: `blokctl gen app-types`, `blokctl add spa` (`create spa` for a new
  project), `blokctl inertia start-ssr`, `blokctl inertia doctor`.
- `add spa --kit auth` (or `create project --spa <fw> --kit auth`) adds the auth
  starter kit: `@blokjs/session` + `@blokjs/auth`, the ten routes under
  `src/workflows/auth/`, and the sign-in/up/reset pages. `--kit` without a
  framework is refused.
- Agent surface: `docs/llms.txt` / `docs/llms-full.txt`, and the read-only MCP
  tools `inertia.pages.list` / `inertia.page.get` / `inertia.routes.list`
  (dev-only unless `BLOK_INERTIA_MCP=1`).

See `docs/d/spa/` and `examples/inertia-{react,vue,svelte,standalone}`.

## Testing

`runNode` / `runWorkflow` from `@blokjs/core/testing` — no server, no Docker, no
vitest config. See `docs/d/fundamentals/testing.mdx`.

```ts
const out = await runNode(orderValidator, { body: { id: "o-1" } });
const run = await runWorkflow(orderFlow, { id: "o-1", total: 120 }, {
  mock: { "charge-card": async () => ({ receipt: "rc_1" }) },
});
run.ok; run.state("validate"); run.step("charge")?.inputs; run.step("flag")?.executed;
```

`runWorkflow` takes the `workflow()` export directly. Mocks are keyed by node
ref and validated against that node's Zod output schema.

## Footguns

1. Arm-scoped handles do not escape their branch/switch/tryCatch arm.
2. Ephemeral handles are unreadable.
3. Step ids are one flat namespace, including mutually exclusive arms.
4. `forEach` `as` and `asIndex` keys share the same state namespace as step ids.

## Legacy

Object-style `workflow({ steps: [...] })` and JSON workflows are supported for
migration and compatibility. New TS code should use callback handles. When
reading old workflows, translate request reads to the entry handle, state reads
to the producing step handle, templates to `tpl`, and branch comparisons to
typed operators. `@blokjs/expr` is the exception: its `expression` input is
plain JavaScript for that node, without a mapper prefix.

JSON workflows carry the same references structurally in step `inputs`:
`{"$ref": {"step": "fetch", "path": ["data"]}}`, with `@trigger` for the
trigger payload and `@error` for a caught error, and
`{"$tpl": ["text", {"$ref": …}]}` for a string that embeds one. Hand-written
`"js/ctx...."` inputs still load but warn once per workflow at boot
(`BLOK_SUPPRESS_LEGACY_EXPR_WARNING=1` silences); `blokctl migrate refs`
rewrites them. Control positions keep path strings: `branch.when` /
`loop.while` (raw `ctx.*`, no prefix), `switch.on`, `forEach.in`,
`subworkflow`. A structural `{"$ref"}` / `{"$tpl"}` written in a CONTROL
position (`switch.on`, `forEach.in`, a `switch` case `when`) now fails at load
naming the step and the path, instead of reaching the node as a raw object
(#707). The three RESOLVED-KEY positions — step `idempotencyKey`, trigger
`concurrencyKey`, trigger `debounce.key` — take a `js/` expression, a
DELIBERATE literal, OR a structural `{$ref}` / `{$tpl}` that lowers to the
`js/` wire form at load, same as `wait` below (#728); an expression-shaped
value that is neither (`$.…`, bare `ctx.…`, `${…}`, `{{…}}`) still throws
instead of becoming a constant key (#706). `wait.for` / `wait.until` take a
literal duration/timestamp (parsed at LOAD time) OR a structural `{$ref}` /
`js/` expression resolved against the live ctx when the wait step runs, so a
computed delay is expressible (#704); an expression-shaped value that is
neither is refused at load time.

## Do NOT

- Do not create class-based `BlokService` nodes.
- Do not skip Zod schemas.
- Do not use `any`; use `unknown` and narrow.
- Do not use a `queue` trigger; use `worker`.
- Do not use `"*"` for HTTP wildcard; use `"ANY"` or `http.any()`.
- Do not edit generated `.blok/runtimes/` files.
- Do not use ESLint or Prettier; this repo uses Biome. Dart code is formatted and analyzed with the pinned Dart SDK toolchain.
- Do not build with bare `bunx nx run-many -t build`; use `bun run build`, which
  appends the Node-ESM specifier fixup (#687).
- If a build ever looks stale (a test passing against code you changed, a
  scaffold failing to typecheck), run `bun run build:check`; the recovery is
  `bunx nx reset && bun run build`. The nx daemon is off (`nx.json`) precisely
  so a source edit can never be hashed at its old content (#1067).
