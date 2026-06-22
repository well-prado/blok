# Bug 01 — TypeScript middleware workflows are never registered with `isMiddleware`

**Severity:** High · **Area:** HTTP trigger / workflow registration (`triggers/http`, `core/workflow-helper`, `core/runner`) · **Status:** Proposed fix (awaiting approval)

## TL;DR
A middleware workflow authored in TypeScript with `middleware: true` via the v2 `workflow()` helper is registered as an ordinary workflow — `isMiddleware` is never set — so `WorkflowRegistry.getMiddleware()` returns `undefined` and `runMiddlewareChain` throws, making **every request 500** the moment `setGlobalMiddleware([...])` or `BLOK_GLOBAL_MIDDLEWARE` references it. Middleware detection currently works only for JSON workflows scanned from disk. A second, compounding defect (Problem B): `workflow()` refuses to construct a trigger-less middleware and throws `requires a trigger`, forcing authors to add a dummy `trigger.http`, which then accidentally exposes the middleware as a real public route.

## Symptom
The global-middleware feature is documented and wired (`setGlobalMiddleware` / `BLOK_GLOBAL_MIDDLEWARE`), but pointing it at a TS-authored middleware makes the server 500 on every request. The throw originates in the middleware-chain resolver:

```
Error: Middleware "request-id" is not registered.
Define it as a workflow with `middleware: true` and place it in one of the
scanned WORKFLOWS_PATH/json directories.
```

(The hint itself is part of the problem — it only mentions the JSON path, never the TS `src/Workflows.ts` registration path.)

If the author works around Problem B by adding a dummy `trigger.http.path` so `workflow()` will construct, the 500 may disappear only to be replaced by a worse surprise: the middleware is now reachable as a public HTTP route.

## Reproduction
1. Author a middleware in TypeScript using the recommended v2 helper and export it from `src/Workflows.ts`:

```ts
// src/workflows/_mw/request-id.ts
import { workflow } from "@blokjs/helper";

export default workflow({
  name: "request-id",
  version: "1.0.0",
  middleware: true,          // dropped by the helper today
  steps: [ /* ... attach a correlation id ... */ ],
});
// → throws at construction: 'workflow("request-id") requires a trigger.'  (Problem B)
```

2. To get past construction, add a dummy trigger (the only available workaround):

```ts
  trigger: { http: { method: "ANY", path: "/__mw/request-id" } },
```

3. Register it globally:

```ts
WorkflowRegistry.getInstance().setGlobalMiddleware(["request-id"]);
// or: BLOK_GLOBAL_MIDDLEWARE=request-id
```

4. Send any request. Result: **500** — `getMiddleware("request-id")` returns `undefined` because the entry was registered without `isMiddleware: true`. Separately, `GET /__mw/request-id` is now a live, callable public route (Problem B leak).

The identical workflow expressed as JSON under `WORKFLOWS_PATH/json/` works, because only the JSON scan paths set the flag.

## Root cause
The flag dies in four independent places between authoring and lookup. Each one alone is sufficient to break the TS path; all four must be addressed.

1. **The helper silently drops the flag.** `workflow()`'s input type doesn't declare `middleware`, and its `_config` builder copies fields one-by-one and never copies `middleware`. The resulting builder object (`{ _blokV2, _config, toJson }`) carries no `middleware` anywhere — not on the root, not on `_config`. A `grep` for `middleware` over the entire helper file returns zero hits.
2. **The TS registration path never flags middleware.** The only way TS workflows enter the registry is `HttpTrigger`'s route-table loop, which calls `registry.register({ name, source, workflow })` with no `isMiddleware`.
3. **Middleware detection is JSON-only.** The two loops that *do* set `isMiddleware: true` both iterate the disk JSON scan (`scannedJson` / `scanned`) and never see TS workflows.
4. **Middleware workflows can't enter the route table anyway.** `extractHttpTrigger` returns `null` unless `trigger.http` exists, so a correctly trigger-less middleware is skipped by `buildRouteTable` — and `workflow()` won't even construct trigger-less (Problem B), so the dummy trigger an author adds turns the middleware into a real route.

The downstream is already correct: `WorkflowNormalizer` reads and preserves `wf.middleware === true`. The bug is entirely upstream — the helper drop plus registration gaps.

