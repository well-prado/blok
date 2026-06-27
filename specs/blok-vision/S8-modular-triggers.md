# S8 — Modular Triggers

## Status — Draft for review · depends on: S7 (generalized module-descriptor contract) · informed by D6/D7 · phase: 2

## 1. Problem & motivation

Blok ships **nine** trigger families as nine hardwired npm packages under `triggers/` (`cron`, `grpc`, `http`, `mcp`, `pubsub`, `sse`, `webhook`, `websocket`, `worker` — verified by `ls triggers/`). *(Note: the dossier §1 says "8 hardwired"; the repo has 9 directories. This spec uses the ground-truth count.)*

Adding or removing a trigger today is manual surgery: edit `src/triggers/<kind>/index.ts`, add the package to `package.json`, set `TRIGGER_<KIND>_PORT`, and — for the HTTP-family — splice the new trigger into the shared-Hono `App` constructor by hand (`triggers/http/src/index.ts:30-50`). There is no `blokctl trigger add`, no removal path, no per-trigger health check, and no machine-readable inventory an AI agent can read to know which triggers a project runs.

This blocks three pillars of the vision:

1. **AI-native authoring** — an agent assembling a backend should say "this needs a webhook receiver" and have it installed + wired without touching framework internals, exactly as `blokctl observability add` already does (D7).
2. **Modular parity** — the founder explicitly wants triggers "modular like the recently-shipped observability modules." Observability proved the descriptor pattern; triggers are its obvious second consumer (D6).
3. **Lean install** — a pure-HTTP project shouldn't carry triggers it never uses. Today `@blokjs/trigger-http` **hard-depends** on four sibling packages (`triggers/http/package.json` dependencies: `trigger-mcp`, `trigger-sse`, `trigger-webhook`, `trigger-websocket` — all at `^0.7.0`), so every HTTP project drags in MCP + SSE + webhook + websocket whether or not it uses them.

**Why this is "wire it up," not "build a subsystem."** The data model already half-exists. `.blok/config.json` has a `triggers` block (`runtime-setup.ts:96`), a `TriggerConfig` type (`runtime-setup.ts:60-66`), a `createTriggerConfig()` factory (`runtime-setup.ts:921`), a `TRIGGER_PORTS` map (`runtime-setup.ts:879`), and the create-time flow already splits HTTP-mounted from spawned triggers (`project.ts:426-432`). S8 formalizes this into the S7 descriptor shape and gives it a CLI.

## 2. Current state in Blok

**Trigger packages.** Nine, each a `TriggerBase` subclass (`core/runner/src/TriggerBase.ts:89`, abstract `listen(): Promise<number>` at `:128`). Package names uniform: `@blokjs/trigger-<kind>`.

**The shared-Hono bootstrap.** `triggers/http/src/index.ts` is the `App` orchestrator. It constructs **one** `Hono<AppBindings>` (`:33`), hands it to `HttpTrigger`, then constructs four siblings — `WebSocketTrigger`, `SSETrigger`, `WebhookTrigger`, `McpTrigger` (`:34-38`) — each `new`'d with `(app, httpTrigger)`. All four share the HTTP trigger's `nodeMap` (`:42-47`). **Boot order is load-bearing** (`run()`, `:56-65`): the four siblings `.listen()` *first* to register pre-catch-all + server hooks on `HttpTrigger`, then `httpTrigger.listen()` fires those hooks, mounts the catch-all, and calls `serve()`. **All four are static `import` statements (`:2-5`) and hard `dependencies`.** That coupling is what S8 breaks.

**Mounted vs standalone split already exists.** `project.ts:426-432` computes `mountedOnHttp` (the `{sse, websocket, webhook, mcp}` subset that rides the HTTP app) and `spawnedTriggerConfigs` (everything else: `worker`, `cron`, `pubsub`, `grpc` — separate processes, own port + `startCmd`). Supervisord + env generation key off this (`generateTriggerSupervisordConfig` `:950`, `generateTriggerEnvVars` `:935`). **Standalone triggers already spawn cleanly via their own `index.ts` + supervisord stanza — they need zero `App`/runtime change from S8.** This is the crucial asymmetry: only the HTTP-mounted four are coupled.

