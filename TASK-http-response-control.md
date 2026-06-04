# TASK (for the BLOK agent): workflow-controllable HTTP responses — headers, status, cookies, redirect, binary body

**Why:** The Tetrix-BLOK port is blocked on three HTTP features that a workflow/node currently cannot produce. All three are the **same root cause** in the `http` trigger's success path: it can only set `Content-Type`, hardcodes status `200`, and JSON-stringifies non-string bodies. `ResponseContext` has no `headers`/`status` fields. This blocks, in Tetrix:

- **Binary file download** — `GET /api/files/:sourceId`, `/share/:token` (serve a stored PDF/image with `Content-Disposition`).
- **OAuth connect redirects** — `GET /api/v1/oauth/:provider/authorize` (302 → provider) and `/callback` (302 → app).
- **Session-cookie login** — credentials / Google OAuth must issue an Auth.js `Set-Cookie`.

See `HTTP-BINARY-RESPONSE-GAPS.md` (this repo) for the full evidence + live verification.

## Your task
Design and implement workflow-controllable HTTP responses, then write a short design note + tests. **Plan it first** (post a short plan: API shape, touched files, back-comat, test plan), then implement.

## Evidence / current behavior (confirm before changing)
- `triggers/http/src/runner/HttpTrigger.ts` success branch (~lines 1103–1131): sets only `c.header("Content-Type", …)`; `if (typeof data === "string") return c.body(data, 200)` else `return c.json(data, 200)` — **status hardcoded 200**, non-string → `c.json` (corrupts `Buffer`/`Uint8Array` and resets `Content-Type`).
- `core/shared/src/types/ResponseContext.ts` — envelope is `{ data, error, success, contentType }` (no `headers`, no `status`).
- `core/runner/src/BlokResponse.ts` — `data: string | JsonLikeObject | JsonLikeObject[]` (no `Buffer`).
- `defineNode({ contentType })` → `RunnerSteps` sets `ctx.response.contentType` (last step wins) — this is the existing precedent to extend.
- Reading cookies already works: `ctx.request.cookies`. Only the response side is missing.

## Required capabilities (acceptance)
A node/workflow must be able to make the HTTP trigger emit:
1. **Custom status** — e.g. `201`, `302`, `400`, `206`.
2. **Arbitrary response headers** — incl. `Location`, `Content-Disposition`, and **`Set-Cookie`** (note: `Set-Cookie` can repeat — support an array of cookie strings, not just a flat string map).
3. **Raw binary body** — `Buffer` / `Uint8Array` / `ArrayBuffer` sent via `c.body(...)` with the declared `Content-Type` preserved (NOT routed through `c.json`).
4. Back-compat: existing JSON / string-200 responses unchanged when a workflow sets none of the above.

## Suggested design (open to your judgment)
- Extend `ResponseContext` (+ `BlokResponse`) with `status?: number`, `headers?: Record<string, string>`, `cookies?: string[]` (or fold cookies into a multi-value header), and widen `data` to allow `Buffer | Uint8Array | ArrayBuffer`.
- Plumb them like `contentType` (RunnerSteps/Blok → `ctx.response.*`), OR add a first-class `@blokjs/respond` helper node that takes `{ status?, headers?, cookies?, body, contentType? }` and is recognized by the trigger. A helper node is the cleanest authoring surface (a workflow's final step) and mirrors how other frameworks do it.
- In the HttpTrigger success branch: honor `ctx.response.status` (default 200); emit `ctx.response.headers` + each `Set-Cookie`; route `Buffer`/`Uint8Array`/`ArrayBuffer` to `c.body(bytes, status, headers)`; keep JSON/string paths for the default case.
- Verify Hono handles `c.body(Uint8Array/ArrayBuffer, status, {headers})` + repeated `Set-Cookie` (it does — confirm with a test).

## Tests
- `triggers/http/__tests__`: a workflow returning (a) `302` + `Location`, (b) `Set-Cookie` (single + multiple), (c) a `Buffer` body with `application/pdf` + `Content-Disposition` (assert raw bytes + headers, not JSON), (d) a custom `4xx`. Plus a back-compat test (plain JSON unchanged).
- Fix the repo's own broken `base64-pdf` example (`triggers/http/src/nodes/examples/base64-pdf` + `workflows/json/rentals-pdf.json`) so it actually returns a PDF.

## Then publish
Cut a release (the consumers — `@blokjs/helper`/`runner`/`shared` + `trigger-http`) so Tetrix-BLOK can bump and finish the file-proxy + OAuth-connect + session-login workflows. Note the version in your design note.

— Filed by the Tetrix-BLOK port (2026-06-04). Tetrix will resume `GET /api/files/:sourceId`, `/share/:token`, `Provider OAuth` redirects, and session-cookie login once this ships.
