# @blokjs/inertia-client

Framework-agnostic Inertia.js glue for Blok SPAs: typed page props, typed
routes, and a Vite plugin.

It contains **no** React, Vue or Svelte code. Rendering stays with the stock
`@inertiajs/react | vue3 | svelte` adapters; this package supplies the three
things they cannot know about — what your pages' props are, what your routes
are, and how the built assets line up with the Blok server.

## Install

Install it next to the stock adapter for your framework and the official Vite
plugin:

| Framework | Install |
|---|---|
| React | `npm i @blokjs/inertia-client @inertiajs/react @inertiajs/vite` |
| Vue 3 | `npm i @blokjs/inertia-client @inertiajs/vue3 @inertiajs/vite` |
| Svelte | `npm i @blokjs/inertia-client @inertiajs/svelte @inertiajs/vite` |

`@inertiajs/core` is a peer dependency (every adapter already depends on it);
`vite` and `@inertiajs/vite` are optional peers needed only by the
`@blokjs/inertia-client/vite` subpath.

> **pnpm:** module augmentation of `@inertiajs/core` only resolves if the
> package is reachable at the top of `node_modules`. Add
> `public-hoist-pattern[]=@inertiajs/core` to `.npmrc`, or
> `pnpm add @inertiajs/core` as a direct dependency. Without it
> `PageProps<…>` silently loses your shared props.

## Types

Two empty interfaces are the augmentation targets. `blokctl` generates them
(`blok-pages.d.ts`), or you write them by hand:

```ts
import "@blokjs/inertia-client";
import "@inertiajs/core";

declare module "@blokjs/inertia-client" {
  interface Pages {
    "Orders/Index": { orders: { id: string; total: number }[] };
  }
  interface Routes {
    "orders.index": { method: "get"; component: "Orders/Index" };
    "orders.show": { params: { id: string }; method: "get"; component: "Orders/Show" };
  }
}

// Inertia's own config, so the stock hooks are typed too — no Blok wrapper.
declare module "@inertiajs/core" {
  interface InertiaConfig {
    sharedPageProps: { auth: { email: string } };
    flashDataType: { toast?: { type: "success" | "error"; message: string } };
    errorValueType: string;
  }
}
```

With that in place:

```tsx
import { type PageProps, route } from "@blokjs/inertia-client";
import { Link, usePage } from "@inertiajs/react";

export default function Index({ orders }: PageProps<"Orders/Index">) {
  const { auth } = usePage().props;          // typed by InertiaConfig
  return orders.map((order) => <Link key={order.id} href={route("orders.show", { id: order.id })} />);
}
```

`PageProps<K>` is `Pages[K] & InertiaConfig["sharedPageProps"] & { errors }`.
`PagePropsOf<typeof workflow>` is the same thing reached through a value — the
monorepo path, where a workflow's `definePage` export carries its prop type on
a `__props` field.

In Vue and Svelte the same type drives the stock macros:

```ts
const props = defineProps<PageProps<"Orders/Index">>();   // Vue
```

## Routes

The types describe the call signature; the URL patterns arrive at runtime.
`blokctl` generates the call, or you write it once at boot:

```ts
import { registerRoutes } from "@blokjs/inertia-client";

registerRoutes({
  "orders.index": { url: "/orders", method: "get", component: "Orders/Index" },
  "orders.show": { url: "/orders/:id", method: "get", component: "Orders/Show" },
});
```

`route()` then returns a Wayfinder-shaped object — an Inertia `UrlMethodPair`,
so it goes straight into `href`, `action` and `router.visit()` and the client
infers the method from it:

```ts
route("orders.show", { id: "1" });                          // { url: "/orders/1", method: "get", component: "Orders/Show" }
route("orders.index").url;                                  // "/orders"
route("orders.show", { id }).withComponent("Orders/Show");  // instant visit
`${route("orders.show", { id: "1" })}`;                     // "/orders/1"
```

