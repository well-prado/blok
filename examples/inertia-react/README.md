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
src/nodes.ts                  every prop's node, incl. the Python stub
src/workflows/dashboard.ts    the page: always / defer / merge / once / scroll
src/workflows/orders-create.ts  the form: validate + Precognition + redirect back
src/Workflows.ts              middleware chain, shared data, error pages
client/                       the Vite SPA (stock @inertiajs/react)
runtimes/python3/nodes/       the `dashboard-stats` node
tests/                        runPage / runPrecognition suites — `bun run e2e`
```

## Running it

```bash
# 1. build the packages once, from the repo root
bun run build

# 2. the tests — no server, no browser, no Docker
bun run e2e

# 3. the client build
bun run build

# 4. the two-terminal dev loop
BLOK_FLASH_SECRET=dev-secret BLOK_STATIC_DIR=client/dist blokctl dev   # terminal 1
bun run dev                                                            # terminal 2 → open the Vite URL
```

The Python prop needs the python3 sidecar (`blokctl runtime add python3`) to
resolve for real; the tests mock it by node ref, the way any cross-runtime step
is mocked.

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