| Claim | Evidence (file:line) |
|---|---|
| Helper's `_config` builder never copies `middleware`; zero `middleware` hits in the file | `core/workflow-helper/src/components/workflowV2.ts:236-248` |
| `WorkflowOpts` input interface omits `middleware`, so the property is type-erased and dropped | `core/workflow-helper/src/components/workflowV2.ts:39-85` |
| Trigger guard throws unconditionally, ignoring `middleware` (Problem B) | `core/workflow-helper/src/components/workflowV2.ts:202-205` |
| Only TS-registration path registers without `isMiddleware` | `triggers/http/src/runner/HttpTrigger.ts:344-353` |
| Middleware-detection loop iterates `scannedJson` only | `triggers/http/src/runner/HttpTrigger.ts:362-377` |
| Fallback `scanAndRegisterMiddleware` scans JSON only | `triggers/http/src/runner/HttpTrigger.ts:406-461` |
| `extractHttpTrigger` requires `trigger.http`; trigger-less workflows skipped, dummy-trigger middleware becomes a real `RouteEntry` | `triggers/http/src/runner/WorkflowRouter.ts:258-270`, `:169-205` |
| `getMiddleware` returns `undefined` unless `entry.isMiddleware` | `core/runner/src/workflow/WorkflowRegistry.ts:220-224` |
| `runMiddlewareChain` throws (the 500) when the entry is missing; hint mentions only JSON dirs | `core/runner/src/TriggerBase.ts:231-241` |
| Normalizer already reads/preserves `wf.middleware === true` (so the fix is upstream-only) | `core/runner/src/workflow/WorkflowNormalizer.ts:201` |

## Why this is a framework design flaw
The framework's own guidance is explicit: **"Always prefer TypeScript workflows over JSON"** (CLAUDE.md), and process-global middleware is documented as a first-class v0.5.4 feature configured via `setGlobalMiddleware([...])` / `BLOK_GLOBAL_MIDDLEWARE`. Yet the only authoring path that actually produces a working middleware is JSON — the *non-recommended* one. The recommended `workflow()` helper has no awareness of `middleware` at all: it cannot even express the concept, and silently discards the flag if you try. This is not a typo; it is a missing seam across three packages (the helper has no `middleware` field, the TS registration path has no `isMiddleware` plumbing, and the route table has no middleware-exclusion rule). The feature contradicts the framework's stated authoring preference by being functional only in the path the docs steer authors away from. Problem B compounds it: the helper's blanket "requires a trigger" invariant is wrong for middleware (which `WorkflowV2Schema` already treats as trigger-optional), and the workaround it forces silently violates the "middleware are not exposed as routes" invariant.

