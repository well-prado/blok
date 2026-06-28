# ADR 0001 — Handle-ref lowering: structural `{$ref}` in the IR, lowered to `js/` strings at the runner boundary

- **Status:** Accepted (spike resolution — unblocks implementation)
- **Date:** 2026-06-27
- **Resolves:** [#414](https://github.com/well-prado/blok/issues/414) (primary), [#297](https://github.com/well-prado/blok/issues/297), [#348](https://github.com/well-prado/blok/issues/348)
- **Epics:** #413 (typed handles + `$ref`), #296 (IR), #338 (auto-persist + handle resolution)
- **Validation source:** `specs/blok-vision/Core-Redesign-Validation.md` finding #1 ("THE CONTRACT FORK")

## Context — the contract fork

The redesign deck asserts two things the current code makes mutually exclusive:

1. The published IR carries a **structural** reference: `inputs: { url: { $ref: { step, path } } }` — so the canvas, JSON twin, and AI can derive edges and catch dangling refs *without executing*.
2. The runtime is **byte-identical** — "the same Mapper resolves the same `{$ref}` against `state[step]` using today's engine".

Claim 2 is **false as stated.** The real Mapper (`core/shared/src/utils/Mapper.ts:269-288`) only resolves `typeof value === "string"` and recurses *into* plain-object containers (`isPlainContainer`, :235). A `{$ref:{step,path}}` value is a plain container, so the Mapper walks **into** it and string-resolves the inner `step`/`path` fields — it never treats it as a reference.

Worse, a handle compiles to **three different wire forms by position**, today already:

| Position | Wire form | Produced by | Resolved by |
|---|---|---|---|
| step `inputs` value | `"js/ctx.state.<id>.<path>"` string | `unwrapProxies` (`proxy/$.ts:154`) | `Mapper.jsMapper` |
| inside a string (`tpl`) | `${...}` / `js/\`…\`` template | (redesign-new; today `js/` template) | `Mapper` interpolation |
| `branch.when` | **bare `ctx.state…` raw string** (no `js/`) | `eq()` reads the tag directly (`eq.ts:69-71`) | if-else node's raw `Function("ctx",…)` — **bypasses the Mapper** |

So "one `{$ref}`, one engine" is a fiction unless we decide *where* `{$ref}` lives and *what* the runtime actually sees.

## Empirical probe (real Mapper, not a mock)

Run against `core/shared/src/utils/Mapper.ts` with a populated `ctx` (probe archived below):

```
S1 {$ref} through real mapper -> {"url":{"$ref":{"step":"validate","path":["productId"]}}}   # NOT resolved — passes through untouched
S2 js/ strings through real mapper -> {"url":"P-123","qty":4} | typeof qty = number          # resolved, type-preserving
S3 after lowering   -> {"url":"js/ctx.state.validate.productId","whole":"js/ctx.state.validate","list":["js/ctx.state.validate.qty","static"],"nested":{"inner":"js/ctx.state.checkStock.inStock"}}
S3 after mapper     -> {"url":"P-123","whole":{"productId":"P-123","qty":4},"list":[4,"static"],"nested":{"inner":true}}   # field/whole/array/nested all resolve
S4 branch.when raw-ctx eval -> true                                                           # third wire form: raw ctx, no Mapper
```

S1 is the falsification of the byte-identical-`{$ref}` claim. S3 is the proof the chosen option works end-to-end including every edge case the spikes asked for.

## Options

- **A — Lower to `js/` strings at authoring time** (what `unwrapProxies` does today). Mapper truly unchanged. But the IR then carries `js/ctx.state…` *strings*, not `{$ref}` — the canvas/twin/AI must **parse strings** to derive edges and detect dangling refs. The deck's "`{$ref}` in the wire JSON" story is dead; static validation becomes string-grepping.
- **B — Add a `$ref` branch to `replaceObjectStrings`.** IR carries structural `{$ref}`. But it's an **engine change** to the load-bearing Mapper (the one file the validation report flags as most dangerous to touch), the "byte-identical engine" claim is formally retracted, and the idempotency cache hash format changes (cached input is now a `{$ref}` object, not a string) → cache invalidation on rollout.
- **C — Structural `{$ref}` in the IR; a load-boundary pass lowers it to today's wire strings before the engine runs.** (#348's hybrid.) The published/serialized IR is structural — canvas/twin/AI get static validation for free. A small, position-aware `lowerRefs` pass at the runner boundary compiles `{$ref}` → exactly the strings the current engine already resolves. **The Mapper and the if-else node are untouched.**

## Decision — Option C

Adopt **C**. It is the only option that keeps *both* deck promises true once they're correctly scoped to **two different layers**:

- **The IR / published JSON layer** (what canvas, JSON twin, AI, registry read) carries **structural `{$ref}`**. Static dangling-ref / ephemeral-ref / `as`-mismatch detection happens here, pre-execution.
- **The runtime layer** (what the Mapper / if-else node see) is **byte-identical to today** — plain `js/ctx.state…` strings and raw `ctx.*` `when` strings. No engine change.

The deck's error was conflating these layers. The corrected single statement: *"the IR is structural; a deterministic load-boundary pass lowers it to today's exact wire strings, so the resolution engine is unchanged."*

### Why C over A/B (ponytail check)

