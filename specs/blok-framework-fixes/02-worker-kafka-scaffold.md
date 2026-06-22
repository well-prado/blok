# Bug 02 — Scaffolded worker hardcodes a Kafka adapter and crashes out of the box

**Severity:** High · **Area:** CLI scaffold (`blokctl create project`) / worker trigger · **Status:** Proposed fix (awaiting approval)

## TL;DR
A fresh `blokctl create project --triggers http,worker` writes a generated `WorkerServer.ts` with a hardcoded `protected adapter = new KafkaAdapter(...)` and a `KAFKA_*` block in `.env.local`, because the queue/worker provider silently defaults to `"kafka"` and there is no `--worker-provider` flag. With no broker running, `kafkajs` retries then throws inside `listen()`, the crash-autoflip handler catches the `unhandledRejection`, and the process dies on boot. Worse, the subclass `this.adapter` field is the highest-precedence winner in `resolveAdapterForWorkflow`, so it silently overrides the documented per-workflow `provider` + `BLOK_WORKER_ADAPTER` resolution (which would default to the zero-infra in-memory adapter) — making the framework's own config surface appear broken. The fix is CLI-only: stop emitting an active `this.adapter` by default and only inject a broker adapter (plus its env/deps) when the user explicitly chose a provider.

## Symptom
A brand-new worker project, started with no broker running, crashes during boot:

```
ERROR kafkajs [Connection] Connection error:  broker=localhost:9092 clientId=blok-queue-trigger
...(6 retries)...
error  Failed to start worker trigger: [blok][kafka] connect failed: Connection error: . Install kafkajs as a peer dependency
error  [blok][crash-autoflip] unhandledRejection — at KafkaAdapter.js:71 → resolveAdapterForWorkflow → WorkerTrigger.listen
```

Separately (and more insidiously, because it produces no error): a developer who follows the docs and sets `BLOK_WORKER_ADAPTER=in-memory` or `trigger.worker.provider: "in-memory"` sees **no effect** — jobs still try to reach Kafka, because the hardcoded `this.adapter` wins before either is ever consulted.

## Reproduction
```bash
blokctl create project --name backend --triggers http,worker --runtimes node   # note: no --queue-provider
cd backend && bun run src/triggers/worker/index.ts                              # crashes — Kafka not running
```

The generated `src/triggers/worker/runner/WorkerServer.ts` contains:

```ts
import { KafkaAdapter, WorkerTrigger } from "@blokjs/trigger-worker";

export default class WorkerServer extends WorkerTrigger {
  protected adapter = new KafkaAdapter({
    brokers: (process.env.KAFKA_BROKERS || "localhost:9092").split(","),
    clientId: process.env.KAFKA_CLIENT_ID || "blok-queue-trigger",
  });
  // ...
}
```

To observe the override symptom instead of the crash: add `BLOK_WORKER_ADAPTER=in-memory` to `.env.local` and rerun — it is ignored.

## Root cause
The CLI project scaffold unconditionally rewrites the worker template's adapter assignment to the chosen `queueProvider`, which **defaults to `"kafka"`** with no opt-out flag. The generated subclass therefore always ships an active `this.adapter`. Two failures compound:

