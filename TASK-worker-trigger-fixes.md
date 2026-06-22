# TASK — Worker Trigger: two DX bugs + fixes

> **Found:** 2026-06-17, while building a real worker workflow on a fresh `blokctl create project --triggers http,worker` backend (the "Blok Sites" M2 milestone).
> **Scope:** two concrete, reproducible problems in the **worker** path, each of which contradicts the framework's *own* documentation. Both block a first-run worker. Plus secondary observations.
> **TL;DR:** (1) a freshly scaffolded worker hardcodes a Kafka adapter and crashes with no broker running; (2) worker workflow names/keys can't contain `.` even though the docs recommend dotted `domain.action` names.

---

## Problem 1 — A scaffolded worker hardcodes a Kafka adapter → crashes out of the box

### Symptom
A fresh project created with the worker trigger, run with `bun run src/triggers/worker/index.ts` (no broker running), dies on boot:

```
ERROR kafkajs [Connection] Connection error:  broker=localhost:9092 clientId=blok-queue-trigger
...(6 retries)...
error  Failed to start worker trigger: [blok][kafka] connect failed: Connection error: . Install kafkajs as a peer dependency
error  [blok][crash-autoflip] unhandledRejection — at KafkaAdapter.js:71 → resolveAdapterForWorkflow → WorkerTrigger.listen
```

### Repro
```bash
blokctl create project --name backend --triggers http,worker --runtimes node   # no --queue-provider
cd backend && bun run src/triggers/worker/index.ts      # crashes — Kafka not running
```

### Root cause
The project scaffold injects a **Kafka** adapter into the generated `WorkerServer` regardless of whether the user has Kafka. The generated file:

```ts
// src/triggers/worker/runner/WorkerServer.ts  (generated)
import { KafkaAdapter, WorkerTrigger } from "@blokjs/trigger-worker";
export default class WorkerServer extends WorkerTrigger {
  protected adapter = new KafkaAdapter({
    brokers: (process.env.KAFKA_BROKERS || "localhost:9092").split(","),
    clientId: process.env.KAFKA_CLIENT_ID || "blok-queue-trigger",
  });
  ...
}
```

Emitted by the scaffold's adapter-injection in `packages/cli/src/commands/create/project.ts:2027-2078` (the `WorkerTrigger`-class regex replaces `protected adapter = new <X>(...)` with the chosen provider's adapter; the **worker provider defaults to Kafka** — there is no `--worker-provider` flag, and the `--queue-provider` default is `kafka`). The scaffold also writes `KAFKA_*` into `.env.local`, reinforcing the assumption.

### Why this is wrong (two compounding issues)
1. **First-run failure.** A brand-new worker project cannot boot without standing up Kafka — the worst possible default for a "create project and go" DX. The dev-friendly `InMemoryAdapter` exists for exactly this and ships with the package (no peer dep).
2. **It silently defeats the framework's own configuration surface.** Per `core/runner/CLAUDE.md` and the `WorkerTriggerOptsSchema`, the adapter is meant to be chosen by per-workflow `provider` (default `BLOK_WORKER_ADAPTER` → `in-memory`). But a subclass `this.adapter` field takes **precedence** over both. So a user who sets `BLOK_WORKER_ADAPTER=in-memory` or `trigger.worker.provider: "in-memory"` sees **no effect** — the hardcoded `this.adapter` wins. This is the `this.adapter`-precedence footgun the docs warn about, shipped *by default* in the scaffold.

### Severity
**High (first-run DX blocker).** Every worker project fails on first run unless the user happens to have Kafka, and the documented `provider`/env config appears broken.

### Correct fix
**Preferred — scaffold WITHOUT a hardcoded `this.adapter`.** Let the framework's per-workflow `provider` + `BLOK_WORKER_ADAPTER` resolution (default `in-memory`) take effect — the intended path. Emit a commented example instead of an active assignment:

```ts
export default class WorkerServer extends WorkerTrigger {
  // The adapter is chosen per-workflow via `trigger.worker.provider`, falling back
  // to BLOK_WORKER_ADAPTER, then `in-memory`. To force one for every workflow,
  // uncomment ONE (note: this overrides per-workflow `provider`):
  //   protected adapter = new NATSWorkerAdapter({ servers: (process.env.NATS_SERVERS || "localhost:4222").split(",") });
  //   protected adapter = new BullMQAdapter({ host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT) });
  protected nodes = nodes;
  protected workflows = workflows;
}
```

**Acceptable alternative — default to `InMemoryAdapter`** with an explicit "// dev only — switch for prod" comment. Boots clean, zero deps; but still overrides `provider`, so it's strictly worse than omitting.

Either way: (a) only inject a broker adapter when the user **explicitly** passes a provider flag, and (b) don't write `KAFKA_*` into `.env.local` unless Kafka was chosen. Fix at `packages/cli/src/commands/create/project.ts:2027-2078`.

---

## Problem 2 — Worker workflow names/keys cannot contain `.` (`File type not supported`)

### Symptom
A worker workflow named (or registered in `Workflows.ts` under a key) with a dot — e.g. the **recommended** `publish.site` — fails at job-processing time:

```
error  Job pub-5-001 failed (attempt 1/4), retrying ...: File type not supported: site
```

### Repro
```ts
// src/workflows/worker/publish-site.ts
export default workflow({ name: "publish.site", version: "1.0.0",
  trigger: { worker: { queue: "publish" } }, steps: [/* ... */] });
// src/Workflows.ts
const workflows = { "publish.site": PublishSite };   // dotted KEY also triggers it
```
Dispatch a job to `publish` → every attempt throws `File type not supported: site`. Renaming to `publish-site` (name **and** map key) fixes it.

