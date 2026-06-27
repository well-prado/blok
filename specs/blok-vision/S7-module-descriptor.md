# S7 — Generalized Module-Descriptor Contract

## Status — Draft for review · depends on: — · phase: 1 (foundation) · consumers: S8 (triggers), later S9/S2 (node-install), runtime-install

## 1. Problem & motivation

Blok just shipped its first genuinely modular surface: opt-in observability via `blokctl observability add/remove/list/status`, built on one clean abstraction — `ObservabilityModuleDescriptor` (id, label, description, dependencies, `envBlock`, `infraFiles`, `composeServices`, `packageDeps`, and five optional lifecycle hooks `validate`/`scaffold`/`setup`/`verify`/`cleanup`; descriptor.ts:49-81). It is the best-factored part of the CLI: a foundation owns the interface + config schema + command group, and each module epic only fills in its descriptor's values. This is the shape the vision needs everywhere — D6 calls for triggers to become "modular like the recently-shipped observability modules," nodes/runtimes to be installable, and `create` to offer a unified picker, all over **one** descriptor contract that **MCP and the CLI share** (D7).

The problem: that pattern is **welded to observability**. `ObservabilityModuleId` (descriptor.ts:19-26) is a closed union; `REGISTRY` is a `Record<ObservabilityModuleId, …>` (descriptor.ts:89); `resolveWithDependencies` (descriptor.ts:285-302), `withObservabilityModule`/`rewriteObservabilityEnvBlock` (observability-mutations.ts:19,65), and the add/remove/list/status group are all observability-named. When S8 (triggers) and node/runtime-install arrive, the lazy-but-wrong path is to copy this whole tree three more times — four near-identical descriptor interfaces, four registries, four env-fence rewriters, four command groups drifting from day one. That is exactly the slop D6 exists to kill: **one pattern, four consumers.**

Two real defects live in the pattern today and will be inherited by every copy unless fixed at the root:

- **The dependency resolver infinite-loops on a cycle** (descriptor.ts:289-296). *This confirms the dossier/brief claim* (understand-cli-modular.md:201, D6: "currently infinite-loops") — see §2 for the exact trace. **The draft of this spec asserted the opposite; that assertion was wrong and is corrected here.**
- **A config-write/env-write transaction gap** in `observability add` (add.ts:127 writes config, add.ts:134 writes env) leaves a half-written project on partial failure — while the sibling `runtime add` already does the right thing (runtime/add.ts:137: *"Copy + install/build BEFORE any config write (no half-config on failure)"*).

There is also a **missed-reuse** defect the create path already half-solved: `observability/apply.ts` (`resolveObservabilitySelection`) is a pure create-time helper that resolves a selection into a config map + env blocks, but `create/project.ts` (project.ts:114-122) still re-parses/validates obs ids inline and never offers a unified picker across triggers + runtimes + observability.

This spec extracts ONE shared module-descriptor contract, fixes the two real defects once at the root, unifies the create-time picker on the existing catalog, and re-homes observability on top — so S8 and beyond are a descriptor data-file, not a subtree fork.

## 2. Current state in Blok

**Descriptor + registry** — `packages/cli/src/commands/observability/descriptor.ts`. Interface lines 49-81; closed id union 19-26; hardcoded `REGISTRY` 89-269; accessors `getObservabilityModule` (272), `allObservabilityModules` (277), `resolveWithDependencies` (285-302). Note the interface already has FIVE hooks (`validate` at 78, not four).

**Dependency resolver — it DOES hang on a cycle.** Exact trace of descriptor.ts:290-296:
```
const visit = (id) => {
  const mod = getObservabilityModule(id);
  if (!mod) throw …;
  if (out.has(mod.id)) return;        // line 293 — guard
  for (const dep of mod.dependencies) visit(dep);   // line 294 — recurse FIRST
  out.add(mod.id);                    // line 295 — add AFTER recursion
};
```
For a cycle `A → B → A`: `visit(A)` — `out` empty, recurse into `B`; `visit(B)` — recurse into `A`; `visit(A)` — **`out` still does not contain A** (it's added only at line 295, *after* the recursion that hasn't returned) → recurse into `B` → … unbounded. The `out.has` guard at line 293 only short-circuits an *already-fully-resolved* node (a diamond, e.g. `A→B`, `A→C`, `B→D`, `C→D`), **not** a back-edge. The hang is real. The fix (§7.2) is a second `onPath` set marking nodes currently on the recursion stack, throwing on a back-edge. First-party descriptors are acyclic today (obs deps: `logging→trace-store` at descriptor.ts:191, `alerting→metrics` at :225), so the fix changes no current behavior — it makes a future authoring mistake (in S8/nodes) fail loudly instead of freezing the CLI.

