# S3 — Expression & Authoring Ergonomics

## Status — Draft for review · depends on: — (S5 depends on this) · phase: 1 (independent, ships fast)

## 1. Problem & motivation

Blok's expression system is the connective tissue of every workflow: it threads data from the trigger payload through each step's outputs. It already beats n8n's raw `{{ }}` strings on one axis — the typed `$` proxy gives authors IDE autocomplete and typo-safety at *definition* time. Three concrete problems undercut that lead and block the larger vision (visual canvas, AI authoring, marketplace):

1. **The branch `when` footgun is a live silent-500 bug, not an ergonomics wish.** A bare `$.req.method` passed to `branch({ when })` compiles to the string `"js/ctx.req.method"`. The if-else node then evaluates it *literally* as JavaScript with no `js/` strip — `js` is an undefined identifier, so `Function(..., "return (js/ctx.req.method)")` throws `ReferenceError: js is not defined` inside the node, surfacing as a garbled runtime error (or, in the multi-condition fall-through path, mis-routing). TypeScript can't catch it (the proxy is typed `unknown`); `WorkflowTestRunner` doesn't either. This is exactly the class of bug the S5 connect-picker will *mass-produce* — it generates conditions programmatically, so a footgun that bites one careful human author will bite every AI- and canvas-generated condition. Per the standing "framework bug → fix at the root" rule, this ships first.

2. **Multiple JS-evaluation sites have diverged.** `Mapper` (step inputs), the if-else node, and `LoopNode.evaluateCondition` each compile `Function("ctx", ...)` themselves, with *different scope and different `js/` handling*. The Mapper strips `js/` and binds `ctx, data, func, vars`; the if-else node strips nothing and binds `ctx, data, func, vars` but feeds `data = ctx.response.data`; `LoopNode` strips nothing and binds only `ctx, data, vars` (**no `func`**), with `data = ctx.response?.data ?? ctx.request?.body`. Divergence *is* the bug: the same `$.req.method` works in step `inputs` and breaks in `branch.when`, and a `js/func.x` that resolves in inputs would `ReferenceError` in a loop condition.

3. **No compiled-function cache.** Every `replaceString()` and every condition eval calls `Function(...)` fresh. A `forEach`/`loop` over 1000 items recompiles the same expression string 1000×. It works, but it's wasted CPU on the hot data-pipeline path the vision wants Blok to win.

Against the vision — "an AI assembles a complex backend in a day" — an expression surface that silently miscompiles when an AI writes the obvious thing (`when: $.req.method`) is a credibility hole. The fix is cheap, reuses an in-tree pattern, and is high-leverage. The research consensus (CEL/JSONata) is the over-built path to resist for now (§4 Option D, §10).

## 2. Current state in Blok

**Two-phase resolution.** Definition-time: the `$` proxy (`core/workflow-helper/src/proxy/$.ts:83-114`) records property access as a path and stores it on the `JS_EXPR_TAG` symbol; `unwrapProxies` (`$.ts:143-177`) compiles a proxy to a `"js/ctx.<path>"` string at workflow-build time. Runtime: `Mapper` (`core/shared/src/utils/Mapper.ts`) resolves two syntaxes inside step `inputs`:
- `${path}` — lodash `_.get` first, JS-eval fallback, **always string-coerced** (`Mapper.ts:299-316`, `resolveTemplateExpression` at `:327`).
- `js/...` — full-string eval, type-preserving; `js/` stripped via `slice(3)` (`jsMapper` at `Mapper.ts:360-380`).

Resolution order inside one string: **`${}` runs first, then `js/`** (`replaceString` at `Mapper.ts:299-320`). Both ultimately hit `runJs` (`Mapper.ts:408-419`): `Function("ctx","data","func","vars", '"use strict";return (' + str + ')')`. `BLOK_MAPPER_MODE` (default `strict`) governs failure (`Mapper.ts:84-96`, `handleResolutionError` at `:388`).

> Note: `core/runner/src/types/Mapper.ts` is an unrelated 7-line *type* alias, not a second evaluator. The real divergence is the three hand-rolled `Function(...)` call sites below.

**The divergent evaluators (root of problems 1 & 2):**