### Root cause
The worker's workflow-config resolution reaches the **file-based** resolver `LocalStorage.get()`, which assumes any `.` in the identifier means `filename.extension`:

```ts
// core/runner/src/LocalStorage.ts:20-31
if (name_fixed.indexOf(".") !== -1) {
  const parts = name.split(".");
  workflowFileType = parts[parts.length - 1].toLowerCase();   // "site"
  if (!this.fileTypes.includes(workflowFileType)) {           // ["json","yaml","xml","toml"]
    throw new Error(`File type not supported: ${workflowFileType}`);   // ← throws
  }
  name_fixed = parts.slice(0, -1).join(".");
}
```

So `publish.site` → tail `site` → not a known file type → throw. The workflow is already loaded into the worker's in-memory map (`WorkerTrigger.loadWorkflows()`), yet the run path still passes the dotted identifier through the file-extension parser.

### Why this is wrong (an inconsistency with the framework's own guidance)
- The **HTTP** trigger resolves workflows via the in-memory `WorkflowRegistry`/map **by name**, so dotted names work — `pages.get`, `health.ping` mount and serve fine over `/__blok/rpc/<name>`.
- The project scaffold's `CLAUDE.md` **recommends** dotted names: *"Use a dotted `domain.action` convention (`countries.list`, `users.create`) so the typed client and `blokctl gen app-types` expose clean nested accessors."*
- Yet the **worker** path breaks on exactly that convention. A user following the docs hits a confusing `File type not supported: site` with no hint that the dot is the problem.

### Severity
**Medium–High.** Not a crash-on-boot, but it silently fails every job for any worker workflow that follows the recommended naming convention, with an error message that points nowhere near the real cause.

### Correct fix
**Preferred — resolve worker workflows from the in-memory registry, not the file resolver.** The worker already has every workflow in its loaded map; the run path should look the workflow up there (the way the HTTP trigger does via `WorkflowRegistry`) and only fall back to `LocalStorage` for genuinely file-based (json/yaml/...) workflows. Dotted names then "just work" everywhere.

**Targeted alternative — make `LocalStorage.get()` not throw on a non-file-extension dot.** Treat the dot as part of the name when the tail isn't a known file type, instead of throwing:

```ts
if (name_fixed.indexOf(".") !== -1) {
  const parts = name.split(".");
  const maybeExt = parts[parts.length - 1].toLowerCase();
  if (this.fileTypes.includes(maybeExt)) {
    workflowFileType = maybeExt;
    name_fixed = parts.slice(0, -1).join(".");
  }
  // else: the dot is part of the workflow NAME (e.g. "publish.site") — leave name_fixed
  // intact and use the default/declared fileType; let the lookup fall through to the
  // in-memory registry when no matching file exists.
}
```

This is backward-compatible (real file paths like `users/list.json` still resolve) and unblocks the recommended dotted convention for file-based workflows too.

**Stopgap (docs only, not a real fix):** document that worker workflow names **and** `Workflows.ts` keys must be dot-free. This contradicts the recommended convention, so treat it as a temporary mitigation, not the resolution.

---

## Secondary observations (lower priority)

- **Noisy Kafka failure.** Problem 1 emits ~6 escalating-backoff connection errors over several seconds before the final `connect failed`. For a fail-fast dev experience, a missing broker should fail quickly with a single clear message ("Kafka not reachable at localhost:9092 — set a `provider` or start a broker").
- **In-memory adapter is per-process (by design).** Dispatch and consume must share a process (an out-of-process `WorkerTrigger.dispatch()` won't reach a separately-running consumer's in-memory queue). This is correct for a dev/test adapter, but the limitation deserves an explicit note next to `InMemoryAdapter`, since it's surprising when testing dispatch→consume.
- **`@blokjs/trigger-worker` isn't in the default `build` set.** The root `build` script builds `shared/helper/runner/api-call/if-else/...` but not the trigger packages, so a `--local`-scaffolded worker needs an extra `bun run --filter @blokjs/trigger-worker build` before it can boot (the HTTP runner is copied as local source; the worker server imports the package). Consider adding the trigger packages to `build`, or copying the worker runner as local source like the HTTP one.

---

## Evidence / verified against source

| Claim | Source |
|---|---|
| Worker scaffold hardcodes `new KafkaAdapter(...)` | generated `src/triggers/worker/runner/WorkerServer.ts`; template at `packages/cli/src/commands/create/project.ts:2027-2078` |
| `this.adapter` overrides `provider` / `BLOK_WORKER_ADAPTER` | `core/runner/CLAUDE.md` (worker provider-precedence note); `WorkerTriggerOptsSchema` `provider` field |
| Dotted identifier → `File type not supported` | `core/runner/src/LocalStorage.ts:20-31` |
| HTTP path handles dotted names | `triggers/http` resolves via `WorkflowRegistry` by name (`pages.get`/`health.ping` serve correctly) |
| Dotted-name convention is recommended | scaffold `CLAUDE.md` "Workflow Naming" |

## Suggested priority
1. **Problem 1** — P1 (first-run DX blocker). Smallest, highest-impact fix: stop hardcoding Kafka in the scaffold.
2. **Problem 2** — P2 (correctness/consistency). Fix `LocalStorage.get()` (or unify worker resolution on the registry) so the recommended dotted convention works in the worker path.