**Transaction gap is real.** `observability add` (add.ts): scaffold writes infra (114-118); `.blok/config.json` written at 127; `.env.local` written at 134 via `rewriteObservabilityEnvBlock`; `package.json` at 139. No rollback. `rewriteObservabilityEnvBlock` *can* throw — it rejects `BLOK_METRICS_ENABLED` (observability-mutations.ts:67-71). If it throws, config is already on disk: the module is "enabled" with no matching env block. `runtime add` is the model (runtime/add.ts:137-165): all heavy/fallible work (copy + install + build) runs first; config/env/supervisord writes come last (157-165). Observability simply didn't follow the order its sibling already proved.

**Config schema** — `ProjectConfig` (runtime-setup.ts) is `{ triggers?, runtimes?, observability? }` — three sibling flat maps, additive (unknown top-level keys don't break old configs). `ObservabilityModuleConfig` is `{ enabled, addedAt, version?, settings? }`. obs-stack stores its tier under `settings` (add.ts:121).

**Pure mutation + fence helpers are already duplicated.** `observability-mutations.ts` (`withObservabilityModule`/`withoutObservabilityModule`/`rewriteObservabilityEnvBlock`; **fenced** block, markers at lines 15-16) vs `runtime-mutations.ts` (`withRuntime`/`withoutRuntime`/`rewriteRuntimeEnvBlock`; **line-pattern**, not fenced). The module file itself documents the divergence (observability-mutations.ts:8-10): obs spans many env prefixes so it needs a fence; runtime keys are line-matched. A third (triggers) is pending. The two *fenced-style* rewriters are the merge candidates; the runtime line-pattern one is a genuinely different shape (see §7.4).

**Create-time helper already exists, picker doesn't.** `observability/apply.ts` (`resolveObservabilitySelection`, apply.ts:11-21) is a pure resolve-to-(config-map + env-blocks) used by create. But `create/project.ts` parses + validates obs ids inline (project.ts:114-122), selects triggers/runtimes separately (project.ts:88-95), and **never** offers a single multiselect over the catalog. The catalog (`allObservabilityModules()`) and the create UI are disconnected, so what you can pick at create-time vs. add later can drift.

**Command + picker copy-paste.** `observability/index.ts` and `runtime/index.ts` mirror each other's `add/remove/list/status` wiring. The single-select picker appears in both `observability/add.ts:45-53` and `runtime/add.ts:60-68` — copy-paste today.

## 3. Goals & non-goals

**Goals**
1. One `ModuleDescriptor` contract (open-id + `kind` discriminator, generic) that observability re-homes onto with **zero behavior change**, and that S8 (triggers) and later node/runtime-install author against unchanged.
2. One generic dependency resolver with **real cycle detection** (throw on a back-edge — fixes the hang, not just "silent tolerance").
3. One generic, **transactional** apply path (snapshot the two managed files → fallible work first → restore-on-throw) reused by every surface, importing `runtime add`'s proven write-order.
4. One generic **fenced** env rewriter, collapsing the observability/(future-trigger) copies; the runtime line-pattern rewriter deliberately stays separate.
5. A shared create-time picker driven by the descriptor catalogs, replacing the inline obs-id parsing in `create/project.ts`.
6. **One apply entry point** that the future MCP "add module" tool (S11) wraps verbatim — the D7 single-kernel guarantee, designed-in now even though the tool ships later.

**Non-goals**
- Not building modular triggers (that's S8 — this is its foundation).
- Not the registry / remote install (S6/S9). Descriptors stay first-party + statically imported; a remote catalog is a later swap behind the same interface.
- No descriptor-schema versioning, no plugin auto-discovery, no dynamic loading (Option C — no consumer today; see §4).
- No runtime/runner changes — purely CLI/scaffold-time plumbing.
- No new dependency (`@clack/prompts`, commander, node:fs already present).
- Not forcing `runtime`'s mutations/command group to converge in this spec (it's already shipped + tested; convergence is optional later cleanup, §10 Q2).

## 4. Options & alternatives

### Option A — Leave it; copy the pattern per surface
Fork `descriptor.ts` + `*-mutations.ts` + the command group for each new surface.
- **Pros:** zero refactor risk now; surfaces fully independent.
- **Cons:** four interfaces drift; the cycle hang + transaction gap get copied; create-picker never unifies; D6 explicitly rejects this. *Does it improve Blok?* No — it ossifies duplication. The abstraction is NOT speculative (rung 1): D6 names 3 concrete consumers and 2 bugs are already duplicated. Rejected.

### Option B — Extract a generic `ModuleDescriptor` (+ generic registry/resolver/apply), re-home observability
Lift the interface into `services/module-descriptor.ts` with an open string `id` + a `kind` discriminator. Observability's `REGISTRY` becomes a `ModuleRegistry` instance; `ObservabilityModuleId` stays as a *local* alias for narrowing in observability code; the generic layer is string-keyed. Resolver + transactional-apply become generic functions command groups call.
- **Pros:** one contract, 4 consumers (D6); bug fixes land once; observability is the proven reference so the extraction is mechanical and test-guarded; create-picker becomes catalog-driven; one apply entry point for MCP (D7). S8 ships a `triggers/descriptor.ts` data file + a thin command group, no new plumbing.
- **Cons:** touches a shipped, tested surface (the 5+ observability test files are the regression gate); generics add light type ceremony.

### Option C — Full module *kernel*: registry-of-registries, plugin auto-discovery, descriptor versioning, dynamic loading
- **Cons:** classic over-build. Zero third-party descriptor authors, zero remote descriptors today; the registry is a *later* spec (S6). Load-time hook validation, a manifest format, a plugin protocol — machinery nobody consumes, paged at 3am for a one-process CLI. **Rung 1: skip.** Reach for it only when S6/S9 supply a remote consumer.

**Competitor reference:** Terraform providers and n8n's node-loader both converge on "typed descriptor + registry + install/configure/verify/teardown lifecycle." The lesson from n8n: keep the descriptor a plain data record and the registry a plain map until you actually have out-of-tree authors — n8n's pain is precisely the dynamic loader + `typeVersion` drift Option C invites early.

## 5. Recommendation & rationale

**Option B.** Extract the generic contract, re-home observability, fix the two defects at the root, ship the shared picker, expose one apply entry point. Defer Option C's kernel until S6/S9 give it a real consumer.

**Ponytail lens.** Rung 1 (need it?): yes — D6 names 3 concrete consumers, 2 bugs already duplicated. Rung 2 (reuse before build?): we're *collapsing* duplicates and reusing the existing `apply.ts` create helper + `runtime add`'s write-order discipline — not inventing. Stop there: a generic record + a generic map + two generic functions + one picker wrapper. No loader, no plugin protocol, no descriptor-schema versioning (Option C, skipped — say so). The cycle fix is one `Set` + a throw. The transaction fix is *reordering existing writes + a 2-file snapshot* — copying discipline `runtime add` already has.

Consistent with **D6** (generalize descriptor; add cycle detection; fix transaction gap), **D7** (the apply path is the single kernel CLI + future MCP both call), and stays out of **D3/S6**'s lane (no registry here). No contradiction with sibling specs: S8 consumes this contract; S11's MCP "add module" tool wraps the apply entry point; S6/S9's remote catalog is a later swap behind `ModuleRegistry`.

## 6. How it improves Blok

- **Maintainers:** S8 (modular triggers) becomes a ~half-day data-file PR instead of a subtree fork; same for node/runtime-install. One place to fix a bug, one place to add a hook.
- **Users:** `blokctl create` gains one coherent picker — triggers / runtimes / observability (later starter nodes) — driven by the same catalogs `add` uses, so create-time choices and post-create `add` choices never disagree.
- **Reliability:** a failed `add` leaves the project byte-identical to before (no orphaned config pointing at a missing env block), across *every* surface — not just whichever one someone hardened.
- **No more CLI freeze:** a cyclic `dependencies` array in a future trigger/node descriptor throws a clear error instead of hanging the process (the current behavior, descriptor.ts:290-296).
- **AI (D7):** the eventual MCP "install a trigger / observability module" tool calls the same apply kernel with the same cycle/transaction guarantees — the AI path cannot diverge from the human path.

## 7. Architecture & design

### 7.1 The shared contract — `packages/cli/src/services/module-descriptor.ts`

```ts
export type ModuleKind = "observability" | "trigger" | "runtime" | "node";

export interface ModuleApplyOpts {
  projectDir: string;
  nonInteractive: boolean;
  /** Per-surface knobs (obs-stack tier, trigger port, …). Stored under config `settings`. */
  settings?: Record<string, unknown>;
}

export interface ModuleDescriptor {
  kind: ModuleKind;
  id: string;                  // unique WITHIN a kind; "<kind>:<id>" globally (see §10 Q1)
  label: string;
  description: string;
  dependencies: string[];      // ids within the same kind
  /** Pure: inert-by-default text for the managed .env.local fence. */
  envBlock: (opts: { projectDir: string }) => string;
  infraFiles: string[];
  composeServices: string[];
  packageDeps: Record<string, string>;
  validate?: (projectDir: string) => Promise<void>;
  scaffold?: (o: ModuleApplyOpts) => Promise<{ filesCreated: string[] }>;
  setup?:    (o: ModuleApplyOpts) => Promise<void>;
  verify?:   (projectDir: string) => Promise<{ ok: boolean; message: string; dashboardUrl?: string }>;
  cleanup?:  (o: ModuleApplyOpts) => Promise<void>;
}
```

This is `ObservabilityModuleDescriptor` (descriptor.ts:49-81) verbatim plus `kind`, minus the closed-union `id`, with `ObservabilityScaffoldOpts` (descriptor.ts:38-47) generalized to `ModuleApplyOpts` — note `tier`/`localRepo` move from named fields into `settings` (obs-stack reads `settings.tier`, `settings.localRepo`; the `apply.ts` call site at add.ts:104-109 maps `--tier`/`--local` into `settings`). `ObservabilityModuleId` stays as a local type alias so observability internals keep narrowing; each descriptor literal gains `kind: "observability"`.

### 7.2 Generic registry + resolver — fixing the hang

```ts
export class ModuleRegistry {
  constructor(private readonly mods: Map<string, ModuleDescriptor>, readonly order: string[]) {}
  get(id: string) { return this.mods.get(id); }
  all() { return this.order.map((id) => this.mods.get(id)!); }
  private kind() { return this.mods.values().next().value?.kind ?? "module"; }

  /** Transitive deps in stable order. Throws on unknown id AND on a dependency cycle. */
  resolve(ids: string[]): { resolved: string[]; added: string[] } {
    const out = new Set<string>();
    const onPath = new Set<string>();           // nodes on the current recursion stack
    const visit = (id: string) => {
      if (out.has(id)) return;                   // already fully resolved (diamond) — fine
      const m = this.mods.get(id);
      if (!m) throw new Error(`Unknown ${this.kind()} "${id}".`);
      if (onPath.has(id))                         // back-edge → real cycle → THROW (was: infinite loop)
        throw new Error(`Dependency cycle detected at ${this.kind()} "${id}".`);
      onPath.add(id);
      for (const d of m.dependencies) visit(d);
      onPath.delete(id);
      out.add(id);
    };
    for (const id of ids) visit(id);
    const resolved = this.order.filter((id) => out.has(id));
    const requested = new Set(ids);
    return { resolved, added: resolved.filter((id) => !requested.has(id)) };
  }
}
```

The `onPath` set is the only behavioral delta vs. descriptor.ts:290-296. **It converts an infinite loop into a thrown error** — not, as the draft claimed, "silent tolerance into a throw." (The existing `out.has` guard at line 293 short-circuits diamonds, not back-edges; a back-edge re-enters before `out.add` ever runs.) `resolveWithDependencies` becomes a 1-line wrapper delegating to the observability registry instance, preserving its current signature so `apply.ts:16` and `add.ts:77` callers are untouched.

**Check left behind:** a resolver unit test with a `A→B→A` descriptor asserting `resolve()` *throws within a timeout* (the regression that proves the hang is gone), plus a diamond (`A→{B,C}→D`) asserting `D` appears once in stable order.

### 7.3 Generic transactional apply — fixing the write-order gap

```ts
// services/module-apply.ts
export async function applyModules(
  root: string, reg: ModuleRegistry, toApply: string[], opts: ModuleApplyOpts,
  persistConfig: (id: string) => void,   // surface-specific in-memory config mutation, deferred
  flushConfig: (root: string) => void,   // surface-specific config flush, called LAST
  flushEnv: (root: string) => void,      // surface-specific env-fence rewrite
): Promise<{ created: string[] }> {
  const cfgPath = path.join(root, ".blok", "config.json");
  const envPath = path.join(root, ".env.local");
  const cfgBefore = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, "utf8") : null;
  const envBefore = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : null;
  const created: string[] = [];
  try {
    // 1. ALL fallible work first (matches runtime/add.ts:137 discipline).
    for (const id of toApply) {
      const d = reg.get(id)!;
      if (d.validate) await d.validate(root);
      if (d.scaffold) created.push(...(await d.scaffold(opts)).filesCreated);
      if (d.setup) await d.setup(opts);
      persistConfig(id);                  // in-memory only
    }
    // 2. Then the cheap commits. Env BEFORE config-flush so a throwing
    //    envBlock (observability-mutations.ts:67) can't leave config ahead of env.
    flushEnv(root);
    flushConfig(root);
  } catch (err) {
    // ponytail: snapshot-restore of the two managed files, not a journal — a CLI
    // run is single-process + sub-second; upgrade to a real WAL only if apply ever
    // mutates >2 files or spans processes.
    if (cfgBefore != null) fs.writeFileSync(cfgPath, cfgBefore); else fs.rmSync(cfgPath, { force: true });
    if (envBefore != null) fs.writeFileSync(envPath, envBefore); else fs.rmSync(envPath, { force: true });
    for (const f of created) fs.rmSync(f, { force: true });
    throw err;
  }
  return { created };
}
```

The minimum honest fix: snapshot the two managed files (restoring to *absent* if they didn't exist — the draft's version leaked a newly-created config on rollback), do fallible work first, env-before-config, restore-on-throw. `observability add` routes writes through this — its scaffold/setup loop (add.ts:110-123) becomes the `toApply` loop, its config write (add.ts:127) becomes `flushConfig`, its env write (add.ts:134) becomes `flushEnv`. `package.json` merge (add.ts:137-139) stays as a post-commit additive step (a failed dep-merge doesn't orphan config/env, and it's not in the managed-file set). `runtime add` already orders correctly (runtime/add.ts:137); it may adopt the snapshot-rollback opportunistically but is **not forced to** in this spec.

The `persistConfig`/`flushConfig`/`flushEnv` callbacks keep `applyModules` ignorant of which `ProjectConfig` sub-map (`observability` vs future `triggers`) it's mutating — the surface owns its `with*Module` helper, the kernel owns the transaction. This is the D7 single entry point: MCP (S11) calls `applyModules` with the same callbacks.

**Check left behind:** an apply-rollback test that injects a `flushEnv` that throws (or an obs block containing `BLOK_METRICS_ENABLED`, which observability-mutations.ts:67 rejects) and asserts config + env on disk are byte-identical to before, *and* that a not-previously-existing config file is left absent.

### 7.4 Parameterized fenced env rewriter

Collapse `rewriteObservabilityEnvBlock` (observability-mutations.ts:65, fenced) and the pending trigger copy into one fenced rewriter:

```ts
export function rewriteFencedBlock(envContent: string, blocks: string[], start: string, end: string): string
```

with per-kind markers (`# >>> Blok observability (managed by blokctl) >>>`, `# >>> Blok triggers (managed by blokctl) >>>`). `rewriteObservabilityEnvBlock` becomes a thin wrapper that keeps its `BLOK_METRICS_ENABLED` guard (observability-mutations.ts:67-71) *outside* the generic helper — the guard is observability-specific policy, not env-rewriting mechanics. `runtime-mutations.ts`'s line-pattern rewriter is a genuinely different shape (line-match, not fenced — documented at observability-mutations.ts:8-10); forcing it into the fenced helper would be over-reach. Leave it; note the divergence (§10 Q2).

### 7.5 Shared create-time picker — `services/module-picker.ts`

```ts
export async function pickModules(reg: ModuleRegistry, enabled: Set<string>, message: string): Promise<string[]>;   // p.multiselect for create
export async function pickModule (reg: ModuleRegistry, enabled: Set<string>, message: string): Promise<string | null>; // p.select for `add`
```

`create/project.ts` calls `pickModules` for observability instead of the inline parse/validate (project.ts:114-122), reusing the existing `resolveObservabilitySelection` (apply.ts) to turn the selection into config+env. `observability/add.ts:45-53` and `runtime/add.ts:60-68` collapse onto `pickModule`. Flags (`--observability`, `--triggers`, `--runtimes`) still bypass the prompt for non-interactive use exactly as today (project.ts:88-95, 114-118). Triggers/runtimes join the create multiselect *only once they have descriptor catalogs* — triggers in S8; runtimes already have a catalog (`runtime` descriptors) and can join immediately.

### 7.6 File changes
- **New:** `services/module-descriptor.ts`, `services/module-registry.ts`, `services/module-apply.ts`, `services/module-picker.ts` (+ resolver-cycle/diamond test, apply-rollback test).
- **Shrunk:** `observability/descriptor.ts` → data literal (each entry gains `kind`) + `new ModuleRegistry(...)`; `resolveWithDependencies` → 1-line delegate. `observability/add.ts`/`remove.ts` → call `applyModules`/picker. `rewriteObservabilityEnvBlock` → wrapper over `rewriteFencedBlock` keeping its guard.
- **Touched:** `create/project.ts` → `pickModules` (reuses `apply.ts`). `runtime-setup.ts` `ProjectConfig` unchanged (already additive).
- **Untouched (deliberate):** `runtime-mutations.ts` (line-pattern, stays), `runtime/add.ts` write-order (already correct).

## 8. Compatibility, migration & risks

**Backward-compat stance (hybrid appetite).** Fully backward-compatible — internal CLI plumbing only. No `.blok/config.json` shape change (three sibling maps stay; obs-stack tier stays under `settings`), no `.env.local` marker change (`# >>> Blok observability …` preserved), no workflow-format impact, no schema-version bump. Existing projects don't migrate; observability behavior is byte-identical (its tests are the gate).

**The one observable internal change:** a *cyclic* descriptor `dependencies` array now throws instead of hanging. No first-party descriptor is cyclic (verified: descriptor.ts:191, 225 — acyclic), so no current command changes behavior; the change only affects future authoring mistakes in S8/nodes. This is strictly safer.

**Migration tooling:** none for users. Internally, the "migration" is mechanical: each observability descriptor literal gains `kind: "observability"`, `ObservabilityScaffoldOpts.tier/localRepo` reads move under `settings`, and accessor imports switch to the generic layer — guarded by `descriptor.test.ts` + the 4 module test files (alerting/logging/obs-stack/tracing) + `observability-mutations.test.ts` + `obs-setup.test.ts`.

**Risks & failure modes**
- *Regressing observability during extraction.* Mitigation: extraction is a pure-refactor commit (no behavior delta), the existing test files stay green, NO new surface consumes the contract until that commit lands.
- *`settings`-migration of obs-stack tier.* The tier currently flows `--tier` → `ObservabilityScaffoldOpts.tier` → descriptor.scaffold → config `settings.tier` (add.ts:107,121). Re-routing through `ModuleApplyOpts.settings.tier` must preserve the exact config shape obs-stack `verify`/`cleanup`/`list` read. Mitigation: `obs-stack-module.test.ts` asserts the round-trip.
- *Rollback restoring a stale file under concurrent hand-editing.* A CLI run is sub-second + single-process; concurrent edit is not a real scenario. Named by the `ponytail:` comment in §7.3 with its upgrade path.
- *Over-generalizing the env rewriter.* Mitigation: only the two *fenced* rewriters merge; the runtime line-pattern rewriter stays separate (forcing it in is the over-build).

## 9. Phased implementation plan

**M1 — Extract, zero behavior change (smallest shippable).** Create `module-descriptor.ts` + `ModuleRegistry`; re-home observability's `REGISTRY` onto it; add the `onPath` cycle fix; route `tier`/`localRepo` through `settings`. All command behavior identical. **Gate:** all existing CLI tests green + new resolver-cycle (throws within timeout) + diamond tests.

**M2 — Transactional apply.** Land `module-apply.ts` with snapshot-restore (incl. restore-to-absent); route `observability add`/`remove` through it; env-before-config order. **Gate:** apply-rollback test forcing `flushEnv` to throw, asserting config+env unchanged (and absent-stays-absent).

**M3 — Shared picker + fenced-rewriter merge.** `pickModules`/`pickModule`; wire `create/project.ts` (reusing `apply.ts`) + the two `add.ts` pickers; collapse `rewriteObservabilityEnvBlock` onto `rewriteFencedBlock` keeping its guard.

**M4 — Hand-off to S8.** S8 authors `triggers/descriptor.ts` as a data file + a thin command group + a `with*`/`flush*` callback trio — no new plumbing. This milestone proves the contract carries a second consumer; it lives in S8, listed here only as the acceptance criterion for M1-M3.

## 10. Open questions

1. **Global id namespacing.** Keep ids unique *within a kind* (`"tracing"`) and namespace only on cross-kind reference (`"observability:tracing"`), or make every id globally `kind:id` from the start? *Recommendation:* within-kind (lazier, matches today, no cross-kind deps exist); the registry already knows its `kind`, so global form is derivable when S6/S11 need it.
2. **Should `runtime`'s line-pattern env rewriter + command group converge** onto the generic contract in later cleanup, or stay separate? *Recommendation:* env rewriter stays separate (different shape, documented); the `runtime` *descriptor* MAY adopt `ModuleDescriptor` opportunistically since it already has a registry-like catalog — but not forced in this spec.
3. **Cycle severity:** hard-throw (recommended — a cycle is a modeling bug *and* currently hangs the CLI) vs. warn-and-tolerate. Confirm hard-throw given it's first-party-only today.
4. **MCP parity timing (D7):** wire the MCP "add module" tool onto `applyModules` in this spec, or defer to S11? *Recommendation:* defer the tool; ship `applyModules` as the single entry point now so S11 is a thin wrapper.
5. **Does `create`'s picker list nodes/workflows** (understand-cli-modular.md:267-279)? *Recommendation:* triggers (S8) + runtimes (now) + observability (now); nodes/workflows gated on a catalog to pick from (S6/S9).

---

**Note for the founder — correction to the prior draft.** The draft of this spec asserted the dependency resolver does *not* hang and that the dossier was "inaccurate." **That was wrong, and I verified it by tracing descriptor.ts:290-296 directly:** `out.add(mod.id)` runs *after* the recursion (line 295), and the `out.has` guard (line 293) only catches already-fully-resolved diamonds, not back-edges — so a cyclic `dependencies` array re-enters before any node is marked resolved and **loops unbounded**. The dossier/brief (D6: "currently infinite-loops") were correct. The §7.2 `onPath` fix converts the hang into a thrown error. The transaction gap (config at add.ts:127 before the fallible env-write at add.ts:134) is real, and `runtime add` (runtime/add.ts:137) already demonstrates the correct order to copy. One more reuse the draft missed: `observability/apply.ts` already provides a pure create-time resolve helper the shared picker should build on rather than re-deriving.
