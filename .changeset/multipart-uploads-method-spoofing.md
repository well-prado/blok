---
"@blokjs/shared": minor
"@blokjs/trigger-webhook": patch
---

Multipart uploads (streamed, spooled, size-capped) and `_method` spoofing in
the HTTP request path (#1016).

`@blokjs/shared` gains the request-body builder every HTTP-speaking trigger now
parses through — `parseHttpRequest(request, opts)`. It dispatches on
content-type (json / urlencoded / multipart / text), enforces
`BLOK_MAX_UPLOAD_BYTES` (default 32 MiB) while the body streams so an over-cap
upload is refused before any workflow runs, and applies `_method` spoofing.

`multipart/form-data` is parsed straight off the stream instead of being
buffered: file parts arrive as Web `File` objects on `ctx.request.body` and
`ctx.request.files`, and a part bigger than `BLOK_UPLOAD_SPOOL_BYTES` (default
1 MiB) is written to a temp file and handed over as a disk-backed `File`
(`stream()` / `bytes()` / `text()`), deleted when the request finishes.

Bracket field names are expanded back into structure for multipart AND
urlencoded bodies — `user[name]` → `{ user: { name } }`, `tags[0]`/`tags[]` →
arrays, `docs[0]`/`docs[1]` → a `File[]` under `ctx.request.files.docs` — so a
form submit can satisfy a workflow's declared Zod schema. Nesting is capped at
5 segments, mixed usage keeps the flat key, and a name containing
`__proto__` / `constructor` / `prototype` is dropped.

Browsers cannot send multipart over PUT/PATCH/DELETE, so a `POST` whose body
carries `_method` ∈ `put|patch|delete` (case-insensitive) is routed as that
method: the workflow registered for the effective method runs, with ITS
middleware chain, and the field is stripped from the body. `ctx.request.method`
reports the effective method and `ctx.request.originalMethod` keeps `POST`.
Spoofing is POST-only and opt-out via `BLOK_METHOD_SPOOFING=0`.

The webhook trigger parses through the same builder with multipart AND spoofing
off — its verifiers sign the raw bytes, and a provider payload carrying
`"_method"` must not rewrite the method — so `ctx.request.method` /
`originalMethod` are populated there but always the wire method.
