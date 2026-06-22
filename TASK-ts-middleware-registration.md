# TASK — TypeScript middleware workflows are never registered as middleware

> **Found:** 2026-06-18, building a global Tenant Resolver middleware in TypeScript on a `blokctl create project` backend (Blok Sites P2).
> **TL;DR:** A `middleware: true` workflow authored in **TypeScript** (registered via `src/Workflows.ts`) is registered as a *regular* workflow, never with `isMiddleware: true`. So `setGlobalMiddleware([...])` / `BLOK_GLOBAL_MIDDLEWARE` can't find it and **every request 500s**. Middleware detection only works for **JSON** workflows. This breaks the documented global-middleware feature for the *recommended* authoring path (TS).

---

## Symptom

A TS middleware workflow + a global middleware registration:

```ts
// src/workflows/middleware/tenant-resolver.ts
export default workflow({
  name: "tenant-resolver",
  version: "1.0.0",
  middleware: true,
  trigger: { http: { method: "POST", path: "/__mw/tenant-resolver" } }, // see Problem B
  steps: [{ id: "resolve", use: "tenant-resolve", inputs: {} }],
});
// src/Workflows.ts → { "tenant-resolver": TenantResolver }
// .env.local → BLOK_GLOBAL_MIDDLEWARE=tenant-resolver
```

Boot logs look correct:
```
[blok] global middleware registered from BLOK_GLOBAL_MIDDLEWARE env: tenant-resolver
[blok] process-global middleware chain (applies to every workflow): tenant-resolver
```

…but **every** request then 500s:
```
pages.get: [blok] middleware "tenant-resolver" not found in WorkflowRegistry.
Available middleware: (none registered). Make sure the middleware workflow has
`"middleware": true` set at the workflow root and is in a scanned WORKFLOWS_PATH directory.
   at runMiddlewareChain (core/runner/dist/TriggerBase.js)
```

The workflow IS registered (it's callable, routable) — just not flagged `isMiddleware`.

## Root cause

Two registration paths in `triggers/http/src/runner/HttpTrigger.ts`:

1. **The route-table loop** (`buildFileBasedRoutes`, ~`:344-353`) registers EVERY workflow in the route table — which includes manual TS workflows from `Workflows.ts` — but **never sets `isMiddleware`**:
   ```ts
   for (const r of table) {
     ...
     registry.register({ name: wfName, source: r.source, workflow: r.workflow });
     //                                                    ^ no isMiddleware
   }
   ```
2. **The middleware-detection loop** (`~:362-377`) DOES set `isMiddleware: true`, but only iterates **`scannedJson`** — the `WORKFLOWS_PATH/json/` scan — so it never sees TS workflows:
   ```ts
   for (const sw of scannedJson) {                 // ← JSON only
     const wfObj = sw.workflow as { middleware?: unknown };
     if (!wfObj || wfObj.middleware !== true) continue;
     registry.register({ ..., isMiddleware: true });
   }
   ```
   The catch-all path (`ensureWorkflowsRegistered`, `~:427`) has the same JSON-only limitation (`for (const sw of scanned)`).

So a TS middleware workflow is caught by path 1 (registered, `isMiddleware` falsy) and missed by path 2. `runMiddlewareChain` (`core/runner/src/TriggerBase.ts:231`) calls `registry.getMiddleware(name)`, which returns `undefined` unless `isMiddleware === true` (`WorkflowRegistry.ts:222`) → throws → 500.

### Problem B (related): `workflow()` requires a trigger even for middleware

`workflow()` throws `requires a trigger` (`core/workflow-helper/src/components/workflowV2.ts:85`) regardless of `middleware: true`. So a TS middleware must declare a dummy `trigger.http.path` just to construct — which then (because of Problem A's path-1 registration) also **exposes it as a real route** (`POST /__mw/tenant-resolver` showed up in the route table). Middleware should be trigger-less and unrouted.

## Why this is wrong

- The project's own `CLAUDE.md` and `BLOK-AUTHORING-RULES.md` recommend **TypeScript** workflows and the `setGlobalMiddleware` / `BLOK_GLOBAL_MIDDLEWARE` feature. Combining the two — a TS middleware — is impossible: it 500s every request. The only working middleware are **JSON** workflows, which contradicts the TS-first guidance.
- The failure is **total and global** (every request), and the error message points the author at JSON (`"in a scanned WORKFLOWS_PATH directory"`) with no hint that TS registration is the actual gap.

## Severity

**High.** A documented feature (global middleware) is non-functional for the recommended authoring language, and the failure mode is a 500 on every request once `BLOK_GLOBAL_MIDDLEWARE` is set.

## Correct fix

**(A) Set `isMiddleware` in the route-table registration** so the manual TS path flags middleware (the normalized `r.workflow` carries `middleware` at the root, same as JSON):
```ts
for (const r of table) {
  ...
  registry.register({
    name: wfName,
    source: r.source,
    workflow: r.workflow,
    isMiddleware: (r.workflow as { middleware?: unknown })?.middleware === true, // ← add
  });
}
```
This alone makes `BLOK_GLOBAL_MIDDLEWARE` work for TS middleware.

**(B) Don't require a trigger for `middleware: true` workflows** (`workflowV2.ts:85`) — middleware are invoked by name, not routed. And/or **exclude `middleware: true` workflows from the route table** so they aren't exposed as endpoints. Either removes the dummy-path hack and the accidental `/__mw/...` route.

**(C) Improve the error hint** in `runMiddlewareChain` to mention the TS `Workflows.ts` registration path, not only `WORKFLOWS_PATH/json/`.

## Workaround (used in Blok Sites)

To stay TypeScript-only, the Tenant Resolver was moved out of global middleware and into the connector layer: a `getTenantCreds(ctx)` helper that reads `X-Tenant-Id` + the Tenant Vault, invoked by every connector node. Same isolation + gate, no middleware. See `blok-sites-spike/P2-FINDINGS.md`.

## Evidence

| Claim | Source |
|---|---|
| Route-table loop registers TS workflows without `isMiddleware` | `triggers/http/src/runner/HttpTrigger.ts:344-353` |
| Middleware detection iterates `scannedJson` only | `triggers/http/src/runner/HttpTrigger.ts:362-377` (and `:427` catch-all) |
| `getMiddleware` returns undefined unless `isMiddleware` | `core/runner/src/workflow/WorkflowRegistry.ts:222` |
| `runMiddlewareChain` throws on missing middleware | `core/runner/src/TriggerBase.ts:231-241` |
| `workflow()` requires a trigger even for middleware | `core/workflow-helper/src/components/workflowV2.ts:85` |
