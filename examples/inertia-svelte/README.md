# Blok + Inertia v3 + Svelte 5

The same server as [`../inertia-react`](../inertia-react), rendered by a Svelte
5 client (runes, `mount()`), against the stock `@inertiajs/svelte` adapter.

Docs: [SPA (Inertia)](../../docs/d/spa/index.mdx).

## Why this is built by hand

`blokctl create spa` lands with
[#999](https://github.com/well-prado/blok/issues/999), and `@blokjs/inertia` /
`@blokjs/inertia-client` are not published yet. Inside this repository the
example resolves `@blokjs/*`, `@inertiajs/*` and `svelte` through the **root
install**; it is not a workspace package and has no `node_modules` of its own.
The versions in `package.json` are what you would install outside the monorepo.

## Layout

```
src/nodes.ts                  the prop nodes
src/workflows/dashboard.ts    always / defer / scroll on one page
src/Workflows.ts              the inertia.shared middleware + shared data
client/                       the Vite SPA (stock @inertiajs/svelte)
tests/                        the runPage suite — `bun run e2e`
```

## Running it

```bash
bun run build      # from the repo root, once
bun run e2e        # the runPage suite — no server, no browser

BLOK_FLASH_SECRET=dev-secret BLOK_STATIC_DIR=client/dist blokctl dev   # terminal 1
bun run dev                                                            # terminal 2
```

`@sveltejs/vite-plugin-svelte` is **not** installed in this monorepo (the
lockfile rule: no new hoists for an example), so `bun run build`, `bun run dev`
and `bun run typecheck` (the Vite config imports the plugin) need an install of
this example's own `devDependencies` first. `bun run e2e` — the part CI runs —
needs neither.

## `bun run e2e` is a placeholder, on purpose

It runs this example's `runPage` suite. The real end-to-end matrix — live
server, real Vite build, real browsers, the real Inertia client — is
[#1003](https://github.com/well-prado/blok/issues/1003); when it lands, `e2e`
runs that against this app.