C **reuses the entire existing `js/` + raw-ctx resolver** (ladder rung 2: it already exists) and adds only the one genuinely-new thing the redesign needs — a structural artifact for static tooling — as a thin pre-pass. B touches the load-bearing Mapper for a benefit C already delivers. A throws away the static-validation story that is half the reason the redesign exists. C's lowering pass also **consolidates** the three scattered authoring-time lowerings (`unwrapProxies` for inputs, `eq()`/raw strings for `when`) into one load-time pass keyed off IR structure — net less surface, not more.

### The lowering pass (position-aware — this is the three wire forms, unified)

One pass at workflow load, before the runner sees inputs. A `{$ref:{step,path}}` node lowers by **position**:

| IR position | Lowers to | Mirrors today's |
|---|---|---|
| step `inputs` value | `"js/ctx.state.<step>" + path` | `unwrapProxies` output |
| `tpl` segment (ref embedded in a string) | `js/\`…${ctx.state.<step>…}…\`` template literal | (new — type-faithful for the embedded value) |
| `branch.when` (boolean ref / `{$op,left,right}`) | **bare** `ctx.state.<step>… <op> <literal>`, alias-canonicalized | `eq.ts` output (raw, no `js/`) |

`path` mapping: string segment → `.seg`, numeric → `[n]`, **empty `path:[]` → whole-output ref** (`js/ctx.state.<step>`, resolves to the entire step object — verified S3 `whole`).

### Idempotency hash stability

Lowering is **deterministic** (pure function of the structural ref), so whatever the runner hashes for the idempotency key is stable run-to-run. Recommendation: hash the **structural IR input** (lowering-independent and canonical) rather than the resolved value. Net effect under C: the cached *input shape* is today's `js/` string (unchanged from current behavior) → **no cache-format break on rollout**, unlike B. Exact hash site to confirm during impl (the key builder in `core/runner`); not load-bearing for this decision.

## Edge cases (all covered by the probe / pass design)

- **`{$ref}` nested in an array** → lowered (S3 `list[0]` → `4`, sibling literals preserved).
- **`{$ref}` nested in a plain object** → lowered (S3 `nested.inner` → `true`); because lowering runs *before* the Mapper, the Mapper never sees `{$ref}` and the "recurse-into-plain-object double-resolve" risk (#297) **cannot occur**.
- **whole-output ref `path:[]`** → `js/ctx.state.<step>`, full object (S3 `whole`).
- **`forEach` per-item ref + cross-workflow recursion guard** (Mapper.ts:256-267) → unaffected: lowering emits plain strings before load, the class-instance guard sees no change.
- **Reserved key `$ref`** → the IR reserves `$ref` as the ref sentinel. Sentinel shape is a single-key `{$ref:{step:string,…}}`. `grep` confirms **no** current workflow uses `$ref` as user input data. Documented reservation; the pass treats only the sentinel shape as a ref.

## Deck claims to correct (`specs/blok-vision/deck/redesign-data.json`)

Every claim below asserts the false "today's Mapper resolves `{$ref}`". Rewrite to the two-layer framing.

| Location (content path) | Current (wrong) | Corrected |
|---|---|---|
| `sections[0].takeaways[4]` | "the mapper resolves the same `{ $ref }` against state[step] using today's engine" | "the IR carries `{$ref}`; a load-boundary pass lowers it to today's `js/ctx.state…` string, which today's mapper resolves unchanged" |
| `sections[3].takeaways[3]` | "the mapper still resolves a structural reference against state[step] — same engine" | "the engine is unchanged; `{$ref}` is lowered to the existing string form before the mapper runs" |
| `sections[4].takeaways[2]` | "the same Mapper that resolves `$.state.*` today resolves that ref against state[step]" | "reading a handle records `{$ref}`; it is lowered to the `$.state`/`js/` string the mapper already resolves" |
| `sections[4].blocks[0].newCaption` | "same `{$ref}`→state[id] resolution" | "same auto-persist; `{$ref}` is lowered to today's resolution path" |
| `sections[5].takeaways[4]` / `frame.overview[5]` | "`inputs:{$ref}` … resolved by the same mapper" | "`inputs:{$ref}` in the IR, lowered to the existing wire string, resolved by the same mapper + same `GrpcRuntimeAdapter`" |
| `frame.overview[1]` | "the Mapper that resolves refs against state[step] [is] byte-identical" | "the Mapper is byte-identical; a new deterministic lowering pass sits *above* it, translating `{$ref}` to the strings it already resolves" |

(#414 cited line numbers 32/152/167/210/212; the file is single-object JSON so addresses are given by content path, which is stable across reformatting.)

## Consequences / unblocks

- **IR `inputs` value type** (epic #296 published schema) is now decided: `scalar | nested-object/array | { $ref: { step, path } } | { $tpl: [...] } | { $op, left, right }`. Not `string`.
- **Implement:** a `lowerRefs(ir)` pass at the runner load boundary (new, ~the probe's function generalized to the three positions). The Mapper and if-else node get **zero** changes.
- **Static validator** (#348) operates on the structural IR pre-lowering — dangling/ephemeral/`as`-mismatch refs caught without execution. Prototype deferred to #348's own task.
- The authoring-time `unwrapProxies` + `eq()` lowerings are **superseded** by the single load-time pass once the handle DSL lands (back-compat: `$`/`js/` strings still pass straight through the unchanged Mapper).

## Probe (archived — reproduce with `bun probe.ts`)

The runnable probe lives at `specs/blok-vision/adr/0001-probe.ts`. It imports the real Mapper and runs S1–S5 above. Throwaway — not wired into the build.