**Config shape.** `TriggerConfig = { kind, label, port, entryPoint, startCmd }` (`runtime-setup.ts:60-66`). `ProjectConfig.triggers?: Record<string, TriggerConfig>` keyed by `kind` (`runtime-setup.ts:96`). Ports hardcoded in `TRIGGER_PORTS` (`runtime-setup.ts:879`). Note: `queue: 4005` lingers in the map (`:885`) though `queue` is a dead trigger with no `triggers/queue/` directory — `worker` superseded it.

**Observability descriptor — the template (D6/D7).** `ObservabilityModuleDescriptor` (`observability/descriptor.ts:49-81`): `id, label, description, dependencies[], envBlock, infraFiles[], composeServices[], packageDeps{}, scaffold?, setup?, verify?, validate?, cleanup?`. `REGISTRY` is a hardcoded `Record<id, descriptor>` (`:89`). The `add/remove/list/status` command group, dep resolver (`resolveWithDependencies` `:285`), fenced `.env.local` block, flat config map, and dependent-on-remove warning (`observability/remove.ts:40-44`) all work today — the proven pattern S7 generalizes.

**No `trigger` command exists.** `packages/cli/src/commands/` has `observability`, `runtime`, `nodes`, `migrate` — but no `trigger`.

## 3. Goals & non-goals

**Goals**
- `blokctl trigger add <kind>`, `remove <kind>`, `list [--json]`, `status [--json]` — mirroring `blokctl observability` 1:1 (D7: same kernel the create-time picker and a future MCP tool call).
- A `TriggerDescriptor` that **is** the S7 module-descriptor with one trigger-specific field (`mount`) — reusing `createTriggerConfig` / `TRIGGER_PORTS` for port/entryPoint/startCmd instead of re-declaring them.
- Make the four HTTP-mounted triggers (`sse`, `websocket`, `webhook`, `mcp`) **opt-in deps of a project**, not hard deps of `@blokjs/trigger-http` — pure-HTTP installs lean.
- Solve the bootstrap-HTTP problem: the shared `App` mounts only the HTTP-family triggers *enabled in config*, resolved at boot rather than statically imported.
- Keep `http` (and the existing common set) **free and default** — never gate a basic HTTP server.
- Backward compatibility: existing scaffolded projects (static `App` + hard deps) keep running untouched.

**Non-goals**
- A *remote* trigger registry / third-party triggers — S6/S9 territory. S8 ships a hardcoded `REGISTRY` exactly like observability. (Open seam in §10.5 so it can federate later without a rebuild.)
- Hot add/remove in a running process. `add` mutates files + config; a restart picks it up (same as observability/runtime).
- New trigger families. S8 makes the existing nine modular.
- Per-workflow trigger selection — workflows already declare `trigger: {...}`; S8 is project-level which-infra-is-installed.

## 4. Options & alternatives

### Option A — Thin CLI over the existing config block; static `App` unchanged
`blokctl trigger add/remove/list/status` reads/writes `ProjectConfig.triggers` and copies `src/triggers/<kind>/` files. Leaves the static orchestrator alone.
- **Pros**: ships in days; reuses everything; zero runtime change.
- **Cons**: **does not deliver lean install** — the HTTP project still hard-depends on four siblings and the static `App` `new`s all four regardless of config. `trigger remove sse` leaves a dangling import that fails to build. The single most concrete "keep common triggers free" win goes unmet.

### Option B — Config-driven HTTP-family mounting (recommended)
The generated `App` resolves `ProjectConfig.triggers` at boot and mounts only the enabled HTTP-family triggers. `@blokjs/trigger-http` drops its four sibling hard-deps; `trigger add webhook` installs `@blokjs/trigger-webhook` into the **project's** `package.json` and records it in config; the `App` loop mounts what config declares.
- **Pros**: real lean install (pure-HTTP carries only `@blokjs/trigger-http`). `add`/`remove` are real (package + config in/out, `App` honors it). Standalone triggers need no `App` change. Boot-order invariant preserved by mounting the enabled set *before* `httpTrigger.listen()`, exactly as today.
- **Cons**: touches the scaffolded `App` template → existing projects keep their static `App` (compat shim, §8). The build-tool reality of resolving an optional-but-enabled sibling at boot is the real engineering — see §7.3, where the draft's hand-wave is fixed.

