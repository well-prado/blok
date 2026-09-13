---
"@blokjs/inertia": minor
"@blokjs/helpers": patch
"@blokjs/trigger-http": patch
---

Add `@blokjs/inertia`, the Inertia v3 protocol adapter node: HTML shell with the
`<script type="application/json" data-page>` boot tag, the JSON page object on an
Inertia visit, and the version-conflict / external-location / fragment-redirect /
303 control responses. Registered in `HELPER_NODES` (as an optional peer, so a
project that serves no SPA does not pay for it), and the http trigger now
rewrites a `302` leaving a non-GET Inertia request to `303`.
