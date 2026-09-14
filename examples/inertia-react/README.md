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
src/python-sidecar.ts         starts runtime.python3 with the server
src/nodes.ts                  every prop's node, incl. the Python stub
src/workflows/dashboard.ts    the page: always / defer / merge / once / scroll
src/workflows/orders-create.ts  the form: validate + Precognition + redirect back
src/workflows/posts-create.ts   create a post; the list on screen updates
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

# 3. start the server AND the runtime.python3 sidecar, from THIS directory
BLOK_FLASH_SECRET=dev-secret BLOK_STATIC_DIR=client/dist bun run src/index.ts
```

Open <http://localhost:4000> — the Dashboard renders. `PORT=4321` moves it.

That third line is the whole stack: `src/index.ts` also starts the Python
sidecar (`src/python-sidecar.ts`), which is what `blokctl dev` does from
`.blok/config.json` in a scaffolded project. On the first run it creates
`runtimes/python3/python3_runtime` (a venv with the SDK's `requirements.txt`,
the same one `blokctl runtime add python3` makes) and boots
`sdks/python3/bin/serve.py` in gRPC mode on `RUNTIME_PYTHON3_GRPC_PORT`
(default `10007`) with `BLOK_NODES_DIR=runtimes/python3/nodes`. The
Dashboard's **Revenue (Python)** tile then shows a real number.

**Python 3.11+.** The SDK's typed `@node` authoring imports
`typing.NotRequired`, and `bin/serve.py` swallows the ImportError from an older
interpreter — a 3.9/3.10 sidecar boots and serves ZERO user nodes, silently
([#1064](https://github.com/well-prado/blok/issues/1064)). macOS ships 3.9, so
`BLOK_PYTHON=/opt/homebrew/bin/python3.12` (or any 3.11+) is the fix; the
launcher refuses to build a venv around anything older rather than making you
debug an empty registry.

To create the venv ahead of time, or after changing the interpreter:

```bash
bun run setup:python          # python3 -m venv … && pip install -r …
```

Knobs: `BLOK_PYTHON=/path/to/python3` picks the interpreter,
`RUNTIME_PYTHON3_GRPC_PORT` moves the port (the runner and the sidecar read the
same variable), `BLOK_SKIP_PYTHON_SIDECAR=1` skips it entirely.

**Without python3 nothing breaks.** The prop is
`defer(dashboardStats, { rescue: true })`, so the server logs why it could not
start the sidecar, the page renders, and the tile shows its rescue text instead
of a number.

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

`tests/dashboard.test.ts`, `tests/orders-create.test.ts` and
`tests/posts-create.test.ts` are `runPage` / `runPrecognition` suites (no
server). `tests/serve.test.ts` builds the client, boots this example for real
and asserts over HTTP that `/` returns the Inertia shell, that its
`<script type="module" src>` resolves to a file in `client/dist`, and that
`POST /posts` followed by the Inertia visit its 303 points at comes back with
the new post at the top of the `posts` prop — so the example failing to start,
or the create flow failing to update the list, is a test failure.

`tests/python-stats.test.ts` starts the real sidecar (on a free port) and
resolves the `stats` prop through it with **no mock**. It skips itself, with the
reason on stdout, when this machine has no python3 with `grpcio` — run
`bun run setup:python` once to exercise it. The other suites mock
`dashboard-stats` by node ref, the way any cross-runtime step is mocked.

## What each piece demonstrates

| File | Shows |
| --- | --- |
| `src/workflows/dashboard.ts` | five prop modes on one page, and `shared(currentUser, "auth")` feeding a prop's inputs |
| `src/nodes.ts` | `paginate()` / `cursorPaginate()` envelopes, and `runtimeNode<In, Out>` for Python |
| `src/workflows/orders-create.ts` | `{ precognition: true }`, error bags, `redirectBack()` |
| `src/workflows/posts-create.ts` | a write whose redirect back re-renders the list on screen — no client-side list surgery |
| `src/Workflows.ts` | `inertia.shared` / `inertia.auth` / `inertia.csrf`, `share()`, `configureErrorPages()` |
| `client/src/pages/Dashboard.tsx` | `PageProps<typeof Dashboard>` — props typed straight off the server contract |

## `bun run e2e` is not the conformance matrix

It runs this example's own suites: `runPage` / `runPrecognition` in process, one
real build-and-serve suite, and one real Python sidecar. The full end-to-end
matrix — real browsers, the real Inertia client, both deployment modes, three
frameworks — is [#1003](https://github.com/well-prado/blok/issues/1003); when it
lands, `e2e` runs that against this app too.
