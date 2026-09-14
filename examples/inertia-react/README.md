# Blok + Inertia v3 + React

The in-project deployment mode: a Vite SPA in `client/`, a Blok server serving
it and answering every page, one origin. One prop (`stats`) is computed by a
**Python** node, so the cross-runtime story is visible rather than claimed.

Docs: [SPA (Inertia)](../../docs/d/spa/index.mdx).

## Why this is built by hand

`blokctl create spa` / `blokctl add spa` land with
[#999](https://github.com/well-prado/blok/issues/999), and
`@blokjs/inertia` / `@blokjs/inertia-client` are **not published yet**. So this
example is wired by hand — which is exactly what the scaffold will write.

Inside this repository the example resolves `@blokjs/*`, `@inertiajs/*`,
`react` and `vite` through the **root install** (`bun install` at the repo
root); it is not a workspace package and has no `node_modules` of its own. The
versions in `package.json` are what you would install outside the monorepo,
once those two packages are on npm.

## Layout

```
src/index.ts                  the server entrypoint (what a scaffold generates)
src/nodes.ts                  every prop's node, incl. the Python stub
src/workflows/dashboard.ts    the page: always / defer / merge / once / scroll
src/workflows/orders-create.ts  the form: validate + Precognition + redirect back
src/Workflows.ts              middleware chain, shared data, error pages
client/                       the Vite SPA (stock @inertiajs/react)
runtimes/python3/nodes/       the `dashboard-stats` node
tests/                        runPage / runPrecognition + a real build-and-serve
                              suite — `bun run e2e`
```

## Running it

```bash
# 1. build the workspace packages once, from the repo root
bun run build

# 2. build the client (writes client/dist/.blok-vite.json, which the HTML
#    shell reads to find the bundle)
bun run build

# 3. start the server, from THIS directory
BLOK_FLASH_SECRET=dev-secret BLOK_STATIC_DIR=client/dist bun run src/index.ts
```

Open <http://localhost:4000> — the Dashboard renders. `PORT=4321` moves it.

`blokctl dev` is the scaffold's runner and expects `.blok/config.json` plus
`src/triggers/http/index.ts`; this hand-built example boots `src/index.ts`
directly instead.

### The dev loop

```bash
# terminal 1 — the server
BLOK_FLASH_SECRET=dev-secret BLOK_STATIC_DIR=client/dist bun run src/index.ts

# terminal 2 — Vite
bun run dev
```

Open the **Blok** URL (4000). While `vite` runs it rewrites
`client/dist/.blok-vite.json` to point at the dev server, so the shell loads the
entry and the HMR client from Vite and edits hot-reload on Blok's origin. The
Vite URL (5173) still works too — the plugin proxies everything it does not own
to Blok.

### Tests

```bash
bun run e2e
```

`tests/dashboard.test.ts` and `tests/orders-create.test.ts` are `runPage` /
`runPrecognition` suites (no server). `tests/serve.test.ts` builds the client,
boots this example for real and asserts over HTTP that `/` returns the Inertia
shell and that its `<script type="module" src>` resolves to a file in
`client/dist` — so the example failing to start is a test failure.

The Python prop needs the python3 sidecar (`blokctl runtime add python3`) to
resolve for real. Without it the prop is `defer(..., { rescue: true })`, so the
page renders and the `Loading stats…` fallback simply stays; the unit tests mock
it by node ref, the way any cross-runtime step is mocked.

## What each piece demonstrates

| File | Shows |
| --- | --- |
| `src/workflows/dashboard.ts` | five prop modes on one page, and `shared(currentUser, "auth")` feeding a prop's inputs |
| `src/nodes.ts` | `paginate()` / `cursorPaginate()` envelopes, and `runtimeNode<In, Out>` for Python |
| `src/workflows/orders-create.ts` | `{ precognition: true }`, error bags, `redirectBack()` |
| `src/Workflows.ts` | `inertia.shared` / `inertia.auth` / `inertia.csrf`, `share()`, `configureErrorPages()` |
| `client/src/pages/Dashboard.tsx` | `PageProps<typeof Dashboard>` — props typed straight off the server contract |

## `bun run e2e` is a placeholder, on purpose

It runs this example's own `runPage` / `runPrecognition` suites. The real
end-to-end matrix — live server, real Vite build, real browsers, the real
Inertia client — is [#1003](https://github.com/well-prado/blok/issues/1003);
when it lands, `e2e` runs that against this app.