Params the pattern does not consume become query-string entries. A pattern
placeholder with no value throws, naming the parameter — `/orders/undefined`
is the failure this exists to prevent. Methods may be written either
`"get"` or `"GET"`; the returned object always uses Inertia's lowercase form.

## Vite plugin

```ts
// vite.config.ts
import { blokInertia } from "@blokjs/inertia-client/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), blokInertia()],
});
```

`blokInertia()` **wraps** `@inertiajs/vite` — page resolution
(`createInertiaApp({ pages: { path, extension, lazy, transform } })`), the SSR
transform and the HMR-backed dev SSR endpoint are all upstream behaviour, and
every `@inertiajs/vite` option (`ssr`, `frameworks`) is passed through. On top
of that it adds four Blok-specific things, all written into the Vite `outDir`
(`dist/` by default), which is the handoff directory the Blok server reads:

| File / value | What it is |
|---|---|
| `dist/.blok-asset-version` | sha256 of `dist/.vite/manifest.json`. The server reads it into `ASSET_VERSION` and sends it as `X-Inertia-Version`. `"dev"` while the dev server runs. |
| `import.meta.env.BLOK_ASSET_VERSION` | The same value, inlined into the bundle. |
| `dist/pages.json` | `{ root, pages }` — the page components found on disk, for the server's `ensurePagesExist` check. |
| `dist/.blok-ssr-url` + `import.meta.env.BLOK_SSR_URL` | Where the server POSTs a page to have it rendered: the Vite dev endpoint `/__inertia_ssr` in dev, `http://127.0.0.1:13714/render` in production. Empty when no SSR entry exists. |

`build.manifest` is forced on — the asset version is a hash of that manifest,
so turning it off is an error.

### Dev proxy

In dev, everything that is not a Vite-owned path is proxied to the Blok server
(`BLOK_URL`, default `http://localhost:4000`) with `X-Inertia-Version: dev`
attached, so a dev visit can never 409 on a version mismatch.

```ts
blokInertia({
  proxy: { target: "http://localhost:4000", exclude: /^\/(?:@|src\/)/ },
  pages: { path: "src/Pages", extension: [".tsx"] },
  ssr: { entry: "src/ssr.tsx" },
});
```

Pass `proxy: false` to turn it off — that is standalone mode, below.

## Standalone mode (SPA and Blok on different origins)

With the proxy off, the SPA is served from its own origin (`:5173`, a CDN, …)
and talks to Blok cross-origin. Blok must then send CORS headers, and they must
cover Inertia's protocol headers — a missing `Access-Control-Expose-Headers`
entry is invisible in the network tab but makes redirects and version
mismatches unreadable to the client.

```http
Access-Control-Allow-Origin: https://app.example.com
Access-Control-Allow-Credentials: true
Access-Control-Allow-Headers: X-Inertia, X-Inertia-Version, X-Inertia-Partial-Data,
  X-Inertia-Partial-Component, X-Inertia-Partial-Except, X-Inertia-Reset,
  X-Inertia-Error-Bag, X-Inertia-Devtools-Request, X-Inertia-Devtools-Session,
  Precognition, Precognition-Validate-Only, X-XSRF-TOKEN
Access-Control-Expose-Headers: X-Inertia, X-Inertia-Location, X-Inertia-Redirect,
  X-Inertia-Version, Precognition, Precognition-Success
```

`Access-Control-Allow-Origin` must name the SPA origin explicitly — `*` is
incompatible with `Allow-Credentials: true`, and Inertia sends the session
cookie on every visit. The initial page then comes from a JSON fetch rather
than a `data-page` attribute, via `createInertiaApp`'s `page` option.

## Testing

```bash
bun run --filter @blokjs/inertia-client test
```

The suite runs a real `vite.build()` and `vite.createServer()` in temp
directories, proxies against a stub Blok server on a random port, and
typechecks the React, Vue and Svelte fixtures under
`tests/fixtures/` with `tsc --noEmit`.
