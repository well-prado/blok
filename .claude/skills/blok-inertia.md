# Blok SPA (Inertia) — authoring guide

Blok speaks the Inertia **v3** protocol against the stock
`@inertiajs/react | vue3 | svelte` client — nothing is forked, nothing is
wrapped. **A page is a workflow, a prop is a step, navigation is the protocol.**

This mirrors the "SPA / Inertia" block in `AGENTS.md` / `CLAUDE.md`. Read
`.claude/skills/blok-framework.md` first: everything there (nodes, handles, no
`js/` strings, no `any`, Zod on every node) applies here unchanged. The full
prose is `docs/llms-full.txt`; the page index is `docs/llms.txt`.

---

## 1. Declare the page contract OUTSIDE the workflow callback

`definePage()` at module scope is what makes the contract extractable: the
frontend `import type`s it, `blokctl gen app-types` emits it, and the MCP tools
read it. A `page()` inside the callback could leak nothing to module scope.

```ts
// file: dashboard.ts
import { http, workflow } from "@blokjs/core";
import { always, defer, definePage, merge, once, scroll, shared } from "@blokjs/inertia";
import { currentUser, listOrders, listPosts, loadNotifications, loadPlans, heavyStats } from "./page-nodes.js";

export const Dashboard = definePage("Dashboard", {
  auth: always(currentUser),                                  // exempt from only/except
  orders: listOrders,                                         // regular
  stats: defer(heavyStats, { group: "dashboard", rescue: true }), // announced, fetched next
  notifications: merge(loadNotifications, { append: "data", matchOn: "id" }),
  plans: once(loadPlans, { until: "1h" }),                    // client caches it
  posts: scroll(listPosts),                                   // <InfiniteScroll> grows it
});

export default workflow(
  "dashboard",
  { version: "1.0.0", trigger: http.get("/", { middleware: ["inertia.shared"] }) },
  (req) => {
    Dashboard.render(req, "page", "/", {
      orders: { userId: shared(currentUser, "auth").id },
      stats: { since: "2026-01-01" },
      posts: { page: req.query.page },
    });
  },
);
```

```ts
// file: page-nodes.ts
import { defineNode, runtimeNode } from "@blokjs/core";
import { paginate, paginatedSchema } from "@blokjs/inertia";
import { z } from "zod";

const Order = z.object({ id: z.string(), total: z.number() });
const Post = z.object({ id: z.string(), title: z.string() });

export const currentUser = defineNode({
  name: "current-user",
  description: "The signed-in user.",
  input: z.object({}),
  output: z.object({ id: z.string(), email: z.string() }),
  execute: () => ({ id: "u-1", email: "ada@example.com" }),
});

export const listOrders = defineNode({
  name: "list-orders",
  description: "Orders belonging to one user.",
  input: z.object({ userId: z.string() }),
  output: z.array(Order),
  execute: () => [],
});

export const loadNotifications = defineNode({
  name: "load-notifications",
  description: "One page of notifications.",
  input: z.object({}),
  output: z.object({ data: z.array(z.object({ id: z.string(), text: z.string() })) }),
  execute: () => ({ data: [] }),
});

export const loadPlans = defineNode({
  name: "load-plans",
  description: "Pricing plans — they rarely change.",
  input: z.object({}),
  output: z.array(z.object({ id: z.string(), price: z.number() })),
  execute: () => [],
});

export const listPosts = defineNode({
  name: "list-posts",
  description: "One page of posts, shaped for <InfiniteScroll>.",
  input: z.object({ page: z.string().optional() }),
  output: paginatedSchema(Post),
  execute: (_ctx, input) => paginate([], { page: input.page ?? 1, perPage: 10 }),
});

/** A prop can be any runtime: this one is Python. */
export const heavyStats = runtimeNode<{ since: string }, { revenue: number }>(
  "dashboard-stats",
  "runtime.python3",
);
```

### Rules

- `render(req, id, url, inputs, opts?)` takes **node inputs per prop**, never
  resolved values. It emits ONE `page` control step; the RUNNER decides per
  request which prop nodes actually run.
- Props resolve **in parallel** as steps `<pageId>.<propKey>`, so one prop can
  never read another's output. Read the request, or a middleware step's output
  via `shared(node, "auth")`.
- Modes: `always`, `optional`, `defer`, `merge`, `once`, `scroll`. `merge` and
  `scroll` only describe what the CLIENT does, so they compose:
  `defer(merge(node, { append: "data" }))`.