## Proposed fix (primary)
Three coordinated changes thread the flag through the recommended path and enforce the unrouted invariant. They must land together: the helper change alone leaves the flag unread by HttpTrigger; the HttpTrigger change alone reads `undefined` because the helper already dropped the flag (which is exactly why the existing TASK write-up's "Fix A" is necessary-but-insufficient).

**(A) Make `workflow()` a first-class middleware author.** Add `middleware?: true` to `WorkflowOpts`, relax the trigger guard so `middleware: true` may omit a trigger (matching `WorkflowV2Schema`, which already makes the trigger optional for middleware), and carry the flag onto `_config` (and thus through `toJson()`).

**(B) Flag and un-route TS middleware in the HTTP layer.** Introduce one shared `readMiddlewareFlag(wf)` that returns `true` when `wf.middleware === true` **or** `wf._config?.middleware === true` (covering JSON, raw object literals, legacy `Workflow()`, and v2 `workflow()` builders). Use it in the route-table loop to pass a correct `isMiddleware`; exclude middleware workflows from `buildRouteTable` so they never become public Hono routes; and add a manual-array pass so a trigger-less TS middleware still lands in the registry as middleware even though it never appears in the route table.

**(C) Improve the diagnostic.** Extend the `runMiddlewareChain` error hint to mention the TS `src/Workflows.ts` registration path, not just JSON dirs.

```ts
// triggers/http/src/runner/WorkflowRouter.ts — one shared, exported reader
export function readMiddlewareFlag(wf: unknown): boolean {
  const w = wf as { middleware?: unknown; _config?: { middleware?: unknown } } | null;
  return w?.middleware === true || w?._config?.middleware === true;
}

// buildRouteTable — never route a middleware, even with a dummy trigger
if (readMiddlewareFlag(sw.workflow)) continue;   // scanned (JSON) loop
if (readMiddlewareFlag(mr.workflow)) continue;   // manual (TS) loop
```

```ts
// triggers/http/src/runner/HttpTrigger.ts — flag TS workflows + register trigger-less TS middleware
import { readMiddlewareFlag } from "./WorkflowRouter";

// route-table loop:
registry.register({ name: wfName, source: r.source, workflow: r.workflow,
                    isMiddleware: readMiddlewareFlag(r.workflow) });

// new manual-array pass (mirrors the existing scannedJson middleware loop, dedupe by name):
for (const mr of manual) {
  if (!readMiddlewareFlag(mr.workflow)) continue;
  if (registered.has(name)) continue;
  registry.register({ name, source: mr.source, workflow: mr.workflow, isMiddleware: true });
}
```

```ts
// core/workflow-helper/src/components/workflowV2.ts — accept, allow trigger-less, carry the flag
// WorkflowOpts:
middleware?: true;  // mirror WorkflowV2Schema.middleware
// trigger guard:
if (triggerKeys.length === 0 && opts.middleware !== true)
  throw new Error(`workflow("${opts.name}") requires a trigger.`);
// _config build:
...(opts.middleware === true ? { middleware: true as const } : {}),
```

**Files to change**
- [ ] `core/workflow-helper/src/components/workflowV2.ts` — add `middleware?: true` to `WorkflowOpts`; relax the trigger guard for middleware; spread `middleware` into `_config` so it survives into `toJson()`.
- [ ] `triggers/http/src/runner/WorkflowRouter.ts` — add + export `readMiddlewareFlag`; skip middleware workflows in both the scanned and manual `buildRouteTable` loops so they are never routed.
- [ ] `triggers/http/src/runner/HttpTrigger.ts` — import `readMiddlewareFlag`; pass a derived `isMiddleware` in the route-table registration; add a manual-array pass that registers trigger-less TS middleware with `isMiddleware: true` (dedupe by name).
- [ ] `core/runner/src/TriggerBase.ts` — extend the `runMiddlewareChain` error hint to mention the TS `src/Workflows.ts` path (diagnostic only).

## Alternatives considered
| Option | Trade-off | Verdict |
|---|---|---|
| TASK "Fix A" only: set `isMiddleware: (r.workflow)?.middleware === true` in the route-table loop, nothing else. | Minimal diff, but reads `undefined` for `workflow()`-authored middleware because the helper drops the flag before `r.workflow` ever sees it. Only fixes raw-object-literal / legacy `Workflow()` middleware, never the documented v2 path. Doesn't fix Problem B. | **Rejected** — necessary fragment, but ships a fix that still 500s for the exact case in the report. |
| Scan TS workflows from disk (`kind: "ts"` ScanRoot) so the existing JSON middleware loops also catch TS files. | `scanWorkflows` already supports `kind: "ts"`, so it would unify discovery. But it changes the TS discovery contract (today TS comes only from the static `Workflows.ts` map), risks double-registration/collisions, depends on unestablished file-layout conventions, and *still* imports the same builder object that dropped the flag. | **Rejected for this fix** — too broad, doesn't address the helper drop; worth a separate roadmap item. |
| Keep middleware in the route table but mark its `RouteEntry` non-routable (skip `registerExplicitRoutes`). | Smaller `WorkflowRouter` change, but leaks the middleware concept into the route table, needs a new `RouteEntry` flag, and risks middleware appearing in `/__blok/routing` diagnostics and specificity sorting. | **Viable but inferior** — excluding upstream in `buildRouteTable` keeps the route table semantically pure. |
| Fix only the helper (A); keep telling TS authors to register via `Workflows.ts`. | Even with `middleware` on `_config`, the route-table loop still never sets `isMiddleware` and the middleware loops never iterate the manual array — so TS middleware is still unflagged. | **Rejected** — the helper fix is a prerequisite, not a standalone fix. |

## Tests
- `core/workflow-helper/__tests__/unit/workflowV2.test.ts` — `workflow({ middleware: true })` with **no** trigger constructs without throwing, carries `middleware: true` on `_config`, and emits `"middleware":true` from `toJson()`; a non-middleware workflow with no trigger still throws `requires a trigger`.
- `core/workflow-helper/__tests__/unit/workflowV2.test.ts` — `workflow({ middleware: true, trigger: {...} })` (dummy trigger present) still carries `middleware: true` on `_config` (back-compat for authors who already added the workaround trigger).
- `triggers/http/__tests__/unit/WorkflowRouter.test.ts` — `buildRouteTable` excludes middleware workflows from the route table for both scanned (JSON) and manual (TS builder `{ _blokV2, _config: { middleware: true } }`) inputs, even when a dummy `trigger.http.path` is present; plus a direct `readMiddlewareFlag` unit test covering root, `_config`, and absent cases.
- `triggers/http/__tests__/unit/HttpTrigger.test.ts` — after `listen()`, a TS `workflow({ middleware: true })` exported from the mocked `../../src/Workflows` is registered with `isMiddleware: true` (assert `getMiddleware(name)` returns the entry) **and** is not present as a public route; extend the existing `{ default: {} }` mock with a middleware builder fixture and call `WorkflowRegistry.resetInstance()` in `beforeEach`.
- `core/runner/__tests__/unit/TriggerBase.middleware-merge.test.ts` — with a TS middleware registered (`isMiddleware: true`) and a chain set via `setGlobalMiddleware([name])`, `applyMiddlewareChain`/`runMiddlewareChain` resolves and runs without throwing; a negative case asserts the improved error text when the name is unregistered.
- `core/runner/__tests__/unit/workflow/WorkflowRegistry.test.ts` — regression: an entry registered with `isMiddleware` undefined is invisible to `getMiddleware` but visible to `get` (documents the asymmetry the fix relies on).

## Edge cases & backward compatibility
- **Middleware + real `trigger.http` route (workaround in the wild):** must register as middleware **and** be excluded from the route table — verify the dummy route disappears rather than shadowing a real endpoint.
- **JSON middleware (the only currently-working path):** must stay registered with `isMiddleware: true` and excluded from routing; the new `readMiddlewareFlag`/route-table exclusion must not double-register or drop them (the `scannedJson` loop still registers them; exclusion only prevents routing).
- **Name collision (TS middleware vs. JSON workflow of the same name):** `WorkflowRegistry.register` throws on same-name/different-source. The new manual-middleware pass must dedupe by name against `registered`, exactly as the existing loops do, to avoid a boot-time collision throw.
- **Legacy `Workflow().addTrigger(...)` with `middleware: true` on `_config`:** covered by `readMiddlewareFlag` checking `_config.middleware`; a legacy builder without that field is unaffected.
- **`workflow({ middleware: true })` with no steps:** `WorkflowV2Schema.steps` requires `min(1)`; confirm the empty-steps case still errors helpfully (a middleware still needs at least one step, e.g. a resolve/`@blokjs/throw` node).
- **Trigger-less middleware + file-based routing OFF:** `buildFileBasedRoutes` returns early and only `scanAndRegisterMiddleware` (JSON-only) runs, so a TS trigger-less middleware would not be registered. The manual-middleware pass must therefore run unconditionally in `listen()` (or be folded into `scanAndRegisterMiddleware` to also iterate the manual map) — see Open Questions.
- **`middleware: false` / non-`true` values:** `readMiddlewareFlag` and the helper must treat only the literal `true` as the marker (matches `z.literal(true)` and the normalizer's `=== true`).
- **Back-compat call-out:** excluding `middleware: true` workflows from the route table is a behavior change for anyone who intentionally (or via the workaround) exposed a middleware-with-dummy-trigger as a callable route — that route will stop responding. This is the desired correction, but belongs in the changelog. Blast radius is small because the feature already 500s for TS. Adding `middleware?: true` and relaxing the trigger guard are purely additive (existing `workflow()` calls all pass a trigger and are unaffected). Carrying `middleware` into `toJson()` adds `"middleware":true` to serialized output — the normalizer already handles it, but any `toJson()` snapshot tests would need updating.

## Effort & risk
**Medium — roughly 0.5–1 day.** Three source files plus a small shared `readMiddlewareFlag` helper, all localized; most of the time goes to the cross-cutting tests (helper construction, router exclusion, HttpTrigger registration with a `Workflows` mock, and the `runMiddlewareChain` resolution path) and verifying the file-routing-OFF path. No schema migrations, no runtime/persistence changes. Blast radius is contained to workflow registration and HTTP route-table construction; the one behavioral change with external visibility is that middleware-with-dummy-trigger stops being routable (intended).

## Open questions for reviewer
- **File-based routing OFF:** should trigger-less TS middleware be registered when `BLOK_FILE_BASED_ROUTING` is off? This requires the manual-middleware pass to run unconditionally in `listen()` (not only inside `buildFileBasedRoutes`). Confirm the intended behavior for legacy routing mode.
- **Where does `readMiddlewareFlag` live?** Recommendation is to export it from `WorkflowRouter` (where the route-table exclusion needs it) and import it in `HttpTrigger`. Confirm there's no circular-import concern, or prefer a neutral shared util.
- **Helper scope:** should `workflow()` also accept the workflow-level `middleware: string[]` chain form, or stay restricted to the `middleware?: true` marker (directing chain authoring to the typed trigger-level surface)? The bug only concerns the boolean marker; broadening is optional.
- **Deprecation window:** do any existing projects rely on a middleware-with-dummy-trigger being routable? If so, a warn-then-exclude window may be safer than immediate exclusion — though given the feature 500s for TS today, immediate exclusion is likely acceptable.