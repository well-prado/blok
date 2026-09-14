# Blok + Inertia v3 + Vue 3

The same server as [`../inertia-react`](../inertia-react), rendered by a Vue 3
client — which is the point: the server half does not know which framework is on
the other end of the protocol.

Docs: [SPA (Inertia)](../../docs/d/spa/index.mdx).

## Why this is built by hand

`blokctl create spa` lands with
[#999](https://github.com/well-prado/blok/issues/999), and `@blokjs/inertia` /
`@blokjs/inertia-client` are not published yet. Inside this repository the
example resolves `@blokjs/*`, `@inertiajs/*` and `vue` through the **root
install**; it is not a workspace package and has no `node_modules` of its own.
The versions in `package.json` are what you would install outside the monorepo.

## Layout

```
src/nodes.ts                  the prop nodes
src/workflows/dashboard.ts    always / defer / scroll on one page
src/Workflows.ts              the inertia.shared middleware + shared data
client/                       the Vite SPA (stock @inertiajs/vue3)
tests/                        the runPage suite — `bun run e2e`
```

## Running it

```bash
bun run build      # from the repo root, once
bun run e2e        # the runPage suite — no server, no browser

bun run build      # the Vite client — writes client/dist/.blok-vite.json

# the server, from THIS directory
BLOK_FLASH_SECRET=dev-secret BLOK_STATIC_DIR=client/dist bun run src/index.ts
bun run dev                                                    # Vite, 2nd terminal
```

Open the **Blok** URL (<http://localhost:4000>). `blokctl dev` is the scaffold's
runner and expects `.blok/config.json` plus `src/triggers/http/index.ts`; this
hand-built example boots `src/index.ts` directly instead.

`@vitejs/plugin-vue` is **not** installed in this monorepo (the lockfile rule:
no new hoists for an example), so `bun run build`, `bun run dev` and
`bun run typecheck` (the Vite config imports the plugin) need an install of this
example's own `devDependencies` first. `bun run e2e` — the part CI runs — needs
neither. Until the client is built there is no `.blok-vite.json`, so the server
serves the shell, logs one warning naming the fix, and the page stays blank —
see [assets and versioning](../../docs/d/spa/assets-and-versioning.mdx).

## `bun run e2e` is a placeholder, on purpose

It runs this example's `runPage` suite. The real end-to-end matrix — live
server, real Vite build, real browsers, the real Inertia client — is
[#1003](https://github.com/well-prado/blok/issues/1003); when it lands, `e2e`
runs that against this app.
