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

This node is the **serializer**. Resolving which props to compute (optional,
deferred, merge, once, scroll) is the `page` control step's job (#1008); by the
time the node runs, `props` are values.

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
| `X-Inertia-Reset` | Prop paths returned unmerged: stripped from `mergeProps`/`prependProps`/`deepMergeProps`, and `scrollProps[path].reset = true`. |
| `X-Inertia-Error-Bag` | Nests `props.errors` under that bag name. |
| `X-Inertia-Except-Once-Props` | Once-prop cache keys the client still holds: the prop and its `onceProps` entry are both omitted. |
| `X-Inertia-Infinite-Scroll-Merge-Intent` | `prepend` / `append` — moves scroll props between `mergeProps` and `prependProps`. |
| `Purpose: prefetch` | A fragment redirect stays an ordinary redirect instead of becoming a 409. |

`errors` and every path in `alwaysProps` survive both partial-reload filters.

## Page object fields

Always emitted: `component`, `props` (with `errors`, `{}` when there are none),
`url`, `version` (`""` when untracked). Everything else is **omitted** when it
does not apply — never `false`, never `[]`, never `{}`.

| Field | Emitted when |
| --- | --- |
| `encryptHistory` | input is `true` |
| `clearHistory` | input is `true` |
| `preserveFragment` | input is `true` |
| `mergeProps` | non-empty after reset filtering |
| `prependProps` | non-empty after reset filtering |
| `deepMergeProps` | non-empty after reset filtering |
| `matchPropsOn` | non-empty (`"<propPath>.<keyField>"` entries) |
| `scrollProps` | non-empty (`{ path: { pageName, previousPage, nextPage, currentPage, reset } }`) |
| `deferredProps` | non-empty **and** this is a full visit |
| `rescuedProps` | non-empty **and** this is a partial reload |
| `sharedProps` | non-empty and `exposeSharedPropKeys` is not `false` |
| `onceProps` | non-empty (`{ key: { prop, expiresAt } }`, `expiresAt` null when it never expires) |
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

## Exports

```ts
import InertiaNode, {
  serializePage,   // the <script> escaper — also used by SSR (#1001) and DevTools (#1017)
  buildPage,       // page-object assembly, pure
  renderShell,     // HTML document around a page object
  redirect,
  location,
  encryptHistory,
  clearHistory,
  versionConflict,
  DEFAULT_SHELL,
  HEAD_MARKER,
  APP_MARKER,
} from "@blokjs/inertia";
```

Registered in `HELPER_NODES` as `@blokjs/inertia`, so JSON workflows reach it
without any extra wiring.

## Not this node's job

`definePage` (#995), the middleware/session layer that flashes errors and
`preserveFragment` across a redirect (#996), the `page` control step that
resolves prop types (#1008), SSR (#1001) and the client package.