- Two pages may not share a component name — it is the page identity.
- Never hand-roll the page object. The wire format lives only in
  `@blokjs/inertia`.
- Never write `ctx.state` / `ctx.vars` from a node; return output.

---

## 2. Middleware, flash and CSRF

There is no `HandleInertiaRequests`. These are ORDINARY Blok middleware
workflows, registered by name in `src/Workflows.ts`:

```ts
// file: workflows-registry.ts
import { createAuthMiddleware, createCsrfMiddleware, createSharedMiddleware, share } from "@blokjs/inertia";
import { WorkflowRegistry } from "@blokjs/runner";
import { currentUser } from "./page-nodes.js";

share("appName", "Blok SPA");                 // every page gets it

export default {
  "inertia.shared": await createSharedMiddleware({ currentUser }),
  "inertia.auth": await createAuthMiddleware({ redirectTo: "/login" }),
  "inertia.csrf": await createCsrfMiddleware(),
};

WorkflowRegistry.getInstance().setGlobalMiddleware(["inertia.csrf"]);
```

- **`auth` and `flash` are reserved step ids** in a page workflow — the shared
  middleware writes them.
- There is **no session store**. Flash, error bags and the CSRF bounce-back ride
  a signed one-shot cookie: `BLOK_FLASH_SECRET` is required, with no default.
- Redirect back with a message from inside a node:

```ts
// file: create-order.ts
import { defineNode } from "@blokjs/core";
import { flash } from "@blokjs/inertia";
import { z } from "zod";

export const createOrder = defineNode({
  name: "create-order",
  description: "Persist an order and bounce back with a toast.",
  input: z.object({ sku: z.string() }),
  output: z.unknown(),
  execute: (ctx, input) =>
    flash("toast", { type: "success", message: `${input.sku} created.` }).redirectBack(ctx.request, {
      fallback: "/orders/new",
    }),
});
```

---

## 3. Testing

`runPage()` from `@blokjs/core/testing` — the real engine, the real page step,
the real serializer. No server, no browser.

```ts
// file: dashboard.test.ts
import { runPage } from "@blokjs/core/testing";
import dashboard from "./dashboard.js";

export async function check(): Promise<void> {
  const page = await runPage(dashboard, {
    middleware: { auth: { id: "u-1", email: "ada@example.com" } },
    mock: { "dashboard-stats": async () => ({ revenue: 42_000 }) },
  });

  page.assert().component("Dashboard").has("orders").etc();
  // A deferred prop is announced, not resolved, on the full visit.
  await page.loadDeferredProps("dashboard");
}
```

A prop's step id is `"<pageId>.<propKey>"`, so
`run.step("page.stats")?.executed` answers "did this node run on this request".

---

## 4. Deployment modes

| Mode | Client | Wiring |
| --- | --- | --- |
| **in-project** | Vite app in `client/`, built to `client/dist` | `BLOK_STATIC_DIR=client/dist`; Blok serves the assets and the shell |
| **standalone** | separate Vite app on its own origin | `BLOK_CORS_ORIGIN` lists it; same protocol, no static mount |

Both build through the `blokInertia()` Vite plugin, which writes
`.blok-asset-version` (the `X-Inertia-Version` the 409 reload compares) and
`pages.json` (what `ensurePagesExist()` checks component names against).

---

## 5. Commands

| Command | What it does |
| --- | --- |
| `blokctl gen app-types` | writes `blok-pages.d.ts` (types the stock client hooks) and `blok-routes.ts` (the runtime route table for `route()`) |
| `blokctl add spa` | scaffolds the client into an existing project (`blokctl create spa` for a new one) |
| `blokctl inertia start-ssr` / `stop-ssr` / `check-ssr` | the SSR server on `:13714` |
| `blokctl inertia doctor` | shell markers, `ensurePagesExist`, `BLOK_FLASH_SECRET` / `BLOK_SESSION_SECRET`, `ASSET_VERSION`, `inertia.csrf`, SSR health — each failure prints a `Fix:` line |

---

## 6. Reading the app instead of grepping it

When the app is running with an MCP endpoint, three read-only tools answer the
contract questions directly (dev-only unless `BLOK_INERTIA_MCP=1`):

- `inertia.pages.list` — every page, every prop's mode, the declaring file:line
- `inertia.page.get(component)` — that page's props as a JSON Schema
- `inertia.routes.list` — every HTTP route and the component it renders

Statically, `getPageRegistry()` holds the same data in-process, and
`docs/llms.txt` / `docs/llms-full.txt` hold the prose.