### Option C — Full descriptor-driven runtime registry (every trigger self-registers, including standalone)
Generalize so `worker`/`cron`/etc. also register through a runtime `TriggerRegistry`; `App` becomes a generic loop over *all* triggers regardless of mount style.
- **Cons**: over-built. Standalone triggers already spawn cleanly via supervisord/`startCmd` (`project.ts:432`, `generateTriggerSupervisordConfig:950`). Folding two genuinely different lifecycles (in-process Hono mount vs separate OS process) into one loop conflates them for a uniformity nobody asked for. **Ponytail: the mounted/standalone split is real and correct — don't erase it.**

**Competitor reference.** n8n: triggers are just node types (ship in core, no install). Trigger.dev: webhooks are a roadmap *gap*. Windmill: Kafka/NATS triggers gated behind Enterprise — the wrong move per the dossier (paywalling reliability). `blokctl trigger add` with common triggers free already beats all three. The pattern to *take* is npm's optional-peer mechanism for a lean base install (Option B) — not anyone's trigger UX.

## 5. Recommendation & rationale

**Option B**, built on the S7 generalized descriptor.

Ponytail lens, walked:
- **Need it?** Yes — founder-requested, and lean-install is a measurable cost (four unused packages per HTTP project, including `ai`/`@ai-sdk/openai`-adjacent MCP weight).
- **Already in the codebase?** Almost all of it: `TriggerConfig`, `ProjectConfig.triggers`, `createTriggerConfig`, `TRIGGER_PORTS`, the mounted/standalone split, supervisord/env generators, and the entire observability `add/remove/list/status` machinery + dep resolver + fenced-env writer + dependent-warning. S8 is ~80% wiring existing parts into the S7 contract.
- **Genuinely new code** (kept minimal): (1) the `TriggerDescriptor` REGISTRY — *data*, one field richer than the observability descriptor; (2) the config-driven mount loop in the `App` scaffold template; (3) the `@blokjs/trigger-http` dependency reshuffle.

Why not A: leaves lean-install unmet — the concrete win. Why not C: erases a correct distinction. B is the higher rung that holds.

**Consistency with cross-cutting decisions.** D6: `TriggerDescriptor extends` the one shared S7 contract; triggers are its second consumer, proving the generalization. D7: the CLI command logic is the single kernel — the create-time picker (`project.ts`) and a future MCP `trigger_add` tool call the *same* `addTrigger()`. S7's cycle-detection + config/env transaction fix apply for free since S8 reuses `resolveWithDependencies` + the mutation helpers.

## 6. How it improves Blok

- **Lean install, kept free**: `blokctl create project --triggers http` ships *only* `@blokjs/trigger-http`. Adding webhook later is one command. Common triggers stay zero-cost.
- **AI assembles trigger infra**: an MCP `trigger_add` tool (S11) lets an agent wire "Stripe webhook + nightly cron" → two commands → project boots with both, no human file-editing. The modular-triggers half of "AI builds a backend in a day."
- **Honest inventory**: `blokctl trigger list --json` is the machine-readable "what does this project listen on?" — feeding the picker, Studio, and AI context.
- **Removal is real**: `trigger remove grpc` drops the package, config entry, supervisord stanza, and port reservation — no orphaned infra.

## 7. Architecture & design

### 7.1 `TriggerDescriptor` (specializes the S7 contract — adds ONE field)

```ts
// packages/cli/src/commands/trigger/descriptor.ts
import type { ModuleDescriptor } from "../../services/module-descriptor"; // S7

export type TriggerId =
  | "http" | "worker" | "cron" | "pubsub"
  | "sse" | "websocket" | "webhook" | "mcp" | "grpc";

export interface TriggerDescriptor extends ModuleDescriptor<TriggerId> {
  /** Where this trigger runs.
   *  "http"       → mounted on the shared Hono App (shares port 4000).
   *  "standalone" → its own OS process; port/entryPoint/startCmd come
   *                 from createTriggerConfig(id) — NOT re-declared here. */
  mount: "http" | "standalone";
  /** npm package added to the PROJECT on `add`. */
  pkg: `@blokjs/trigger-${TriggerId}`;
  // Inherited from S7 ModuleDescriptor:
  //   id, label, description, dependencies[],
  //   scaffold?, setup?, verify?, cleanup?, validate?
}
```

