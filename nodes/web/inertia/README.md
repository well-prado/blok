# @blokjs/inertia

The Inertia **v3** protocol adapter node. It turns a component name, a bag of
already-resolved props and the request headers into a `RespondEnvelope` the
`http` trigger emits verbatim:

- **no `X-Inertia` header** → `200 text/html`, the HTML shell with the page
  object in `<script type="application/json" data-page="app">`,
- **`X-Inertia: true`** → `200 application/json`, the bare page object,
- plus the control responses: version conflict, external location, fragment
  redirect, and the 303 rule.

Both answers carry `Vary: X-Inertia` — the same URL serves both.

This node is the **serializer**. Deciding which props to compute (optional,
deferred, merge, once, scroll) is the `page` control step's job — see
[Typed pages](#typed-pages-definepage-and-the-page-control-step) below; by the
time this node runs, `props` are values.

```json
{
  "id": "render",
  "use": "@blokjs/inertia",
  "inputs": {
    "component": "Users/Index",
    "props": { "users": { "$ref": { "step": "list-users", "path": ["users"] } } },
    "version": "v1"
  }
}
```

`headers`, `method` and `url` default to the live request (`ctx.request`), so a
hand-written workflow only needs `component` + `props`.

## Request headers the node reads

| Header | Effect |
| --- | --- |
| `X-Inertia` | `true` selects the JSON page object over the HTML shell. |
| `X-Inertia-Version` | On a **GET**, a value different from `version` produces the 409 conflict. Never on another method. |
| `X-Inertia-Partial-Component` | Must equal `component`, otherwise the request is treated as a full visit. |
| `X-Inertia-Partial-Data` | Comma-separated prop paths (dot notation) to keep. |
| `X-Inertia-Partial-Except` | Comma-separated prop paths to drop, applied after `Partial-Data`. |
| `X-Inertia-Reset` | Prop paths returned unmerged: stripped from `mergeProps`/`prependProps`/`deepMergeProps` (and from the `matchPropsOn` entries that address them), with `scrollProps[<prop>].reset = true`. For a scroll prop, naming the prop (`posts`) or its wrapper path (`posts.data`) means the same thing. |
| `X-Inertia-Error-Bag` | Nests `props.errors` under that bag name. |
| `X-Inertia-Except-Once-Props` | Once-prop cache keys the client still holds, so the resolver **skips those prop nodes entirely** (#1009). The `onceProps` **entry is always echoed**, or the client would drop its cached copy. A value resolved anyway — `fresh`, an elapsed `until`, or an explicit `only` — ships alongside its entry. |
| `X-Inertia-Infinite-Scroll-Merge-Intent` | `prepend` / `append` — moves scroll props between `mergeProps` and `prependProps`. |
| `Purpose: prefetch` | A fragment redirect stays an ordinary redirect instead of becoming a 409. |

`errors` and every path in `alwaysProps` survive both partial-reload filters.

## Page object fields

Always emitted: `component`, `props` (with `errors`, `{}` when there are none),
`url`, `version` (`""` when untracked). Everything else is **omitted** when it
does not apply — never `false`, never `[]`, never `{}`.

| Field | Emitted when |
| --- | --- |
| `encryptHistory` | input is `true`, or the request/adapter default says so (#1013) |
| `clearHistory` | input is `true`, or the request was marked by `logoutResponse` (#1013) |
| `preserveFragment` | input is `true` |
| `mergeProps` | this is a **partial reload**, non-empty after reset filtering |
| `prependProps` | this is a **partial reload**, non-empty after reset filtering |
| `deepMergeProps` | this is a **partial reload**, non-empty after reset filtering |
| `matchPropsOn` | this is a **partial reload**, non-empty (`"<propPath>.<keyField>"` entries) |
| `scrollProps` | non-empty (`{ <propKey>: { pageName, previousPage, nextPage, currentPage, reset } }` — keyed by the PROP, which is what `<InfiniteScroll data="posts">` looks up) |
| `deferredProps` | non-empty **and** this is a full visit |
| `rescuedProps` | non-empty **and** this is a partial reload |
| `sharedProps` | non-empty and `exposeSharedPropKeys` is not `false` |
| `onceProps` | non-empty (`{ key: { prop, expiresAt } }`; `expiresAt` is epoch **milliseconds**, `null` when it never expires) |
| `flash` | non-empty |

## Shell

The default shell carries `<title data-inertia>` (v3 renamed the attribute from
`inertia`) and two markers:

| Marker | Replaced with |
| --- | --- |
| `<!--blok:head-->` | the `head` input — server-rendered `<Head>` tags |
| `<!--blok:app-->` | `<div id="app"></div>` plus the boot script |

`rootId` renames the root element (and the script's `data-page` value).
`viewData` fills `{{key}}` placeholders in the shell and is **never** sent to
the client. A custom `shell` must contain `<!--blok:app-->`.

The page JSON is escaped for a `<script>` context — every `/` as `\/`, every
`<` as its `<` escape, and the two JS line terminators — with **no**
HTML-entity encoding, because the browser does not decode entities inside a
script element. `JSON.parse(el.textContent)` round-trips it exactly.

## Control responses

| Input / export | Response |
| --- | --- |
| version mismatch (GET only) | `409`, empty body, `X-Inertia-Location: <url>`, `X-Inertia-Version: <current>`, **no** `X-Inertia` header |
| `location: "https://…"` / `location(url)` | `409` + `X-Inertia-Location` |
| `redirect: "/a#b"` / `redirect(url)` | `409` + `X-Inertia-Redirect` (non-prefetch); otherwise an ordinary redirect |
| `redirect` after PUT/PATCH/DELETE | `303` (never `302` — a 302 makes the browser replay the write) |
| `redirect(url, { preserveFragment: true })` | adds `X-Inertia-Preserve-Fragment: true`; feed it back as the node's `preserveFragment` input to emit the page field |

The `http` trigger also runs a safety net (`inertia303SafetyNet`): a `302`
leaving the trigger on a non-GET request that carried `X-Inertia: true` is
rewritten to `303`, so a middleware short-circuit or rate-limiter cannot leak
a replayable redirect.

## Security: history encryption, logout, authorization

### History encryption

The client can encrypt what it stores in `history.state`, so pressing Back
after a logout cannot reveal the previous page. Three ways to ask for it, in
falling precedence:

| Scope | How |
| --- | --- |
| one page | the node's `encryptHistory` input — `...encryptHistory()`, and `...encryptHistory(false)` to opt out |
| one route group | the `inertia.encryptHistory` middleware |
| the whole app | `configureHistory({ encrypt: true })` |

```ts
import { configureHistory, encryptHistory, encryptHistoryMiddleware } from "@blokjs/inertia";

configureHistory({ encrypt: true });            // app-wide default

export default {
  "inertia.encryptHistory": encryptHistoryMiddleware(),   // a route-group opt-in
};

// trigger: http.get("/secret", { middleware: ["inertia.encryptHistory"] })
```

The middleware marks the live `ctx`, which middleware shares with the workflow
it guards, so every page serialized in that request carries the flag. The page
object never carries `encryptHistory: false` — an opt-out simply omits it.

> **HTTPS (or `localhost`) is required.** Encryption uses
> `window.crypto.subtle`, which browsers expose only in a secure context. Over
> plain HTTP the client logs *"Encryption is not supported in this environment.
> SSL is required."* and stores the page **unencrypted** — the flag silently
> buys you nothing.

### Logout

Logging out must **clear** the history, or the encrypted pages behind the Back
button stay readable with the key still in `sessionStorage`.

```ts
import { logoutNode, logoutResponse } from "@blokjs/inertia";

step("logout", logoutNode, { redirectTo: "/login" });   // as a step
// or inside your own node: return logoutResponse(ctx, { redirectTo: "/login" });
```

`logoutResponse` returns a **`303`** (never a `302`: a 302 makes the browser
re-issue the logout write) and marks the request so the next page object
carries `clearHistory: true`. The client then drops its history key and IV,
and the entries behind Back can no longer be decrypted.

The mark is request-scoped, so a page rendered **in the same request** picks it
up directly. The normal case — a redirect — is covered by the signed flash
cookie (#996): `logoutResponse` persists the mark, `inertia.shared` reads it
back on the next request, and the page the user lands on carries
`clearHistory: true` **once**. Wire `clearHistory: {"$ref": {"step": "flash",
"path": ["clearHistory"]}}` into the render step for that (the `flash` step
reports `true` or nothing — never `false` — so it can't override a mark set in
the same request). Without `BLOK_FLASH_SECRET` configured, logout keeps the
request-scoped-only behaviour instead of failing.

### Authorization

Inertia has no authorization protocol; the documented convention is to ship
decisions as props and enforce them on the server. `can()` builds the prop,
`authorize()` does the enforcing.

```ts
import { authorize, authorizeNode, can } from "@blokjs/inertia";

authorize("edit", post.authorId === user.id);   // throws 403 unless allowed

props: {
  can: can({ create: user.isAdmin }),
  posts: posts.map((post) => ({
    ...post,
    can: can({ edit: () => post.authorId === user.id }),
  })),
}
```

`authorize` throws a `GlobalError` with code `403` and body
`{ error: "forbidden", ability }` — the same shape `@blokjs/throw` produces, so
the HTTP trigger writes it to the wire unchanged. Rendering that 403 as an
Inertia **error page** instead of a JSON body is #1014.

`authorizeNode` is the same check as a step
(`step("guard", authorizeNode, { ability: "edit", allowed: false })`).
## Typed pages: `definePage()` and the `page` control step

A page's props are declared ONCE, outside the workflow callback, so the type is
importable by the frontend and by codegen:

```ts
import { always, defer, definePage, merge, once, optional, scroll, shared } from "@blokjs/inertia";
import { http, workflow } from "@blokjs/core";

export const OrdersIndex = definePage("Orders/Index", {
  auth:    always(currentUser),                                 // ignores only/except
  orders:  listOrders,                                          // regular
  filters: optional(loadFilters),                               // only when asked for
  stats:   defer(heavyStats, { group: "dashboard", rescue: true }),
  feed:    merge(loadFeed, { append: "data", matchOn: "id" }),   // #1009
  plans:   once(loadPlans, { until: "1h" }),                     // #1009
  posts:   scroll(listPosts),                                    // #1010
});

export default workflow("Orders page", { version: "1.0.0", trigger: http.get("/orders") }, (req) => {
  OrdersIndex.render(req, "page", "/orders", {
    orders: { userId: shared(currentUser, "auth").id },
    stats:  { userId: req.query.userId },
  }, { version: "v1" });
});
```

`render()` takes **node inputs per prop** (handles allowed), not resolved
values — the runner decides per request which prop nodes actually run. It emits
exactly one `page` control step.

The frontend reads the props through the phantom type the `PageDef` carries:

```ts
import type { PageProps } from "@blokjs/inertia";
import type { OrdersIndex } from "../../workflows/orders";

export default function Index(props: PageProps<typeof OrdersIndex>) { … }
```

`optional` and `defer` keys are `T | undefined`; every other mode is present.
`errors` is always there. `@blokjs/inertia-client`'s `PagePropsOf<T>` reads the
same `__props` carrier.

`getPageRegistry()` returns every page declared in the process — component,
per-prop mode metadata, Zod output schema and source `file:line` — which is what
`blokctl gen` (#998) and DevTools (#1017) consume.

### Resolution rules

| Visit | Runs | Does not run |
| --- | --- | --- |
| Full visit (no `X-Inertia-Partial-Component`, or one naming a different component) | `regular`, `always`, `merge`, `scroll`, and `once` unless the client still holds it | `optional`, `defer` |
| Partial reload, `X-Inertia-Partial-Data` set | the named props (dot paths select by their ROOT segment) plus `always` — naming a `once` prop ALWAYS resolves it | everything else |
| Partial reload, no `X-Inertia-Partial-Data` | `regular`, `merge`, `scroll`, and `once` unless the client still holds it, minus any `X-Inertia-Partial-Except`; `always` is exempt | `optional`, `defer` |

"the client still holds it" is `X-Inertia-Except-Once-Props` naming the prop's
cache key, with no `fresh` and no elapsed `until` — see
[merge props and once props](#merge-props-and-once-props-1009).

Selected props run **in parallel**, each through the normal step machinery — so
per-prop `retry`, `idempotencyKey` and `maxDuration` all work, and each result
lands at `ctx.state["<pageId>.<key>"]` (`run.state("page.orders")` in tests).
Because they run concurrently, **one prop can never read another's output**;
read the request, or a middleware step's output via `shared()`.

A prop declared `rescue: true` that throws is omitted from `props`, listed in
`rescuedProps`, and logged — the run still succeeds. Without `rescue` the throw
fails the workflow like any other step.

### JSON form

The same step in a JSON workflow:

```json
{
  "id": "page",
  "page": {
    "component": "Orders/Index",
    "url": "/orders",
    "props": {
      "auth":    { "use": "current-user", "mode": "always" },
      "orders":  { "use": "list-orders", "inputs": { "userId": { "$ref": { "step": "@trigger", "path": ["query", "userId"] } } } },
      "filters": { "use": "load-filters", "mode": "optional" },
      "stats":   { "use": "heavy-stats", "mode": "defer", "group": "dashboard", "rescue": true },
      "feed":    { "use": "load-feed", "mode": "merge", "merge": { "append": "data", "matchOn": "id" } },
      "plans":   { "use": "load-plans", "mode": "once", "once": { "until": "1h", "as": "plans" } },
      "results": { "use": "load-results", "mode": "defer", "group": "dashboard", "merge": { "deep": true } },
      "posts":   { "use": "list-posts", "mode": "scroll", "scroll": { "pageName": "page" } }
    },
    "inputs": { "version": "v1" }
  }
}
```

| Field | Meaning |
| --- | --- |
| `page.component` | required — the client-side page component name |
| `page.url` | literal, `{$ref}` or `js/` expression; defaults to the request URL |
| `page.props.<key>.use` / `.type` | the node that resolves the prop, exactly like a step |
| `page.props.<key>.inputs` | that node's inputs — same `{$ref}` / `{$tpl}` surface a step takes |
| `page.props.<key>.mode` | `regular` (default), `always`, `optional`, `defer`, `merge`, `once`, `scroll` |
| `page.props.<key>.group` / `.rescue` | `defer` only |
| `page.props.<key>.merge` / `.once` / `.scroll` | client-side metadata (#1009/#1010). Independent of `mode`, so `mode: "defer"` + `merge` is a deferred prop that merges when it arrives |
| `page.props.<key>.retry` / `.idempotencyKey` / `.idempotencyKeyTTL` / `.maxDuration` | per-prop reliability knobs |
| `page.serializer` | node ref; defaults to `@blokjs/inertia` |
| `page.inputs` | extra serializer inputs (`version`, `errors`, `viewData`, `shell`, `encryptHistory`, …) |

### Merge props and once props (#1009)

`merge()` never changes WHEN a prop resolves — only what the client does with
the value. Labels ride **partial reloads only**: a full visit replaces props
wholesale, so it carries none of `mergeProps` / `prependProps` /
`deepMergeProps` / `matchPropsOn`.

```ts
merge(loadTags)                                     // mergeProps: ["tags"]        (root append)
merge(loadTags, { prepend: true })                  // prependProps: ["tags"]
merge(loadUsers, { append: "data" })                // mergeProps: ["users.data"]
merge(loadDash, { append: ["notifications", "activities"] })
merge(loadForum, { append: "posts", prepend: "announcements" })
merge(loadUsers, { append: "data", matchOn: "id" }) // + matchPropsOn: ["users.data.id"]
merge(loadMixed, { append: { "users.data": "id", messages: "uuid" } })
merge(loadChat,  { deep: true, matchOn: "messages.id" })  // deepMergeProps: ["chat"]
```

A `matchPropsOn` entry is `"<mergePath>.<field>"` — the client splits on the
LAST dot and matches the head against the merge path, replacing items whose
field matches instead of appending them. The map form gives each path its own
field; `matchOn` applies the same field to every path the prop labels.

`X-Inertia-Reset: <paths>` still RESOLVES those props — the client wants a fresh
copy — and returns them without labels, so it replaces rather than merges.
Client-side prop helpers (`router.replaceProp` / `appendToProp` /
`prependToProp`) need nothing from the server.

`once()` is the one mode that changes resolution: once the client holds the
value it sends the cache key in `X-Inertia-Except-Once-Props`, and the prop's
**node is not run at all** — only its `onceProps` entry comes back.

| Option | Effect |
| --- | --- |
| `as: "roles"` | the cache key, so two pages can share one remembered value under different prop names. Defaults to the prop key. |
| `until` | `"1h"` / `"500ms"` (a duration from now), a number of **seconds**, or an absolute date (`Date` / anything `Date.parse` takes). Emitted as `expiresAt` in epoch ms; an absolute deadline already in the past resolves again despite the header. |
| `fresh: true` | resolve and resend even when the client says it still holds the value. |

Explicit always wins: `router.reload({ only: ["plans"] })` resolves the prop
whatever the header says. Prefetch requests (`Purpose: prefetch`) carry the
remembered entries like any other request, so a prefetched page arrives with
its once props already filled in.

Conditional once props are the documented auth pattern — remember the user
while signed in, and overwrite the remembered copy with `null` on sign-out:

```ts
const Layout = definePage("App/Layout", { auth: once(currentUser, { as: "auth" }) });
// …and a signed-out response returns `auth: null` (a plain prop), which
// replaces whatever the client remembered.
```

Both modes compose with the resolution modes by wrapping:

```ts
defer(merge(loadResults, { deep: true }), { group: "dashboard" })  // deferred, then mergeable
once(merge(loadActivity, { append: "data" }))                      // remembered AND mergeable
```

The innermost resolution mode wins the mode slot (`defer` above); `merge` and
`scroll` only contribute metadata, so every bag survives the composition.

### Infinite scroll (#1010)

`scroll()` is `merge()` with a cursor. The prop resolves like a regular one; the
client (`<InfiniteScroll data="posts">`) grows the item array and replaces the
cursors around it.

```ts
import { definePage, paginate, paginatedSchema, scroll } from "@blokjs/inertia";

const listPosts = defineNode({
  name: "list-posts",
  description: "one page of posts",
  input: z.object({ page: z.union([z.number(), z.string()]).optional() }),
  output: paginatedSchema(PostSchema),
  async execute(_ctx, input) {
    const { rows, total } = await db.posts(input.page ?? 1, 10);
    return paginate(rows, { page: input.page ?? 1, perPage: 10, total });
  },
});

export const Feed = definePage("Feed/Index", { posts: scroll(listPosts) });
// …render(req, "page", "/feed", { posts: { page: req.query.page } })
```

| Option | Effect |
| --- | --- |
| `wrapper` | the sub-path holding the items — the one the client GROWS. Default `"data"`; `""` grows the whole prop. Only this path is labelled, so the cursors beside it are replaced. |
| `pageName` | the query parameter the client bumps. Overrides the resolved metadata's own; two scroll props on one page need distinct names (`?users=2&orders=3`). |
| `metadata` | `(output) => ScrollMetadata` — for an output that does not already carry the four cursor fields. |

The `scrollProps` entry is read from the **resolved output**, not from the
declaration, so every scroll response re-emits a fresh cursor. The output must
satisfy `ScrollMetadata` (`pageName`, `previousPage`, `nextPage`, `currentPage`)
or supply a `metadata` resolver — a scroll prop whose output carries none of
them fails the request rather than shipping a feed that can never load.

`paginate()` and `cursorPaginate()` are pure helpers that shape that envelope;
they hold no database opinion.

```ts
paginate(rows, { page, perPage })              // rows is the WHOLE collection — sliced here
paginate(rows, { page, perPage, total })       // rows is already the page — trusted as-is
cursorPaginate(rows, { cursor, next, prev })   // opaque cursors, pageName defaults to "cursor"
```

`paginatedSchema(item)` / `cursorPaginatedSchema(item)` are their Zod forms for a
node's `output`.

| Request | Response |
| --- | --- |
| full visit | `props.posts`, `scrollProps.posts`, **no** merge label |
| partial + `X-Inertia-Infinite-Scroll-Merge-Intent: append` | `mergeProps: ["posts.data"]` |
| …`: prepend` | `prependProps: ["posts.data"]` |
| partial + `X-Inertia-Reset: posts` | `scrollProps.posts.reset = true`, no label |
| `defer(scroll(…))`, full visit | `deferredProps`, **no** `scrollProps`; both on the deferred partial |

Internally the step lowers to one inner step per prop, named `<pageId>.<key>`,
plus the serializer at `<pageId>.$render`. Studio tags those inner steps
`page:<pageId>`, the way middleware inner steps are tagged.
## Middleware pack + flash (#996)

Two ordinary Blok middleware workflows (`middleware: true`, run on the parent
ctx before the page workflow). This is not a second middleware system — it is
the existing one, registered by name:

```ts
// src/Workflows.ts
import { createAuthMiddleware, createSharedMiddleware } from "@blokjs/inertia";
import { WorkflowRegistry } from "@blokjs/runner";

export default {
  "inertia.shared": await createSharedMiddleware({ currentUser }),
  "inertia.auth": await createAuthMiddleware({ redirectTo: "/login" }),
  // …your page workflows
};
WorkflowRegistry.getInstance().setGlobalMiddleware(["inertia.shared"]);
// per route: trigger: http.get("/orders", { middleware: ["inertia.auth"] })
```

| Workflow | Steps | What it does |
| --- | --- | --- |
| `inertia.shared` | `auth`, `flash` | runs your `currentUser` node into `ctx.state.auth`, then verifies + clears the signed flash cookie into `ctx.state.flash` |
| `inertia.auth` | `inertiaGuest`, `inertiaAuthGate`, `inertiaAuthRedirect` | when `auth.id` is missing, throws `302 Location: /login` (`@blokjs/throw`'s `headers`) |

> **Reserved step ids: `auth` and `flash`.** Step ids are ONE flat namespace
> per run (footgun 3) and middleware shares the page workflow's `ctx`, so a
> page step called `auth` overwrites the signed-in user. `inertia.auth`'s own
> ids are prefixed (`inertiaGuest`, `inertiaAuthGate`,
> `inertiaAuthRedirect`) for the same reason.

**With the `page` control step (#1008) there is nothing to wire.** `page`
reads the `flash` state slot itself and folds it into the serializer's inputs:
errors, the error bag, page flash, `preserveFragment`, `clearHistory`, and the
clearing `Set-Cookie`. Anything you pass through `render()`'s options wins —
`errors` and `flash` MERGE, with your keys on top of the middleware's. Read
`auth` with `shared()`:

```ts
import { definePage, shared } from "@blokjs/inertia";

const OrdersPage = definePage("Orders/Index", { auth: shared(currentUser, "auth") });
export default workflow("orders", { version: "1.0.0", trigger: http.get("/orders") }, () => {
  OrdersPage.render("page", { auth: shared(currentUser, "auth") });
});
```

A hand-written serializer step (no `page` step) wires the same fields itself —
`inertia.shared`'s `flash` step exposes `{ errors, bag, flash,
preserveFragment, clearHistory, cookie, present }`, and `cookie` has to go
through as `cookies`, because the response that CONSUMED the flash is the one
that expires it:

```json
{ "id": "render", "use": "@blokjs/inertia", "inputs": {
  "component": "Orders/Index",
  "props":   { "auth": { "$ref": { "step": "auth", "path": [] } } },
  "errors":  { "$ref": { "step": "flash", "path": ["errors"] } },
  "errorBag":{ "$ref": { "step": "flash", "path": ["bag"] } },
  "flash":   { "$ref": { "step": "flash", "path": ["flash"] } },
  "clearHistory": { "$ref": { "step": "flash", "path": ["clearHistory"] } },
  "cookies": [ { "$ref": { "step": "flash", "path": ["cookie"] } } ]
}}
```

The write side is `redirectBack()` / `back()`, plus a chainable `flash()`:

```ts
return redirectBack(ctx.request, { errors: { sku: "Required." }, bag: "createOrder", fallback: "/orders" });
return flash("toast", { type: "success" }).render({ component: "Orders/Index", props });
```

`redirectBack()` persists errors AND flash (and `preserveFragment`) in the
signed one-shot cookie, and answers a non-GET with `303` so the write is never
replayed. `withAllErrors: true` on the node ships every message per field
(`string[]`) instead of the first (`string`). On a version-mismatch `409` the
node RE-SIGNS any pending flash, so it survives the forced full visit.

**`BLOK_FLASH_SECRET` is required** for anything that touches the cookie —
HMAC-SHA256, `HttpOnly; SameSite=Lax; Path=/`. There is no default: an
unsigned flash cookie is a forgeable one. A tampered or wrong-secret cookie
reads back as "no flash", never as an error.

## Shared data, routes and naming (#1015)

### `share()` / `shareOnce()` — data every page gets

```ts
// src/Bootstrap.ts (imported once, before the workflows)
import { share, shareOnce } from "@blokjs/inertia";

share("appName", "Blok");                                  // static
share("auth", (req) => userFromSession(req));              // LAZY: per request
share("flags", loadFlags, { always: true });               // survives every partial filter
shareOnce("countries", loadCountries, { until: "1d" });    // the client caches it
```

Shared values are merged **under** the page's own props (a page prop of the
same name wins, and the shared value is then never resolved at all), and their
top-level keys ride the page object as `sharedProps` so
[instant visits](https://inertiajs.com/docs/v3/the-basics/instant-visits) can
carry them to the next page before the server answers. `exposeSharedPropKeys:
false` on a page hides the key list; the values still ship.

Selection follows the same table as declared props:

| Request | `regular` | `always` | `once` |
| --- | --- | --- | --- |
| full visit | resolved | resolved | resolved unless `X-Inertia-Except-Once-Props` names it |
| partial with `only` | only when named | resolved | only when named |
| partial without `only` | resolved | resolved | not resolved |
| `except` names it | not resolved | resolved | not resolved |

A lazy value is called with `ctx.request`, at most once per request, and only
when the key is actually selected — so `share("auth", expensive)` costs nothing
on a partial reload that asked for something else. A prop resolver that needs
another shared value reads it from the same per-request cache:

```ts
const tenant = await getShared("tenant", { id: "public" }, ctx);
```

Namespace shared data (`share("auth", { user })`, not `share("user", …)`) —
keys are top-level props and a page prop of the same name silently wins. A key
containing a dot is rejected for that reason.

> **Registry vs. the `inertia.shared` middleware.** The middleware (#996) runs
> two real steps (`auth`, `flash`) whose outputs land in `ctx.state` for
> `shared(currentUser, "auth")` to feed into a prop's INPUTS. The registry
> hands values straight to the CLIENT on every page with no wiring. Use the
> middleware when a prop needs the value; use the registry when the page does.
> Registry values are resolved by the serializer, so they reach a `page` step,
> a hand-written `step("render", …)` and `inertia.page()` alike.

### `inertia.page()` — a route with no controller

```ts
// src/Workflows.ts — Laravel's Route::inertia()
export default { about: await inertia.page("/about", "About", { team: "Blok" }) };
```

One generated workflow, one step, no workflow file. Pass
`{ name, middleware, inputs }` as a fourth argument for the workflow name, a
middleware chain, or extra serializer inputs (`version`, `viewData`, `shell`, …).

### `resolveUrlUsing()` / `transformComponentUsing()`

```ts
resolveUrlUsing((req) => new URL(req.url, "http://x").pathname);  // page-object `url`
transformComponentUsing((name) => name.toLowerCase());            // component name
```

Both are adapter-wide and set at boot. The URL resolver wins over a page's own
`url` (every page passes one, so an override that lost to it would never
apply). The component transform runs before the name is emitted and before
`ensurePagesExist` checks it.

> A component transform is NOT seen by the `page` control step, which compares
> `X-Inertia-Partial-Component` against the untransformed name. The wire output
> stays correct (the serializer narrows), but the step resolves the full prop
> set on such a partial, and an `optional`/`defer` prop asked for by name will
> not resolve. Prefer naming components as the client spells them.

### `ensurePagesExist()` — fail the boot, not the route

```ts
await ensurePagesExist();   // on unless NODE_ENV=production
```

Checks every `definePage()` component (and every `inertia.page()` one) against
the `pages.json` the Blok Vite plugin writes into its `outDir`, and throws
naming the missing ones plus a `Fix:` line. The manifest is looked up at
`$BLOK_STATIC_DIR/pages.json` (override with `{ manifest }` / `{ dir }`); when
it is absent the check WARNS and skips, so booting the server before the client
has ever been built still works.

### `withProps()` — reusable prop bundles

```ts
const dashboard = withProps({ auth: always(currentUser), nav: loadNav });
export const Home = definePage("Home", { ...dashboard, stats: loadStats });
export const Team = definePage("Team", { ...dashboard, members: loadMembers });
```

### History size

A page object over 8 MiB logs one warning per process and still ships —
browsers keep the page object in history state and Firefox hard-fails at
16 MiB. Move the bulk behind `defer()` / `optional()`, or paginate it.

## Validation, error bags and Precognition (#1011)

### `@blokjs/validate`

A validation step that RETURNS its verdict instead of throwing, because a form
failure is data, not an exception:

```ts
import { z } from "zod";

const OrderSchema = z.object({ sku: z.string().min(1, "Required."), qty: z.number().min(1, "Too few.") });

const checked = step("check", validateNode, { schema: OrderSchema, data: req.body }, { precognition: true });
```

`{ ok, data, errors }` out. `errors` is keyed by DOT PATH — `user.name`,
`items.0.name` — which is what Inertia's client expects and what saves every
app from hand-mapping a `ZodError`. One message per key by default;
`withAllErrors: true` gives every message as a `string[]`, matching the
adapter option of the same name. `schema` takes a Zod schema VALUE in
TypeScript, or a plain JSON Schema object in a JSON workflow (validated with
`ajv`); both produce identical keys.

Feed the failure straight into `redirectBack()`:

```ts
return redirectBack(ctx.request, { errors });
```

The error BAG now defaults to the request's `X-Inertia-Error-Bag`, so a page
with two forms keeps them apart without the workflow plumbing the header — the
bag name rides the signed cookie, because the bounce-back GET does not carry
the header.

### Precognition

Inertia's live validation sends the real form to the real endpoint with
`Precognition: true` and asks only "would this validate?". Mark the validation
step and the runner does the rest:

```ts
export default workflow("orders-create", { version: "1.0.0", trigger: http.post("/orders") }, (req) => {
  const checked = step("check", validateNode, { schema: OrderSchema, data: req.body }, { precognition: true });
  branch("route", eq(checked.ok, true), {
    then: () => { step("create", createOrder, { order: checked.data }); },
    else: () => { step("reject", bounceBack, { errors: checked.errors }); },
  });
});
```

On a request carrying the marker header, the runner STOPS after the marked
step and answers from its `{ ok, errors }`:

| Outcome | Response |
| --- | --- |
| no errors in the asked-about fields | `204` + `Precognition: true`, `Precognition-Success: true`, empty body |
| errors | `422 { "errors": { … } }` + `Precognition: true` |
| any request on a route with a marked step | `Vary: Precognition` |

`Precognition-Validate-Only: sku,user.name` narrows the reported errors to
those fields (a parent path also covers its children). **No step after the
marked one runs** — that is the entire point: a keystroke must not charge a
card. A request WITHOUT the header runs the workflow end to end, and a
workflow with no marked step is never dry-run by accident, so the same
workflow serves both the live validation and the real submit.

The mechanism is the runner's, not the http trigger's: a worker or cron run
carries no such header and is unaffected, and any transport that understands a
`RespondEnvelope` gets the 204/422 for free.

Test it without a server:

```ts
import { runPrecognition } from "@blokjs/core/testing";

const dry = await runPrecognition(ordersCreate, { body: { sku: "" }, fields: ["sku"] });
dry.status;                            // 422
dry.errors;                            // { sku: "Required." }
dry.run.step("create")?.executed;      // false — the assertion that matters
```

## Production error pages (#1014)

In development nothing changes: the trigger's JSON diagnostics are a NON-Inertia
response, and the stock client shows those in its error modal — the documented
dev experience.

In production (`NODE_ENV=production`, or `BLOK_INERTIA_ERROR_PAGES=1` anywhere)
a failing request is rendered as an **Inertia page response carrying the real
status**. The client's own `isHttpException()` path fires
`inertia:httpException` and then swaps the page in, so a 404 renders in place,
the URL updates, and Back works. `BLOK_INERTIA_ERROR_PAGES=0` opts a production
deploy back out.

```ts
import { configureErrorPages, handleExceptionsUsing, render } from "@blokjs/inertia";

configureErrorPages({
  pages: { 404: "Errors/NotFound", 503: "Errors/Maintenance", default: "Errors/Error" },
  statuses: [403, 404, 500, 503],   // the default set
  viewData: { title: "Acme" },      // same shell/viewData knobs as a normal page
});
```

- `props` are `{ status, message }`, where `message` is the status's standard
  reason phrase — **never** the thrown error's message and never a stack. A
  production error body is exactly where a driver message or a connection
  string leaks.
- Shared data (`share()` / `shareOnce()`) is resolved on the error page, so a
  layout reading `auth` still renders. Errors happen outside the page workflow,
  so the MIDDLEWARE chain (`inertia.shared`, flash) has not run — anything the
  error page needs must come from the registry.
- `X-Inertia` requests get the JSON page object; a plain browser navigation gets
  the HTML shell. A client that is neither (an API call asking for JSON) keeps
  the trigger's own JSON body, untouched.
- Unmatched routes go through the same path: a browser or an Inertia visit gets
  the 404 page, everything else the trigger's JSON 404.
- A status named in `pages` is rendered even when it is not in `statuses`;
  every other status is gated by `statuses` and mapped through `default`.

### `handleExceptionsUsing()`

```ts
handleExceptionsUsing(({ status, error, request }) => {
  if (status === 503) return render("Errors/Maintenance", { until: "10:00" });
  if (status === 404) return null;          // this one keeps the trigger's own 404
  return render("Errors/Error", { status });
});
```

The hook sees EVERY status, not just the configured set, so it can add pages the
default map does not carry. Returning `null` (or `undefined`) falls through to
the response the trigger would have sent anyway — it is the per-status opt-out.

The HTTP trigger reaches all of this through ONE exported function,
`renderErrorPage(request, status, error)`, loaded with an optional dynamic
import: a project without `@blokjs/inertia` installed boots and errors exactly
as before.

> The `Errors/*` page components themselves ship with the SPA templates (#999).
> Until then, point `pages` at components your own client provides; a component
> the client cannot resolve is a client-side error, not a server one.

## Exports

```ts
import InertiaNode, {
  serializePage,   // the <script> escaper — also used by SSR (#1001) and DevTools (#1017)
  buildPage,       // page-object assembly, pure
  renderShell,     // HTML document around a page object
  redirect,
  location,
  encryptHistory,  // encryptHistory(false) opts a page out (#1013)
  clearHistory,
  versionConflict,
  DEFAULT_SHELL,
  HEAD_MARKER,
  APP_MARKER,
  // security (#1013)
  configureHistory,          // adapter option: { encrypt: boolean }
  encryptHistoryMiddleware,  // the `inertia.encryptHistory` middleware workflow
  historyNode,               // the step it runs — marks the request
  logoutResponse,            // 303 + the clearHistory mark
  logoutNode,                // logoutResponse as a step
  can,                       // rules -> the `can` prop object
  authorize,                 // throw 403 unless allowed
  authorizeNode,             // authorize as a step
  // typed page contracts (#995 / #1008)
  definePage,
  always,
  optional,
  defer,
  merge,
  once,
  scroll,
  shared,
  getPageRegistry,
  withProps,                 // reusable prop bundles (#1015)
  // shared data + routing (#1015)
  share,
  shareOnce,
  getShared,
  sharedKeys,
  inertia,                   // inertia.page(path, component, props?)
  inertiaPage,
  resolveUrlUsing,
  transformComponentUsing,
  ensurePagesExist,
  // production error pages (#1014)
  configureErrorPages,
  handleExceptionsUsing,
  render,                    // the hook's return value: render(component, props)
  renderErrorPage,           // what the HTTP trigger calls
  // #996
  redirectBack,
  back,
  flash,
  flashCookie,
  normalizeErrors,
  createSharedMiddleware,
  createAuthMiddleware,
} from "@blokjs/inertia";
import type { PageProps } from "@blokjs/inertia";
```

Registered in `HELPER_NODES` when the package is installed — the adapter as
`@blokjs/inertia`, and the three named nodes as `@blokjs/inertia.authorize`,
`@blokjs/inertia.logout` and `@blokjs/inertia.history` — so JSON workflows
reach all of them without any extra wiring. In TypeScript, pass the node object
to `step()` instead.

## Not this node's job

Merge/once RESOLUTION semantics (#1009), infinite-scroll paging (#1010), SSR
(#1001) and the client package. `definePage` (#995), the `page` control step
(#1008), the middleware pack (#996) and the shared-data registry (#1015) ship
here, but they are the AUTHORING, CONTROL and REQUEST layers — the node itself
still only serializes (the registry is resolved during that serialization,
which is why it lives on this side).
