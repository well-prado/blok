# HTTP trigger — binary / custom response gaps

**Status:** findings for the BLOK team (from the Tetrix-BLOK port, 2026-06-04). UNCOMMITTED-intent doc; mirrors `SSE-STREAMING-RUNTIME-GAPS.md`.

## TL;DR

The `http` trigger can return JSON, or a **string** body with a custom `Content-Type` (status 200). It **cannot**:

1. Return a **raw binary body** (`Buffer` / `Uint8Array` / `ArrayBuffer`) — non-string results go through `c.json(...)`, which JSON-stringifies the bytes (`{"type":"Buffer","data":[...]}`) **and** overrides the `Content-Type` back to `application/json`.
2. Set **`Content-Disposition`** (or any header other than `Content-Type`).
3. Set a **custom success status** (206/201/…) — the success path hardcodes `200`.

This blocks true file-download endpoints (serving a stored PDF/image, `Content-Disposition: attachment; filename=…`, range requests). The repo's own `base64-pdf` example (`triggers/http/src/nodes/examples/base64-pdf` + `workflows/json/rentals-pdf.json`) is **broken** against the current trigger for exactly this reason (verified: its `Buffer` return is routed through `c.json`).

The **request** side is fine: `multipart/form-data` is parsed (`HttpTrigger.parseBody`) and uploaded files arrive as Web `File` on `ctx.req.body.<field>` for in-process `module` nodes. Only the **response** side is the gap.

## Evidence

`triggers/http/src/runner/HttpTrigger.ts` success branch (~:1103–1131):

```ts
if (ctx.response.contentType === undefined || ctx.response.contentType === "")
    ctx.response.contentType = "application/json";
const data = hasWrapper ? ctx.response.data : ctx.response;
const contentType = hasWrapper ? ctx.response.contentType : "application/json";
c.header("Content-Type", contentType);          // only Content-Type is ever set
if (typeof data === "string") return c.body(data, 200);   // string → raw body, status hardcoded 200
return c.json(data as object, 200);                       // non-string → JSON (corrupts bytes, resets CT)
```

- `core/shared/src/types/ResponseContext.ts` — envelope is `{ data, error, success, contentType }`: **no `headers`, no `status`.**
- `core/runner/src/BlokResponse.ts` — `data: string | JsonLikeObject | JsonLikeObject[]` (no `Buffer`).
- `contentType` plumbing works: `defineNode({ contentType })` → `RunnerSteps` `ctx.response.contentType = step.contentType` (last step wins).

## Proposed fix

1. Extend `ResponseContext` (+ `BlokResponse`) with `headers?: Record<string,string>` and `status?: number`, and widen `data` to allow `Buffer | Uint8Array | ArrayBuffer`.
2. Plumb a way for a node to set them (e.g. a `@blokjs/respond`-style node, or honor a reserved result shape, or `ctx.response.headers`/`.status`).
3. In the HttpTrigger success branch: route `Buffer`/`Uint8Array`/`ArrayBuffer` to `c.body(bytes, status, headers)` (Hono handles these correctly — verified), emit `ctx.response.headers`, and honor `ctx.response.status` instead of the hardcoded `200`.

## Same root gap blocks auth (cookies + redirects)

The same "success path can only set `Content-Type`, status hardcoded 200, `ResponseContext` has no `headers`/`status`" limitation also blocks **auth**:

- **`Set-Cookie`** — a workflow cannot issue a session cookie. (Reading cookies works: `ctx.request.cookies`.) → blocks credentials/session login.
- **302 redirect + `Location`** — a workflow cannot redirect. The `Location` header at `HttpTrigger.ts:1156` is trigger-internal (the deferred-dispatch → Studio redirect), not workflow-controllable; success status is hardcoded 200. → blocks the OAuth **authorize redirect** and the **callback redirect back to the app**, and any Google-OAuth login redirect.

So the same `ResponseContext.headers` + `ResponseContext.status` extension proposed above also unblocks: `Set-Cookie` (session login), `Location` + 302 (OAuth connect/callback). Until then, only JSON/string-200 responses are possible — the OAuth-connect flow and cookie-session login can't be built as CE has them.

## What Tetrix did meanwhile

- `POST /api/upload` (multipart → MinIO) — **shipped** (request side works; an in-process `@tetrix/upload-file` module node reads `ctx.req.body.file.arrayBuffer()`).
- `POST /api/export` — ships as a JSON `{ bytesB64, contentType, filename }` envelope (the frontend base64-decodes) — works within the gap.
- `GET /api/files/:sourceId` + `GET /api/files/share/:token` (binary file-proxy with `Content-Disposition`) — **deferred** pending this fix. Text files could be served as a string body; binary (PDF/image) cannot.