**Ponytail note on the draft's shape.** The draft added `port`, `entryPoint` to the descriptor. Both already come from `createTriggerConfig(id)` (`runtime-setup.ts:921`) and `TRIGGER_PORTS` (`:879`). Re-declaring them in the descriptor creates two sources of truth for a port that never differs. **Cut.** The descriptor carries only `mount` + `pkg`; the CLI calls `createTriggerConfig(id)` to materialize the config entry for standalone triggers, exactly as `project.ts:410` does today.

The mounted four (`sse`, `websocket`, `webhook`, `mcp`) carry `mount: "http"` + `dependencies: ["http"]` — the S7 dep resolver auto-installs `http` when you add a webhook, and S7 cycle-detection guards a malformed descriptor. Standalone triggers carry `mount: "standalone"`.

`REGISTRY: Record<TriggerId, TriggerDescriptor>` — hardcoded, like `observability/descriptor.ts:89`. `queue` is **absent**; `trigger add queue` errors with "use `worker`."

### 7.2 `.blok/config.json` trigger block (extend additively — minimal new fields)

The existing `triggers: Record<string, TriggerConfig>` (`runtime-setup.ts:96`) stays, keyed by `kind`. Add exactly **one** new field — `mount` — to `TriggerConfig`:

```jsonc
{
  "triggers": {
    "http":    { "kind": "http",    "mount": "http",       "port": 4000, "label": "HTTP Trigger", "entryPoint": "src/triggers/http/index.ts",    "startCmd": "..." },
    "webhook": { "kind": "webhook", "mount": "http",       "port": 4000, "label": "Webhook Trigger", "entryPoint": "src/triggers/webhook/index.ts", "startCmd": "..." },
    "cron":    { "kind": "cron",    "mount": "standalone", "port": 4004, "label": "Cron Trigger",    "entryPoint": "src/triggers/cron/index.ts",    "startCmd": "bun run src/triggers/cron/index.ts" }
  }
}
```

**Ponytail note on the draft's schema.** The draft added `enabled`, `addedAt`, `version`. Cut all three:
- `enabled` — **presence = enabled**, matching observability's convention (config key present ⇒ active; `remove` deletes the key). A separate boolean is dead flexibility unless we ever need "installed but off," which nobody asked for.
- `addedAt` / `version` — speculative provenance with no consumer in S8. When the registry (S6/S9) lands and version-pinning matters, add `version` then, with a real consumer. YAGNI.

`mount` is the only addition. Old configs (no `mount`) read fine: derive it from a `TRIGGER_MOUNT[kind]` static map at read time, persisting it on next write. **Persist-with-map-default** (Open Q §10.1) so config is self-describing for AI consumers without forcing a migration.

### 7.3 The config-driven `App` — solving bootstrap-HTTP **honestly**

This is the load-bearing change and where the draft hand-waved. The scaffolded `src/triggers/http/index.ts` constructor replaces four hardcoded sibling constructions with a config-driven loop. **But "just `await import(pkg)`" glosses three real build-tool problems. Addressing each:**

**Problem 1 — the `App` is built with `tsc`, run with `bun`.** A bare `await import("@blokjs/trigger-webhook")` against a package that isn't a dependency makes `tsc` fail typecheck ("Cannot find module") for *any* sibling not installed. Solution: the scaffold emits a **static registry object** mapping kind → a lazy importer, and the four importers are generated **only for the triggers actually installed** (the `trigger add` step writes/rewrites this small generated file, `src/triggers/http/_mounted.generated.ts`). The `App` imports from that generated file. So typecheck only ever sees importers for installed packages — no absent-module type errors, no bundler choke. This mirrors how compiled-runtime codegen shims are regenerated each `blokctl dev` (dossier §1: "codegen shim regenerated").

