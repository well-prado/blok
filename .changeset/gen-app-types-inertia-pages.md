---
"blokctl": minor
---

`blokctl gen app-types` now also emits the two files a Blok Inertia SPA needs:
`blok-pages.d.ts` (augmenting `@blokjs/inertia-client`'s `Pages`/`Routes` and
Inertia's own `InertiaConfig`) and the runtime `blok-routes.ts`, a single
`registerRoutes({…})` call with lowercase methods and `:param` URLs. Page prop
types come from the Zod output schemas `definePage()` records, so `optional()`
and `defer()` props become optional keys and a schemaless `runtimeNode()` stub
becomes `unknown` with a warning. New flags: `--out <dir>`, `--pages-only`,
`--with-all-errors` and `--watch`. A project without `@blokjs/inertia` skips it
all with one info line; a workflow module that throws is reported with its file
and message, the other pages are still written, and the run exits non-zero.
The static name extractor also learned the callback DSL's positional name, so
`workflow("orders.index", …)` is no longer missing from `blok-app.d.ts`.