1. **First-run crash.** A broker adapter (Kafka by default — but even the template's own NATS default is not zero-infra) can't connect, the rejection escapes `listen()`, and the framework's own crash-autoflip `unhandledRejection` handler terminates the process.
2. **Silent config override.** `resolveAdapterForWorkflow` checks `this.adapter` *first* and returns immediately, never reaching the `provider` / `BLOK_WORKER_ADAPTER` / `in-memory` resolution. The framework code is correct and intentional (back-compat) — the scaffold defeats it by emitting that field by default.

| Claim | Evidence (file:line) |
|---|---|
| Worker/queue provider defaults to `"kafka"`; no `--worker-provider` flag exists | `packages/cli/src/commands/create/project.ts:71` (`opts.queueProvider \|\| "kafka"`, re-derived ~218) |
| For `pubsub`/`queue`/`worker` triggers the worker template is copied and `updateQueueProvider(...)` is invoked | `packages/cli/src/commands/create/project.ts:428-451` |
| `updateQueueProvider` regex-rewrites both the import and the class-body `protected adapter = new <X>({...});` to the chosen provider's init | `packages/cli/src/commands/create/project.ts:2025-2080` (Kafka init at 2026-2031, class-body replace at 2077-2080) |
| The on-disk template hardcodes an active `new NATSWorkerAdapter({...})` matching the replace regex | `triggers/worker/template/src/runner/WorkerServer.ts:27-30` |
| `this.adapter` is checked first and short-circuits the factory path | `triggers/worker/src/WorkerTrigger.ts:469-480` (`if (this.adapter) { ... return this.adapter; }`) |
| The factory's documented fallback chain is `provider → BLOK_WORKER_ADAPTER → "in-memory"` | `triggers/worker/src/adapters/factory.ts:36-41` |
| The crash-autoflip `unhandledRejection` handler kills the process on the `connect()` rejection during `listen()` | `triggers/worker/src/WorkerTrigger.ts:484-489`; reported trace in `TASK-worker-trigger-fixes.md:14-19` |
| The `on-message.ts` provider patch is dead code — the template ships `process-job.ts`, not `on-message.ts`, and no `provider:` field exists to rewrite | `packages/cli/src/commands/create/project.ts:2084-2090` |

## Why this is a framework design flaw
The precedence contract is deliberate and documented: WorkerTrigger.ts:454-468 explains that subclass `this.adapter` intentionally wins for pre-v0.7 back-compat, and factory.ts:31-41 documents the `provider → BLOK_WORKER_ADAPTER → in-memory` chain as the dev-friendly default path. The scaffold's mistake is choosing the *override* path as the default output for every new project, which (a) defaults to the single most infra-heavy adapter (Kafka) when the framework ships a zero-dependency in-memory adapter for exactly this case, and (b) shadows the very configuration surface `core/runner/CLAUDE.md` tells users to reach for. The result directly contradicts the "create project and go" DX promise and makes the documented `provider`/env knobs appear non-functional — this is a scaffold default decision, not a typo.

## Proposed fix (primary)
Make the CLI scaffold respect the framework's resolution chain by default. Track whether a worker/queue provider was **explicitly** chosen (a `--queue-provider` flag value, or an interactive prompt that actually ran and resolved). When **not** explicit, emit a commented adapter example (no active assignment) so `this.adapter` stays `undefined` and the factory path runs — defaulting to the in-memory adapter — and write `BLOK_WORKER_ADAPTER=in-memory` to `.env.local` instead of a broker block, and do **not** add broker deps like `kafkajs`. When the user **did** explicitly choose a broker, keep today's behavior exactly: inject the active adapter, its env block, and its dependency. This is the right layer because the framework code is already correct; only the scaffold's default output is wrong, and it preserves the intentional `this.adapter` override for anyone who wants it (uncomment-and-go).

Because the template would now ship a commented block with no active assignment, the explicit path must **insert** an assignment into the class header rather than **replace** an existing one.

```ts
// packages/cli/src/commands/create/project.ts — gate injection on explicit choice
function updateQueueProvider(triggerDestDir: string, provider: string, explicit: boolean): void {
  const serverPath = `${triggerDestDir}/runner/WorkerServer.ts`;
  if (!fsExtra.existsSync(serverPath)) return;
  let content = fsExtra.readFileSync(serverPath, "utf8");

  if (!explicit) {
    // No provider chosen → leave the commented example in place. `this.adapter`
    // stays undefined, so the factory resolves provider → BLOK_WORKER_ADAPTER → in-memory.
    fsExtra.writeFileSync(serverPath, content);
    return;
  }

  const config = adapterConfigs[provider];
  if (!config) return;
  content = content.replace(
    /import \{ WorkerTrigger \} from ["']@blokjs\/trigger-worker["'];/,
    `import { ${config.importName}, WorkerTrigger } from "@blokjs/trigger-worker";`,
  );
  // INSERT into the (now commented) class body — match the header, don't require an existing assignment.
  content = content.replace(
    /(export default class \w+ extends WorkerTrigger \{)/,
    `$1\n\tprotected adapter = ${config.init};`,
  );
  fsExtra.writeFileSync(serverPath, content);
  // (drop the dead on-message.ts / provider:"kafka" patch — no-op against the real template)
}
```

```ts
// triggers/worker/template/src/runner/WorkerServer.ts — default-safe template
export default class WorkerServer extends WorkerTrigger {
  // Adapter is chosen per-workflow via `trigger.worker.provider`, falling back to
  // BLOK_WORKER_ADAPTER, then `in-memory`. To force ONE for every workflow,
  // uncomment one (note: this OVERRIDES per-workflow `provider`):
  //   protected adapter = new NATSWorkerAdapter({ servers: (process.env.NATS_SERVERS || "localhost:4222").split(",") });
  //   protected adapter = new BullMQAdapter({ connection: { host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT) } });
  protected nodes: Record<string, import("@blokjs/runner").BlokService<unknown>> = nodes;
  protected workflows: Record<string, import("@blokjs/helper").HelperResponse> = workflows;
}
```

**Files to change**
- [ ] `packages/cli/src/commands/create/project.ts:64-71, 215-219` — thread an `explicitQueueProvider` boolean (`Boolean(opts.queueProvider)` for non-interactive; `true` only when the interactive prompt actually ran and resolved). Keep `queueProvider` defaulting to `"kafka"` only for the now-gated broker blocks.
- [ ] `packages/cli/src/commands/create/project.ts:2019-2091` (call site 451) — change `updateQueueProvider` to take `explicit`; when not explicit leave the commented block, when explicit insert (not replace) the active assignment. Delete the dead `on-message.ts` patch at 2084-2090.
- [ ] `packages/cli/src/commands/create/project.ts:946-950, 2131-2182` — gate the `.env` block on explicit choice; default to `BLOK_WORKER_ADAPTER=in-memory` (with a `# dev default — set a provider + BLOK_WORKER_ADAPTER for prod` comment) instead of `KAFKA_*`.
- [ ] `packages/cli/src/commands/create/project.ts:2096-2126` (`getProviderDependencies`) — only add broker deps (`kafkajs`, etc.) when `explicit`.
- [ ] `packages/cli/src/commands/create/project.ts:1080-1097` — add a kafka branch + a generic "in-memory is per-process; switch to a broker for prod" note so the default path prints guidance (optional but closes the "no hint on the default" gap).
- [ ] `triggers/worker/template/src/runner/WorkerServer.ts:27-34` — replace the active NATS assignment with the commented resolution-tier block, so the no-provider scaffold is a no-op and `--local`/direct-copy consumers also boot on in-memory.
- [ ] `triggers/worker/src/WorkerTrigger.ts:469-480` (optional, non-behavioral) — emit a one-time warning when `this.adapter` is set, surfacing the precedence footgun if a user re-introduces a hardcoded adapter.

## Alternatives considered
| Option | Trade-off | Verdict |
|---|---|---|
| Default the scaffold to an active `new InMemoryAdapter()` with a "// dev only" comment | Boots clean with zero deps and is trivial to implement, but still sets `this.adapter`, so it continues to override per-workflow `provider`/`BLOK_WORKER_ADAPTER` — a later `provider: "nats"` silently does nothing until the line is deleted. Preserves the precedence footgun. | Acceptable fallback if the commented approach is deemed too clever; strictly worse than omitting the assignment |
| Invert framework precedence so `provider`/`BLOK_WORKER_ADAPTER` win over `this.adapter` | Fixes the override symptom centrally, but breaks the deliberate, documented back-compat contract (WorkerTrigger.ts:454-468) and silently changes behavior for every existing subclass that sets `this.adapter` on purpose. High blast radius for a CLI-template bug. | Reject — wrong layer; changes a deliberate framework contract to paper over a scaffold default |
| Add a real `--worker-provider` flag defaulting to `in-memory`, separate from `--queue-provider`'s kafka default | Cleanly separates worker from pubsub-queue semantics and gives a zero-infra default, but adds public CLI surface (help/docs/prompts) and still needs the "don't hardcode `this.adapter` unless chosen" logic to avoid the footgun. | Good complementary follow-up worth doing for clarity — combine with the primary fix, not instead of it |
| Docs-only: tell users to delete the hardcoded adapter or start a broker | Zero code change, but leaves every fresh worker crashing on boot and the config appearing broken — contradicts the "create project and go" promise. | Reject as a fix (fine as an interim note) |

## Tests
- `packages/cli/tests/commands/create/worker-scaffold.test.ts` — NEW: with `explicit=false`, the generated `WorkerServer.ts` contains **no** active `protected adapter = new` assignment (only a commented example) and still imports/extends `WorkerTrigger`; with `explicit=true, provider="nats"` it contains exactly one active `protected adapter = new NATSWorkerAdapter(`.
- `packages/cli/tests/commands/create/worker-scaffold.test.ts` — `.env.local` gating: a worker scaffold with no `--queue-provider` writes `BLOK_WORKER_ADAPTER=in-memory` and **no** `KAFKA_BROKERS=` line; with `--queue-provider kafka` it writes the `KAFKA_*` block.
- `packages/cli/tests/commands/create/worker-scaffold.test.ts` — `getProviderDependencies`: a worker scaffold with no explicit provider does **not** add `kafkajs`; with explicit `kafka` it does.
- `packages/cli/tests/commands/create/project-non-interactive.test.ts` — `createProject({ name, triggers: "http,worker" })` (no queue-provider) resolves without throwing AND the written `src/triggers/worker/runner/WorkerServer.ts` has no active `this.adapter` (regex assertion in a temp dir).
- `triggers/worker/src/adapters/factory.test.ts` — regression-guard for the path the scaffold now relies on: `resolveProvider(undefined)` with no env yields `in-memory`; `BLOK_WORKER_ADAPTER=nats` yields `nats`; `createWorkerAdapter("in-memory")` returns an `InMemoryAdapter`. Confirms a no-`this.adapter` subclass boots on in-memory.

## Edge cases & backward compatibility
- **Explicit detection, interactive vs non-interactive.** An interactive run that selects a `queue` trigger and picks a provider IS explicit (inject adapter + broker env). A worker-only interactive run never prompts — the prompt gate is `results.triggers?.includes("queue")` (project.ts:184) — so it must be treated as NOT explicit and default to in-memory. Decide whether to extend the gate to `worker` or leave worker implicitly in-memory (see open questions).
- **Replace → insert.** The current class-body regex (project.ts:2078) *requires* an existing `protected adapter = new \w+({...});` to replace. Once the template ships only a commented block, the explicit path must switch to insert-into-class-header, or it silently no-ops and leaves NO adapter even when the user chose one.
- **`queue` alias.** `--triggers http,queue` hits the same template and `updateQueueProvider`; the fix must cover the literal `queue` keyword, not just `worker`.
- **`--examples` already writes `BLOK_WORKER_ADAPTER=in-memory`** (project.ts:986) — ensure the new default-env logic doesn't write it twice or conflict.
- **Legacy "broker for every workflow" pattern.** A user who genuinely wants a single broker still can: the commented examples are uncomment-and-go, and the explicit `--queue-provider` path still injects an active adapter. The framework precedence is unchanged, so existing subclasses that set `this.adapter` behave exactly as before.
- **Existing generated projects are unaffected** — this changes only newly scaffolded output; no runtime/framework behavior changes for current users.
- **Template change could surprise `--local`/direct-copy consumers** expecting NATS, but in-memory is strictly more boot-safe — note it in the worker template/CHANGELOG.
- **Dropping `kafkajs` from default deps** means a user who later uncomments a `KafkaAdapter` example must `npm install kafkajs` — document the peer dep in the commented block.
- **Out of scope:** `--local` worker scaffolds import `@blokjs/trigger-worker` via a `file:` link whose `dist/` may not exist (root `build` doesn't build trigger packages). In-memory default helps boot but the package still must be built — worth a doc note, not part of this fix.

## Effort & risk
Small-to-medium, CLI-localized. Core change is ~30-60 lines in `packages/cli/src/commands/create/project.ts` (thread `explicitQueueProvider`, branch `updateQueueProvider`, gate env + deps, remove the dead patch, rework the class-body regex to insert-on-explicit), plus a one-line worker template change and a handful of Vitest cases. No framework/runtime changes are required for the primary fix — the optional `WorkerTrigger` warning and a `--worker-provider` flag are separable follow-ups. Blast radius is confined to newly scaffolded projects; existing projects and the framework's runtime precedence are untouched. Roughly half a day including tests.

## Open questions for reviewer
- **Worker-only prompt behavior.** Should worker-only interactive runs (selecting `worker` but not `queue`) prompt for a provider at all, or always default to in-memory? The prompt currently fires only for `queue` (project.ts:184). Recommend treating worker as implicit-in-memory unless we add `--worker-provider`.
- **Default env line.** Write `BLOK_WORKER_ADAPTER=in-memory` explicitly, or write nothing and rely on the implicit in-memory fallback? Recommend explicit-with-comment for self-documentation.
- **`--worker-provider` flag now or later?** The minimal bug fix doesn't require it; landing it now is a clarity win but enlarges scope.
- **Template change vs CLI-only.** Ship the commented-block default in the template (helps `--local`/direct-copy consumers and makes the no-provider scaffold a no-op), or keep an active NATS default and rely solely on the CLI rewrite? Recommend changing the template, accepting that the explicit path must then insert rather than replace.