```ts
// src/triggers/http/_mounted.generated.ts  ← written/updated by `blokctl trigger add|remove`
// Only installed mounted triggers appear here.
export const MOUNTED = {
  websocket: () => import("@blokjs/trigger-websocket"),
  sse:       () => import("@blokjs/trigger-sse"),
} as const;
```

```ts
// scaffold template — replaces triggers/http/src/index.ts:33-47
import { MOUNTED } from "./_mounted.generated";

const app = new Hono<AppBindings>();
this.httpTrigger = new HttpTrigger(app);
const nodeMap = this.httpTrigger.getNodeMap();

for (const kind of Object.keys(MOUNTED) as (keyof typeof MOUNTED)[]) {
  const Trigger = (await MOUNTED[kind]()).default;
  const t = new Trigger(app, this.httpTrigger);
  t.setNodeMap(nodeMap);
  this.mounted.push(t);
}
```

```ts
// run() — boot-order invariant preserved (mirrors index.ts:56-65)
for (const t of this.mounted) await t.listen();  // siblings register hooks FIRST
await this.httpTrigger.listen();                  // fires preCatchAllHooks, mounts catch-all, serve()
```

**Problem 2 — config/generated-file drift.** The generated `_mounted.generated.ts` is the runtime source of truth; `.blok/config.json` is the CLI's record. If they diverge (hand-edited config, partial `add`), boot mounts the wrong set. Solution: `trigger add|remove` writes **both atomically** via the S7 transaction fix (env/config/files wrapped or ordered), and `trigger status` (§7.5) reports drift (config says webhook, generated file omits it → "run `blokctl trigger add webhook`"). The generated file — not config — drives boot, so a missing package can never throw `MODULE_NOT_FOUND` at runtime; it's simply absent from `MOUNTED`.

