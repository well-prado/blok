# TASK (for the BLOK agent): `forEach` output is raw `ResponseContext` envelopes, not unwrapped data — inconsistent with every other `ctx.state.<id>` read

**Why:** A `forEach` step's aggregated output (`ctx.state.<loopId>`) is an array of raw **`ResponseContext` envelopes** (`{ data, error, success, contentType, steps }`), whereas **every other** step's `ctx.state.<id>` is the **unwrapped value** the node returned. So per-iteration results live one level deeper (`element.data`) than the documented contract, and the doc comment in `ForEachNode.ts` actively claims the opposite. This silently breaks the natural "loop, then aggregate the results" pattern — filters/maps over `ctx.state.<loopId>` key on the wrong fields and return garbage with no error.

This bit the Tetrix-BLOK port: a bulk workflow that did `ctx.state.del.filter(r => r.success).map(r => r.id)` returned `[null, null, null]` — because `r.success` was the **envelope's** `success` (always `true`) and `r.id` was `undefined` (the real id was at `r.data.id`). Took a live diagnostic to find; the fix on the workflow side is to reach into `.data`, but the inconsistency itself should be fixed in BLOK.

## Your task
Make `forEach`'s aggregated output consistent with how all other step state is read (unwrapped `.data`), OR — if the envelope is intentional — fix the misleading doc + give authors a clean accessor. **Plan it first** (post a short plan: chosen option, back-compat impact, touched files, test plan), then implement.

## Evidence / current behavior (confirm before changing)
- `core/runner/src/ForEachNode.ts`:
  - `runIteration` returns `childCtx.response` (the whole `ResponseContext`) — sequential path ~**line 170**, parallel path ~**line 364**. These land in `results[]`, and `response.data = results` (~line 79) becomes `ctx.state.<loopId>`.
  - The comment at ~**lines 166–170** says: *"After Runner.runSteps, `childCtx.response` is set to the last step's resolved **data** (RunnerSteps … `ctx.response = model.data`). So `childCtx.response` IS the iteration's result."* — but `childCtx.response` is the **envelope object**, and the resolved data is at `childCtx.response.data`. Doc says data; code returns the envelope.
  - Null-sentinel logic (~**lines 144–146**): `results[k] === null` means "ran, returned undefined" — must be preserved by any fix.
- `core/shared/src/types/ResponseContext.ts` — `{ data: unknown; error: BlueprintError | null; success?: boolean; contentType?: string }` (the envelope being leaked).
- Contrast: a normal step `{ id: "src", … }` is read as `ctx.state.src` = the returned value (unwrapped); `forEach` is the only primitive that exposes the raw envelope array.

### Minimal repro (drop-in workflow)
```ts
import { forEach, workflow } from "@blokjs/helper";
export default workflow({
  name: "Diag For Each", version: "1.0.0",
  trigger: { http: { method: "GET", path: "/diag/foreach" } },
  steps: [
    forEach({ id: "loop", in: [10, 20, 30], as: "n", do: [
      { id: "step", use: "@blokjs/expr", inputs: { expression: "({ n: ctx.state.n, doubled: (ctx.state.n||0)*2 })" } },
    ]}),
    { id: "respond", use: "@blokjs/expr", inputs: { expression: "ctx.state.loop" } },
  ],
});
```
**Actual** `ctx.state.loop`:
```json
[ { "steps": [], "data": { "n": 10, "doubled": 20 }, "success": true, "error": null, "contentType": "" }, … ]
```
**Expected** (consistent with every other state read): `[ { "n": 10, "doubled": 20 }, … ]`.
(Confirms the loop var `ctx.state.n` + index `ctx.state.nIndex` DO work — only the aggregated output shape is wrong.)

## Required outcome (acceptance)
1. `ctx.state.<loopId>` after a `forEach` is an array of the **unwrapped iteration values** (each iteration's last-step resolved data) — matching `ctx.state.<normalStepId>`.
2. The "ran but returned undefined → `null`" sentinel is preserved (don't turn undefined into `{}`).
3. Errored iterations still propagate to the caller exactly as today (no behavior change to error handling, sequential or parallel, incl. the v0.6 wait-inside-`forEach` cursor paths).
4. Doc comment in `ForEachNode.ts` updated to match reality.

## Suggested design (open to your judgment)
- Simplest: change both return sites to `return childCtx.response?.data ?? null` (preserving the null sentinel) so `results[]` holds unwrapped values. Verify nothing downstream relies on the envelope shape (grep for readers of `forEach` results / `response.data` being treated as envelopes; check the cursor/resume `completedResults` round-trip still serializes fine).
- If per-iteration `success`/`error` introspection is a deliberate feature, keep the envelope but (a) fix the doc comment, and (b) add a documented accessor / `$`-helper (e.g. `$.state.loop.values`) so workflow authors don't hand-reach into `.data`. Note that since errors propagate and abort the loop today, the envelope's `error` is always `null` in the surviving array — so option 1 loses nothing in practice.

## Tests
- `core/runner/__tests__` (or wherever `ForEachNode` is tested): a `forEach` over `[1,2,3]` whose body returns `{ v: n*2 }` → assert `ctx.state.loop` deep-equals `[{v:2},{v:4},{v:6}]` (NOT envelope-wrapped). Cover both sequential and parallel (`mode: "parallel"`) modes.
- An iteration returning `undefined` → that slot is `null` (sentinel preserved).
- A `forEach` whose body is a `tryCatch` whose `catch` returns `{ ok:false }` → the slot is `{ ok:false }` (unwrapped), proving the per-item resilience pattern aggregates cleanly.
- Back-compat: confirm the wait-inside-`forEach` resume path (`completedResults`) still works.

## Then publish
Cut a release of the affected package(s) (`@blokjs/runner`, and `@blokjs/helper` if an accessor is added) so Tetrix-BLOK can bump and simplify its loop-aggregation workflows (today they use a "categorize up front, `forEach` only executes" workaround to avoid the envelope). Note the version in your design note.

— Filed by the Tetrix-BLOK port (2026-06-04). Low severity (workaround exists: read `el.data`), but it's a real surprise-factory: it fails silently with no error. Tetrix `deleteFiles` already ships the workaround; other bulk endpoints will simplify once this lands.