| Site | File:line | Strips `js/`? | Runs `${}`? | Scope bound | `data` source | Failure mode |
|---|---|---|---|---|---|---|
| Step `inputs` | `Mapper.ts:299-320`, `408` | ✅ | ✅ | `ctx,data,func,vars` | step-supplied | strict throw |
| Branch `when` (if-else node) | `nodes/control-flow/if-else@1.0.0/index.ts:17-25,74` | ❌ | ❌ | `ctx,data,func,vars` | `ctx.response.data` | throws inside node → garbled |
| Loop `while` | `core/runner/src/LoopNode.ts:221-226` | ❌ | ❌ | `ctx,data,vars` (**no `func`**) | `ctx.response?.data ?? ctx.request?.body` | throws |
| `idempotencyKey`/`concurrencyKey` | `core/runner/src/idempotency/resolveIdempotencyKey.ts:23-36` | ✅ | ❌ | `ctx` only | n/a | fail-open (returns `null`) |
| Switch `case.when` | `core/runner/src/SwitchNode.ts:60-65` | n/a (literal `===`) | n/a | n/a | n/a | — |

The branch flow: `branch()` (`branch.ts:55-90`) → `unwrapProxies(opts.when)` → a bare `$` proxy yields `"js/ctx.req.method"`. `WorkflowNormalizer` (`WorkflowNormalizer.ts:450-511`) takes that string verbatim via `pickString(branch.when)` into `conditions[0].condition`. The if-else node (`index.ts:74`) calls its local `runJs(condition.condition, …)` with **no `js/` strip** → `ReferenceError`.

**Critical grounding fact #1 — the fix is mechanically tiny.** `ctx.req`/`ctx.prev`/`ctx.vars` are real runtime aliases on the context (`Context.ts:48-98`; set in `TriggerBase` + `createChildContext.ts`). So `ctx.req.method` resolves fine at runtime — **the only thing wrong with the bare-`$` branch path is the un-stripped `js/` prefix.**

**Critical grounding fact #2 — the fix already exists in-tree.** `SubworkflowNode.ts:347-356` (G3 polymorphic dispatch) already does *exactly what this spec proposes for conditions*: it normalizes `$.<path>` → `js/ctx.<path>`, then calls `mapper.replaceString(expr, ctx, {})` and validates the result. We are reusing a shipped pattern (ladder rung 2: already in this codebase), not inventing `resolveCondition`. That is the single most important fact for sizing this work.