**Problem 3 — the constructor is `async` now (`await import`).** The current constructor is sync; dynamic import forces async. Solution: move sibling construction out of the `constructor` into an `async init()` called at the top of `run()` (constructors can't `await`). This is a mechanical refactor of `index.ts`, not a behavior change — `run()` already wraps everything in a tracer span.

`@blokjs/trigger-http/package.json`: move `trigger-{mcp,sse,webhook,websocket}` from `dependencies` to `peerDependencies` with `peerDependenciesMeta.<pkg>.optional = true`. The **project** declares the concrete dep when `trigger add` runs. Standalone triggers (`worker/cron/pubsub/grpc`) are unaffected — they were never deps of `trigger-http`.

### 7.4 CLI commands (mirror observability 1:1)

```
blokctl trigger add <kind> [-d <dir>] [--force]
blokctl trigger remove <kind> [-d <dir>] [--yes]
blokctl trigger list [-d <dir>] [--json]
blokctl trigger status [-d <dir>] [--json]
```

(Dropped the draft's `--port` flag on `add` — port comes from `TRIGGER_PORTS`; a per-add override is speculative until two standalone triggers actually collide, which the conflict check below catches. YAGNI.)

`commands/trigger/index.ts` is a parent `Command` with four subcommands — copy `commands/observability/index.ts` structure, swap REGISTRY/labels. `add` flow (reusing S7 helpers): resolve project root → S7 `resolveWithDependencies(kind)` (pulls `http` for mounted) → `validate()` → install `pkg` into project `package.json` → for mounted: regenerate `src/triggers/http/_mounted.generated.ts`; for standalone: `scaffold()` copies `src/triggers/<kind>/` + writes supervisord stanza via `generateTriggerSupervisordConfig` → `setup()` → write `config.triggers[kind] = { ...createTriggerConfig(kind), mount }` via a pure `withTrigger()` mutation (mirror `withObservabilityModule`) → standalone port-conflict check against other `config.triggers[*].port`. `remove` runs `cleanup()`, drops package + config entry + supervisord stanza + (mounted) regenerates the importer file. `status` runs each enabled descriptor's `verify()`.

### 7.5 `verify()` per trigger — scoped honestly (powers `status`)

The draft over-promised CLI-host broker pings. Scope to what the CLI host can actually observe:

- `http` / mounted (`sse`/`websocket`/`webhook`/`mcp`): `GET http://localhost:<port>/health` → ok on 2xx. Mounted triggers share the HTTP port, so one probe covers the family; `verify()` additionally confirms the kind appears in `_mounted.generated.ts`.
- `cron`: scheduler process alive (supervisord status / PID file) — local, reliable.
- `grpc`: port listening locally.
- `worker` / `pubsub`: **best-effort only.** The broker (NATS/Redis) may be reachable from the worker host but not the CLI host. `verify()` reports `{ ok: false, message: "broker reachability not checked from CLI host" }` as an explicit *unknown*, not a false negative. (Open Q §10.3.) Do **not** build a broker-ping path that lies.

Each returns the S7 `{ ok, message, dashboardUrl? }` shape (`observability/descriptor.ts:76`).

## 8. Compatibility, migration & risks

**Backward-compat stance (hybrid appetite).** Fully compatible for existing projects. An old scaffolded `App` keeps its static sibling imports + hard deps and boots exactly as before; `trigger list` reads its config and reports correctly. The config-driven `App` ships only in *new* `create project` scaffolds. **No workflow `.ts`/JSON changes** — workflows declare `trigger: {...}` per-workflow and are untouched; S8 is project-level infra, not authoring syntax.

**On migrating existing projects — the draft proposed `blokctl trigger migrate`; demote it.** Rewriting a user's `src/triggers/http/index.ts` (which they may have customized — added middleware, OTel spans, custom serve options) into the generated-importer shape is risky AST surgery for a benefit (lean install on an *already-built* project) that's marginal: the four packages are already installed and working. **Ponytail: existing projects already work; the lean-install win is for new projects.** So:
- M3 (`trigger migrate`) is **best-effort and opt-in**, not a shipped guarantee. It detects a verbatim-template static `App`, backs it up, and rewrites only if the file is byte-identical to the known old template; if the user customized it, it prints manual instructions and a diff and stops. **Do not attempt AST surgery on a modified `App`.**
- For most existing projects the honest answer is: "you keep four sibling packages; new projects don't. Run `trigger migrate` if you want the lean layout and haven't customized `index.ts`." State this plainly rather than promising a clean auto-migration.

**Failure modes & guards.**
- *Mounted trigger enabled in config but package absent* → cannot happen at runtime: the generated importer file (§7.3) only lists installed packages, so boot can't `MODULE_NOT_FOUND`. `trigger status` surfaces the config/file drift with a steering message.
- *Port collision* between standalone triggers → `add` validates the default port against existing `config.triggers[*].port` + `TRIGGER_PORTS`, rejects naming the conflicting kind. (Mounted triggers share 4000 — no intra-family conflict.)
- *Boot-order regression* — the biggest runtime risk; static order is load-bearing (`index.ts:56-65`). The loop mounts + `.listen()`s all siblings before `httpTrigger.listen()`. Guard with a runner test asserting `preCatchAllHooks` register before the catch-all mounts (model: existing `TriggerBaseHmr`/operational-parity tests).
- *Config/env transaction gap* — inherited S7 fix (wrap config + env + generated-file writes, or order env-first). S8 gets it for free.
- *Removing a trigger a workflow still declares* → `remove` greps `src/workflows/` for `trigger:.*<kind>` and **warns, doesn't block** — operator's call, matching `observability/remove.ts:40-44`.

## 9. Phased implementation plan

**M1 — CLI + descriptor, no runtime change (smallest shippable).** `commands/trigger/{index,add,remove,list,status,descriptor}.ts` on S7. Hardcoded `REGISTRY` for all nine (minus `queue`). `add/remove/list/status` read/write the *existing* `triggers` config block + project `package.json`. Static `App` untouched. Delivers CLI UX + inventory immediately; lean-install not yet solved. Purely additive — ship behind nothing.

**M2 — Lean install for new projects.** New `create project` scaffolds the config-driven `App` + generated importer file; `@blokjs/trigger-http` peer-dep reshuffle. Pure-HTTP installs lean. `trigger add <mounted>` regenerates the importer + adds the project dep. Runner test for boot-order invariant. **This is the real engineering (§7.3) — budget for the `async init()` refactor + generated-file plumbing.**

**M3 — `trigger migrate` (best-effort, opt-in).** Rewrites a *verbatim-template* static `App` only; refuses on customized files with manual instructions. Idempotent, backed-up, diff-printed. Explicitly not a clean-auto-migration promise (§8).

**M4 — `verify()` + `status`.** Scoped health probes (§7.5); `status --json` for Studio + AI. Worker/pubsub report `unknown` honestly.

**M5 (post-S11) — MCP `trigger_add`/`trigger_list`** over the identical `addTrigger()` kernel (D7). Out of S8 scope; noted as handoff.

## 10. Open questions

1. **`mount` field source of truth.** Persist in config (explicit, AI-readable, drift-resistant) vs. always derive from `TRIGGER_MOUNT[kind]` (DRY)? **Recommendation: persist, default-from-map on read** — config self-describes for AI consumers, no migration forced. Confirm.
2. **`trigger remove http`.** HTTP is the bootstrap server for the whole mounted family. Forbid outright, or cascade-remove all `mount: "http"` triggers with confirmation? **Recommendation: forbid unless `--force`; if forced, require mounted siblings be removed first** (S7 dependent-check — they have `dependencies: ["http"]`).
3. **Standalone health depth in `status`.** A NATS/Redis ping needs broker reachability from the CLI host, which may differ from the worker's. **Recommendation: process-alive check + explicit `unknown` for broker reachability** (§7.5). Accept, or require operators run `status` from the worker host?
4. **Is `trigger migrate` (M3) worth building at all?** Given existing projects already work and customization makes auto-rewrite unsafe, the honest fallback is documentation. Confirm appetite — I lean toward shipping M1/M2/M4 and making M3 a thin "detect + instruct" tool rather than a rewriter.
5. **Third-party-trigger seam.** When S6/S9 lands, does `trigger add @acme/trigger-kafka` resolve through the same descriptor contract? The `TriggerDescriptor` shape is data, so federation is structurally possible — but a third-party trigger that wants to *mount on HTTP* must conform to the `(app, httpTrigger)` constructor + hook-registration contract, which is currently an undocumented internal convention. **Confirm the seam: M1's REGISTRY should be a lookup function (`getTriggerDescriptor(id)`) not a bare object literal, so it can fall through to the registry later without a rebuild** — and S9 must publish the mounted-trigger constructor contract as a real interface.

---

**Key file refs grounding this spec:** `triggers/http/src/index.ts:2-5,33-47,56-65` (static sibling imports + shared-Hono bootstrap + load-bearing boot order); `triggers/http/package.json` (four sibling hard-deps at `^0.7.0` — the lean-install problem); `core/runner/src/TriggerBase.ts:89,128` (abstract `listen()`); `packages/cli/src/services/runtime-setup.ts:60-66,96,879-885,921,935,950` (`TriggerConfig`, `ProjectConfig.triggers`, `TRIGGER_PORTS` incl. dead `queue:4005`, `createTriggerConfig`, env/supervisord generators); `packages/cli/src/commands/create/project.ts:410,426-432` (mounted-vs-standalone split + `createTriggerConfig` use); `packages/cli/src/commands/observability/descriptor.ts:49-81,89,285` (descriptor template + REGISTRY + dep resolver S7 generalizes); `packages/cli/src/commands/observability/remove.ts:40-44` (dependent-on-remove warning S8 reuses).

---

**What changed from the draft (review summary):** Corrected trigger count 8→9 (dossier undercounts). Fixed the one real hand-wave — §7.3 now addresses the `tsc`/`bun` build reality with a generated-importer file (no absent-module typecheck failures, no runtime `MODULE_NOT_FOUND`) and the sync→async constructor refactor the dynamic-import forces. Cut descriptor bloat (`port`/`entryPoint` → reuse `createTriggerConfig`) and config bloat (`enabled`/`addedAt`/`version` → presence=enabled, YAGNI the rest) and the `--port` flag. Demoted `trigger migrate` to best-effort/opt-in and stated honestly that customized `App` files can't be auto-rewritten — the lean-install win is for new projects, not a clean retrofit promise. Scoped `verify()` to report worker/pubsub broker reachability as explicit `unknown` rather than lying. Hardened the third-party seam (Open Q 5): REGISTRY as a lookup fn + the mounted-trigger constructor contract must be published in S9.
