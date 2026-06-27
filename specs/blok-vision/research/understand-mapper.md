Perfect. Now let me return this as the final output:

## Blok Expression/Data-Mapping System — Concrete Map

### How it works today (with file:line refs)

**Expression Entry Points:**

| Location | Resolver | File:Line |
|---|---|---|
| Step `inputs` | `Mapper.replaceObjectStrings` → `replaceString` | `core/shared/src/utils/Mapper.ts:269-288` |
| `idempotencyKey` / `concurrencyKey` / Debounce `key` | `resolveIdempotencyKey` (custom eval) | `core/runner/src/idempotency/resolveIdempotencyKey.ts:23-36` |
| Branch `when` | Raw `ctx` eval (NOT Mapper) | `core/workflow-helper/src/components/branch.ts:55-90` |
| Switch `on` | `Mapper.replaceString` | `core/runner/src/SwitchNode.ts:72` |
| Switch case `when` | Literal equality (no expr eval) | `core/runner/src/SwitchNode.ts:60-65` |
| Sub-workflow `subworkflow` | `SubworkflowNode.resolveSubworkflowName` + Mapper | `core/runner/src/SubworkflowNode.ts:336-384` |
| Loop/ForEach iterables | `Mapper.replaceString` | `core/shared/src/utils/Mapper.ts:269-288` |
| TryCatch context (`$.error.*`) | Built into ctx; no expr eval | Context construction |

**Dual-Phase Resolution:**

1. **Definition time:** TypeScript `$` proxy (via `unwrapProxies()`) compiles to `"js/ctx.req.body.id"` strings
   - File: `core/workflow-helper/src/proxy/$.ts:83-114`

2. **Runtime:** Mapper resolves strings via two syntaxes:
   - `${path}` → lodash lookup + JS-eval fallback (always returns string via interpolation)
   - `js/...` → full JS evaluation (preserves type fidelity)
   - File: `core/shared/src/utils/Mapper.ts:299-420`

**Context Object:**
- `ctx.request` / `ctx.req` — trigger payload (body, query, params, headers)
- `ctx.response` / `ctx.prev` — current step's output envelope
- `ctx.state` / `ctx.vars` — accumulated step outputs by id (auto-persisted after each step)
- `ctx.config[stepName]` — step config (populated by Configuration, then blueprintMapper mutates it)
- `ctx.func`, `ctx.vars` — scope bindings for expressions (ctx.func + ctx.vars bound into eval)

**Execution Flow:**
```
TriggerBase.run(ctx)
  → Scheduling gates (delay/debounce/TTL)
  → Concurrency gate
  → RunnerSteps.runSteps(ctx, steps)
      for each step:
        NodeBase.process() → blueprintMapper() → Mapper.replaceObjectStrings()
          (mutates ctx.config[stepName] in place)
        step.run(ctx) ← receives resolved inputs
        idempotency cache check (before step.run)
        PersistenceHelper.applyStepOutput() ← stores result to ctx.state[stepId]
```

---

### Seams & Extension Points

1. **BLOK_MAPPER_MODE** env var (strict/warn/silent) — controls failure behavior for Mapper only
   - File: `core/shared/src/utils/Mapper.ts:84-96`
2. **Logger integration** — warn mode routes via `ctx.logger.logLevel("warn", ...)` (console + Studio)
   - File: `core/shared/src/utils/Mapper.ts:172-196`
3. **Heuristic error hints** — recognizes common patterns (undefined access, syntax, scope)
   - File: `core/shared/src/utils/Mapper.ts:139-163`
4. **Plain container detection** — stops recursion at class instances (regression fix)
   - File: `core/shared/src/utils/Mapper.ts:235-239`
5. **Object interpolation** — JSON-encodes complex values in `${...}` (pre-v0.3 fix)
   - File: `core/shared/src/utils/Mapper.ts:213-225`

---

### Hard Constraints/Invariants

1. **`${...}` runs before `js/...`** in single `replaceString()` call (nested-expr safe)
2. **Mapper mutates in place** — `NodeBase.originalConfig` saves clone before blueprintMapper
3. **Expression scope isolation** — only `ctx`, `data`, `func`, `vars` in scope (Function, not eval)
4. **Type fidelity:** `js/...` preserves types; `${...}` always returns string
5. **Falsy values preserved** — explicit `=== undefined` check (not `||`)
6. **State persists AFTER resolution** — no circular inputs allowed
7. **Branch `when` is raw ctx eval** — NOT Mapper-resolved (critical footgun: bare `$` fails silently)
8. **Switch cases are literal** — no expression eval in `when` values
9. **Idempotency keys fail open** — `null` on error (never throws/warns)
10. **Sub-workflow name must be non-empty string** — errors surface early

---

### What Must Change for Vision

1. **Branch `when` ergonomics:** `$.req.method` silently fails; needs Mapper eval OR DSL forbid bare `$`
2. **Naming collision:** `ctx.prev` vs `ctx.response` (same object, confusing); canonicalize one
3. **Feature parity:** `${...}` templating undocumented for JSON authors; spec both syntaxes formally
4. **Error handling asymmetry:** Trigger-level keys fail silent (open); step-level keys throw (strict); consolidate or document
5. **Step-level concurrency:** Only trigger gates exist; workflow can't rate-limit individual steps
6. **Docs:** No formal spec for expression scope, precedence, or when to use `js/` vs `${}`
7. **Debugging:** No dry-run for expressions; Studio could surface live context scopes
8. **Performance:** Every `replaceString()` compiles fresh Function; opportunity for LRU cache

---

### Risks/Gotchas

1. **Circular inputs:** Step can't reference own output in its inputs (undefined until after step runs)
2. **Cache side effects:** Sub-workflow idempotency caches full child result; re-runs don't fire (no emails/charges on cache hit)
3. **Debounce mode flip:** Switching `leading` ↔ `trailing` between deploys flips behavior
4. **Lazy lock expiry:** Crashed process holding concurrency lock blocks others for up to 1h
5. **Polymorphic namespace:** Prefix only applies to dynamic names, not literals (confusing dispatch failures)
6. **Class instances block recursion:** Date/Buffer/custom classes in step output don't get walked (rare, but silent)
7. **Circular reference truncation:** `${self}` with cyclic data falls back to `"[object Object]"` (data loss)
8. **ForEach perf:** 1000-item loop with expressions resolves 1000× (O(n) overhead; cache compiled functions)
9. **Error re-throws in catch:** TryCatch envelope captures error at catch entry; re-throw doesn't update envelope
10. **Branch condition mistakes:** Dev writes `branch({ when: $.req.method })` expecting it to work; silently evaluates to undefined

---

**Summary:** Dual-phase system (definition-time `$`→`js/` compilation + runtime Mapper evaluation) with clear seams. Biggest footgun is branch `when` bypassing Mapper. Risks are operational/semantic, not bugs. Ready to extend via env vars and logger hooks.