**Partial mitigations already shipped:** `eq/ne/gt/gte/lt/lte` (`core/workflow-helper/src/components/eq.ts:31-88`) read the proxy's `JS_EXPR_TAG` directly, skip the `js/` prefix, AND canonicalize aliases (`ctx.req`→`ctx.request`, `:83-88`). The `branch()`/`eq()` doc-comments carry long footgun warnings (`branch.ts:11-13`, `eq.ts:6-13`). These are *workarounds documented around a bug*, not a fix — the bare-`$` path still throws. Note `eq()`'s alias-canonicalization (`:83-88`) is now redundant defensive work: the runtime aliases exist, so once conditions route through the Mapper, `ctx.req` resolves directly. We keep `eq()` (it's a useful comparison shorthand) but the canonicalization step can be dropped in a later cleanup (out of scope here — it harms nothing).

**No compiled-function cache** anywhere (`grep` for LRU/fnCache: zero hits — verified).

## 3. Goals & non-goals

**Goals**
- **G1.** Make `branch({ when: $.req.method === "POST" })` and `loop({ while: $.state.more })` — the obvious things an AI/human writes — *work*, not silently throw.
- **G2.** Route every condition site (if-else, loop) through the **same** `Mapper.replaceString` path step inputs already use, so `js/`-strip, `${}`, scope (`ctx/data/func/vars`), and `BLOK_MAPPER_MODE` behave identically everywhere.
- **G3.** Cache compiled `Function`s at the single Mapper chokepoint (real win on `forEach`/`loop`).
- **G4.** Publish the canonical, minimal spec of the expression surface: `$` vs `js/` vs `${}`, scope, precedence, type fidelity (fills the doc gap; cited by MCP/Skills per D7/S11).
- **G5.** Record — on the record — whether/when a second sandboxable expression tier (CEL/JSONata) is warranted, with the explicit trigger condition.

**Non-goals**
- Replacing `$`/`js/` with CEL/JSONata now (deferred; §4 Option D, §10).
- The Studio connect-picker / live-preview (that's S5 — S3 makes the conditions S5 emits *correct*).
- Changing the `$` proxy's authored surface, or breaking any existing `js/`/`${}`/`eq()` workflow.
- Multi-runtime expression eval. Expressions are TS-host-only; nodes are multi-runtime (D8), expressions are not. This is deliberate and stated so S9/S11 don't assume otherwise.
- Touching `SwitchNode` (literal `===` match; `on` is already mapper-resolved as a step input — nothing to fix).

## 4. Options & alternatives

### Option A — Document harder, keep `eq()` as the blessed path (status quo+)
Tell authors "never pass a bare `$` to `when`; always use `eq()`." Today's state.
- **Pros:** zero risk.
- **Cons:** the footgun stays live for anyone who doesn't read the comment — i.e. every AI and every canvas-generated condition (S5). Violates the standing "framework bug → fix it" rule. `eq()` can't express `x?.y && z > 3`; the moment an author hand-writes a `when` with a `$` in it they're back in the trap. **Rejected** — leaves a known silent-fail the visual layer will amplify.

### Option B — Route `branch.when` / `loop.while` through the Mapper (RECOMMENDED)
Make the if-else node and `LoopNode` resolve their condition through the **existing** `Mapper.replaceString`, exactly as `SubworkflowNode.ts:356` already does for polymorphic names.
- **How:** in each node, replace the local `runJs(...)` with the `SubworkflowNode` pattern — normalize a leading `$.`/`$` to `js/ctx.…`, then `mapper.replaceString(condition, ctx, dataForCtx)`. The `js/` strip, `${}` pass, scope, and `BLOK_MAPPER_MODE` all come for free because it's the same code path.
- **Pros:** kills the footgun at the root (one shared resolver, all condition callers — the ponytail bug-fix rule). One mental model. The cache (G3) lands once, inside `Mapper.runJs`. **Reuses a shipped in-tree pattern** — net *deletion* of two hand-rolled `runJs` blocks. Backward-compatible: a hand-written raw `ctx.request.method === "POST"` string has no `js/` prefix → passes straight through eval unchanged; `eq()` output unchanged; defensively-written `js/...` conditions now resolve *correctly* instead of throwing.
- **Cons:** condition eval inherits strict-mode throw semantics — a genuinely *throwing* `when` now fails the step with a clean `MapperResolutionError` instead of crashing garbled inside the node. That's *more* correct, but it's a visible behaviour change (see §8). A `when` that merely resolves to `undefined`/falsy still routes to `else` in every mode — only *throwing* expressions change.
- **Changes:** delete the local `runJs` in `if-else/index.ts:17-25` and the bespoke `Function(...)` in `LoopNode.ts:221-226`; both call the shared path. `resolveIdempotencyKey` keeps its fail-open wrapper but compiles through the same cached chokepoint. This is the D6 consolidation applied at the expression layer.

### Option C — Statically forbid bare `$` in `when` at definition time
Make `branch()`/`loop()` *warn at build time* if `when` is a bare single-path `$` proxy with no operator.
- **Pros:** fail-fast hint at author time, before deploy; cheap.
- **Cons:** *only* catches the bare-single-path case. `when: $.state.x > 3` can't be detected — the proxy can't intercept `>`, so the comparison compiles to garbage anyway and this check never sees an operator-free string. So C alone closes nothing; it's a nudge toward `eq()`, not a fix. **Useful as a warn alongside B; useless instead of B.** Demoted to a `console.warn` only (the draft's "throw" is too aggressive given B makes the bare path genuinely work as a truthy check — a hard throw would reject the legitimate `when: $.state.flag` "if truthy" case).

### Option D — Adopt CEL or JSONata as a sandboxed predicate tier
Introduce a second expression language for conditions (CEL — non-Turing-complete, type-checked, sandboxable).
- **Pros:** sandboxable (matters *if* the marketplace runs untrusted downloaded expressions); statically type-checkable; AI-verifiable.
- **Cons:** a whole second language to learn, document, and tool; a new dependency; AST-interpreted (JSONata is slow on big data); breaks every existing `js/`/`eq()` condition unless gated behind a schema version. Solves a problem Blok *doesn't have yet* — there is no untrusted-inline-expression execution path today (the marketplace ships nodes-as-packages and workflows-as-JSON authored by the *installer*, per S6/S12, not third-party inline expressions). Classic YAGNI. **Rejected for now**; revisit per the explicit trigger in §10.

## 5. Recommendation & rationale

**Ship B. Add C as a warn-only nudge. Defer D.**

- **B is the root-cause fix.** It makes `branch`/`loop` conditions resolve through the *same* shipped Mapper path that step inputs and polymorphic sub-workflow names already use (`SubworkflowNode.ts:356`). Grounding fact #2 means this is reuse, not new architecture — the diff *removes* hand-rolled evaluators. Grounding fact #1 means the bare-`$` case resolves the instant the prefix is stripped, because `ctx.req`/`ctx.prev`/`ctx.vars` already exist as live aliases.
- **C is a cheap warn** for the one case B makes "work" but probably-not-as-intended: a bare single path (`when: $.req.method`) is truthy iff the string is non-empty, which is rarely what the author meant. A build-time `console.warn` nudges them to `eq()`/a comparison. Not a throw — `when: $.state.flag` ("if truthy") is legitimate.
- **D is deferred on the ponytail ladder (rung 1: does this need to exist?).** No untrusted-expression execution exists today. The `$` proxy already delivers the type-safety CEL is praised for, at author time, for free. Two languages is exactly the "don't ship two speculatively" trap the dossier (D5) and research brief both flag.

**D1–D8 consistency.** D5 prescribes precisely this: keep typed `$` as the power tier, fix the `when` footgun *via the Mapper*, cache compiled Functions, defer CEL. D6 (one shared contract, kill divergence) is honoured at the expression layer by collapsing the condition evaluators onto the Mapper. D7 (one kernel) — the resolver lives in `core/shared`'s `Mapper`, consumed identically by runner, control-flow nodes, sub-workflow dispatch, and any future MCP dry-run tool. **No contradiction with S1/S2:** S3 doesn't touch the IR shape or `use:` identity; it only changes *how a `when` string is evaluated*, and `when` is already a plain string in the IR.

**Ponytail lens.** Net **deletion** of two hand-rolled `Function(...)` blocks; ~30–40 lines changed; a ~10-line cache inside `Mapper.runJs`; no new dependency, no new language, no new file except the doc page. The biggest win (G1) is reusing a `slice(3)` + `replaceString` that already ships three files over.

## 6. How it improves Blok

- **AI authoring stops silently miscompiling.** An LLM writing `when: $.req.method === "POST"` or `while: $.state.hasMore` gets the obvious correct behaviour. Load-bearing for "AI assembles a backend in a day."
- **The S5 connect-picker generates conditions safely** — every `$.state.<id>`-based condition resolves through the same path as `inputs`, no special-casing in the picker.
- **One mental model for authors:** "`$.`, `js/`, and `${}` work the same everywhere — inputs, branch, loop, idempotency keys." Today that's a lie; after B it's true. `eq()` survives as a convenience, not a workaround.
- **`forEach`/`loop` over large arrays get measurably faster** (cache hit instead of recompile per item).
- **A published canonical expression spec** (G4) becomes the single doc MCP and Skills cite — one source of truth for humans and AI (D7/S11).

## 7. Architecture & design

### 7.1 The cache — inside the existing `Mapper.runJs` (no new file)

The single chokepoint every expression already flows through is `Mapper.runJs` (`Mapper.ts:408-419`). Cache there; nothing else needs a cache.

```ts
// Mapper.ts — replace the body of runJs (private method, line 408)
private static fnCache = new Map<string, Function>(); // ponytail: Map-as-FIFO-LRU; swap for a real LRU only if memory profiling shows it
private static readonly FN_CACHE_MAX = 1000;

private runJs(str: string, ctx: Context, data: ParamsDictionary = {},
              func: FunctionContext = {}, vars: VarsContext = {}): unknown {
  let fn = Mapper.fnCache.get(str);
  if (!fn) {
    fn = Function("ctx", "data", "func", "vars", `"use strict";return (${str});`);
    if (Mapper.fnCache.size >= Mapper.FN_CACHE_MAX) {
      Mapper.fnCache.delete(Mapper.fnCache.keys().next().value); // FIFO evict; ponytail: not true LRU, upgrade if hit-rate matters
    }
    Mapper.fnCache.set(str, fn);
  }
  return fn(ctx, data, func, vars);
}
```

Cache key is the compiled expression *string* (post-`js/`-strip, post-`${}`-substitution). Functions are pure compilations of immutable strings → no staleness. Expression strings are static per-workflow (a finite set), so the 1000-cap rarely evicts in one process.

**Self-check** (`Mapper.fnCache.test.ts`, assert-based): (a) same string twice → same `Function` identity (cache hit); (b) >1000 distinct strings → size stays ≤1000 (eviction); (c) a `js/`-stripped `ctx.req.method` resolves against a fake ctx.

### 7.2 Branch / loop condition resolution — reuse `SubworkflowNode`'s pattern

Both nodes drop their bespoke evaluator and call the Mapper exactly as `SubworkflowNode.ts:347-356` does. Extract that 6-line normalize-then-resolve into one shared helper so all three callers share it (the only genuinely *new* code in this spec):

```ts
// core/shared/src/utils/resolveCondition.ts  — the ONE new helper
import mapper from "./Mapper";
import type Context from "../types/Context";
import type ParamsDictionary from "../types/ParamsDictionary";

/**
 * Resolve a control-flow condition string against ctx, identically to how
 * step inputs and polymorphic sub-workflow names resolve. Normalizes a
 * leading `$.`/`$` to `js/ctx.…` (so a bare proxy string from branch()/loop()
 * gets its prefix stripped), runs `${}` + `js/` through Mapper.replaceString,
 * honours BLOK_MAPPER_MODE. Mirrors SubworkflowNode.resolveSubworkflowName.
 */
export function resolveCondition(raw: string, ctx: Context, data: ParamsDictionary = {}): unknown {
  let expr = raw;
  if (expr.startsWith("$.")) expr = `js/ctx.${expr.slice(2)}`;
  else if (expr.startsWith("$")) expr = `js/${expr.slice(1)}`;
  return mapper.replaceString(expr, ctx, data);
}
```

- **if-else node** (`index.ts:74`): `const result = resolveCondition(condition.condition, ctx, ctx.response.data as ParamsDictionary)`. Delete the local `runJs` (`:17-25`). Preserves today's `data = ctx.response.data` so any `${...}` in a condition keeps its current lodash-lookup base.
- **LoopNode** (`LoopNode.ts:221-226`): `return resolveCondition(expr, ctx, (ctx.response?.data ?? ctx.request?.body ?? {}) as ParamsDictionary)`. Delete the bespoke `Function(...)`. **This also fixes the silent scope gap** — loop conditions gain `func` in scope (they lacked it), matching inputs.
- **resolveIdempotencyKey** (`:23-36`): keep the fail-open `try/catch` + `null` contract (idempotency must never throw — it's a cache miss, not a step failure), but compile through the shared cached path so it benefits from G3. The one site that deliberately keeps different *failure* semantics; that's correct and stays.

Result: `"js/ctx.req.method"` → already prefixed → `replaceString` strips it → resolves against the live alias. `"ctx.request.method === \"POST\""` (eq() output / hand-written raw) → no `js/`/`$` prefix → `replaceString` passes it straight to eval → works exactly as today. **Both old and new forms work; nothing authored today breaks.**

### 7.3 Build-time guard (Option C) in `branch()`/`loop()` — warn only

```ts
// branch.ts, after `const when = unwrapProxies(opts.when)` (line 62):
if (typeof when === "string" && /^js\/ctx\.[\w.$\[\]"']+$/.test(when) && !/[<>=!&|?]/.test(when)) {
  console.warn(
    `branch("${opts.id}"): \`when\` is a bare path (${when.slice(3)}) with no comparison — ` +
    `it will be evaluated as a truthiness check. If you meant a comparison, write ` +
    `eq(${when.slice(3).replace("ctx.", "$.")}, <value>) or e.g. \`${when.slice(3)} === "x"\`.`,
  );
}
```

Warn, not throw — `when: $.state.flag` ("if truthy") is legitimate and must not be rejected. A real comparison mixing a proxy and an operator (`$.state.x > 3`) is a *separate* authoring hazard the proxy can't intercept; it's not caught here and is documented in §8 as the reason `gt/lt/...` exist.

### 7.4 The canonical expression spec (G4) — `docs/d/fundamentals/expressions.mdx`

One page, the single source of truth, cited by MCP/Skills (S11):

| Form | Where | Type fidelity | Use when |
|---|---|---|---|
| `$.state.<id>` (TS) | inputs, branch, loop, keys | preserved | always, in `.ts` — typed, autocompleted |
| `"js/ctx.state.x"` (string) | same | preserved | JSON authoring, or TS escape hatch |
| `"${ctx.state.x}"` | inputs (string fields) | **string-coerced** | building a string (URLs, messages) |
| `eq($.a, b)` / `gt(...)` | branch/loop `when` | → bool | comparison shorthand (convenience over raw JS) |

Rules: scope is `ctx, data, func, vars` only; `${}` runs **before** `js/` in one string; `js/`/`$.` preserve type, `${}` always stringifies; `BLOK_MAPPER_MODE=strict` (default) fails loud; **conditions should use `$`/`js/`/`eq`, not `${}`** (a `${}` in a condition string-coerces then evals the literal — almost never intended). Document `ctx.prev`/`ctx.req`/`ctx.state` as canonical, with `ctx.response`/`ctx.request`/`ctx.vars` as permanent v1-compat aliases (kept forever, zero cost).

### 7.5 Files touched

- **New:** `core/shared/src/utils/resolveCondition.ts` (+ its self-check); `Mapper.fnCache.test.ts`; `docs/d/fundamentals/expressions.mdx`.
- **Edit:** `Mapper.ts` (cache inside `runJs`); `if-else@1.0.0/index.ts` (delete local `runJs`, call `resolveCondition`); `LoopNode.ts` (delete bespoke `Function`, call `resolveCondition` — gains `func` scope); `resolveIdempotencyKey.ts` (route through cached compile, keep fail-open); `branch.ts` + `loop.ts` (warn-only guard C).
- **No change:** `$.ts`, `eq.ts` (the now-redundant alias-canonicalization stays — harmless), `WorkflowNormalizer.ts` (condition is already a plain string), `SwitchNode.ts`, `SubworkflowNode.ts` (already correct — it's the template we're copying).

## 8. Compatibility, migration & risks

**Backward-compat stance (hybrid appetite — existing workflows MUST keep working):**
- Existing `eq()`/`ne()`/raw-`ctx.*`-string conditions: **unchanged** (no `js/`/`$` prefix → pass-through eval, identical result).
- Existing `js/`-prefixed conditions written defensively: now resolve *correctly* instead of throwing — strictly an improvement, no breakage.
- `inputs` resolution: identical (cache is transparent — same `Function` semantics, same scope).
- **No schema-version bump, no migration tooling.** This is a pure bug-fix + perf change behind the existing `BLOK_MAPPER_MODE` knob. (Contrast S2/S4, which DO need schema versioning — S3 deliberately doesn't.)

**Behaviour change to call out (honest trade-off):** a condition that *throws* at eval time previously crashed garbled inside the if-else/loop node; now it raises a clean `MapperResolutionError` (strict) or warns + treats as falsy (warn mode). A workflow that *relied on* a broken `when` silently taking the `else` arm will now fail loud in strict mode. This is correct (loud > silent), but it IS a behaviour change — flag it in the changelog. Escape hatch: `BLOK_MAPPER_MODE=warn` restores log-and-falsy. A `when` that merely resolves to `undefined`/falsy is unchanged in every mode.

**Risk — loop scope widening.** `LoopNode` conditions previously had *no* `func` in scope; after B they do. This can only *add* a previously-failing `func.x` reference's ability to resolve — it cannot break a condition that worked before (which by definition didn't reference `func`). Low risk, strictly additive. Self-check covers a `func`-referencing loop condition.

**Risk — Option C false positives.** The warn must not fire on legitimate truthy checks too aggressively. It's a `console.warn`, not a throw, so worst case is noise; the message offers the truthy interpretation explicitly. If noise complaints arrive, gate it behind `BLOK_VERBOSE`/drop it.

**Risk — cache unboundedness / staleness.** Expression strings are static per-workflow (finite set), so the 1000-entry FIFO cap rarely evicts in one process; functions are pure compilations of immutable strings, so no staleness. The `ponytail:` comment names the FIFO-not-LRU ceiling and the upgrade path.

**Failure mode — `${}` in a condition.** After B, `branch({ when: "${ctx.state.x}" })` string-coerces then evals the literal — almost never intended. C's guard doesn't cover it; the spec (G4) documents that conditions use `$`/`js/`/`eq`, not `${}`.

**JSON-author gap (carried to §10).** JSON-authored branches hand-write `branch.when` and bypass `branch()`, so guard C only protects TS authors. B (the runtime fix) protects *both* — JSON and TS conditions both flow through `resolveCondition` at runtime. So the bug is fully fixed for JSON authors; only the *build-time nudge* (C) is TS-only, which is acceptable (it's a nicety, not the fix).

## 9. Phased implementation plan (smallest-shippable-first)

- **M1 (the bug fix — ship alone, fast):** `resolveCondition` helper + wire into if-else node + `LoopNode`; delete the two hand-rolled evaluators. Closes G1, G2. One PR. This is the standing-rule bug — ship first, ahead of all S4/S5 visual work.
- **M2 (cache):** add the FIFO cache inside `Mapper.runJs`; `resolveIdempotencyKey` routes through it. Closes G3. Add `Mapper.fnCache.test.ts`.
- **M3 (guard + spec):** warn-only guard C in `branch()`/`loop()`; publish `expressions.mdx` (G4). Update the CLAUDE.md "branch when" memory entry to "fixed at the root — conditions now route through the Mapper."
- **M4 (decision record only):** write the §10 D-decision into the dossier — CEL/JSONata deferred, with the explicit trigger. No code.

## 10. Open questions

1. **Option C severity — confirm warn (not throw).** Recommend `console.warn` only: B makes a bare path genuinely work as a truthy check, and `when: $.state.flag` is a legitimate "if truthy". A throw would reject valid code. **Founder call** — default to warn unless told otherwise.
2. **Strict-mode condition behaviour — confirm appetite.** OK to make a *throwing* `when` fail the run in strict mode (vs. today's garbled-but-non-fatal crash)? Recommend yes (loud > silent), with `BLOK_MAPPER_MODE=warn` as the documented escape hatch. It's a behaviour change, however correct.
3. **CEL/JSONata deferral — confirm the trigger condition.** Recorded decision: "Do NOT add a second expression language until the marketplace executes *inline expressions authored by a third party* (not the installer). Node code and workflow JSON authored by the installer are not that case (S6/S12). When that case arrives, adopt CEL for predicates (sandboxable, type-checked) — not JSONata (slow; silent-undefined conflicts with strict mode)." **Founder sign-off** that deferral is acceptable.
4. **Alias deprecation.** Docs pick `prev`/`req`/`state` as canonical; `response`/`request`/`vars` stay as permanent v1-compat aliases. Recommend keep forever (zero cost), document the preference. Also: `eq()`'s now-redundant `canonicalizeCtxPath` (`eq.ts:83-88`) can be dropped in a future cleanup once conditions route through the Mapper — harmless to leave. **Confirm both are nice-to-haves, not S3 scope.**
5. **Build-time guard in `WorkflowNormalizer` too?** JSON-authored branches bypass `branch()`, so C only nudges TS authors. The *runtime* fix (B) already protects JSON authors fully. Adding the same warn in `validateBranchStep` (`WorkflowNormalizer.ts:447-524`) would extend the build-time nudge to JSON. Cheap; recommend yes in M3 if it's a clean drop-in. **Confirm scope (nudge-only, not load-time throw).**

---

**Grounding refs for the founder.** The live bug: `nodes/control-flow/if-else@1.0.0/index.ts:17-25,74` (local `runJs`, no `js/` strip) fed by `WorkflowNormalizer.ts:450-511`. The fix is *already shipped* for sub-workflows at `SubworkflowNode.ts:347-356` (normalize-`$`→-`js/` then `mapper.replaceString(expr, ctx, {})`) — S3 copies that pattern to conditions. The runtime aliases that make the bare-`$` case resolve the instant the prefix is stripped: `Context.ts:48-98`. The divergent evaluators: `Mapper.ts:408-419` (canonical), `if-else/index.ts:24`, `LoopNode.ts:221-226` (note: no `func` in scope), `resolveIdempotencyKey.ts:23-36`. `SwitchNode.ts:60-65` is literal `===` (untouched). The existing workaround: `eq.ts:31-88`. No LRU cache exists today (verified, zero `grep` hits).
