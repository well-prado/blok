# Bug 03 — Worker workflow names containing a dot throw "File type not supported"

**Severity:** High · **Area:** Worker trigger / workflow loading (`@blokjs/runner`) · **Status:** Proposed fix (awaiting approval)

## TL;DR
A worker workflow whose name (or `Workflows.ts` map key) contains a dot — for example the framework's own recommended `publish.site` `domain.action` convention — fails **every** job with `File type not supported: site`. The worker run path needlessly re-resolves the workflow from disk via `LocalStorage.get()`, whose filename heuristic mistakes the dotted *name* for a `filename.extension` and throws before it ever reaches the in-memory fallback. The fix is to make the worker pass the already-loaded workflow object as the `preloaded` argument to `Configuration.init`, exactly as the HTTP trigger already does — which also removes a wasteful disk read per job.

## Symptom
A worker workflow with a dotted name or map key never processes a single job. Each delivery fails at config-init time with:

```
File type not supported: site
```

The same workflow logic works fine if renamed without a dot (e.g. `publish-site`), which makes the failure look like a mysterious naming taboo rather than a resolution bug.

## Reproduction
1. Define a worker workflow registered under a dotted key/name following the documented `domain.action` convention:

```ts
// Workflows.ts (compiled map) — key is "publish.site"
"publish.site": Workflow({ name: "publish.site", version: "1.0.0" })
  .addTrigger("worker", { queue: "publish" })
  .addStep({ name: "process", node: "publish-handler", type: "module",
             inputs: { payload: "js/ctx.request.body" } }),
```

2. Start the worker trigger and dispatch any job to the `publish` queue.
3. The job fails immediately with `File type not supported: site`. No step ever runs.

The dot does not need to be in a file path — a dotted in-memory **name** alone is sufficient to trigger it, because that name string is what gets handed to the disk resolver.

## Root cause
`WorkerTrigger.handleJob` initializes the per-job configuration by calling `Configuration.init` with only **two** arguments — the dotted identifier string and the nodeMap — and **no** `preloaded` object:

```ts
// WorkerTrigger.ts:553
await this.configuration.init(workflow.path, this.nodeMap);
```

Because `preloaded` is `undefined`, `Configuration.init` skips its preloaded branch and falls into the disk-resolver `else` branch, which instantiates a `ConfigurationResolver` → `LocalStorage.get(name = "publish.site", ...)`. There, the dot heuristic unconditionally treats the tail after the last `.` as a file extension and throws when it is not one of `json/yaml/xml/toml`:

```ts
// LocalStorage.ts:20-31
if (name_fixed.indexOf(".") !== -1) {
  const parts = name.split(".");
  workflowFileType = parts[parts.length - 1].toLowerCase(); // "site"
  if (!this.fileTypes.includes(workflowFileType)) {
    throw new Error(`File type not supported: ${workflowFileType}`);
  }
  ...
}
```

The throw fires **before** the in-memory `workflowLocator[name]` fallback (LocalStorage.ts:61-67), which is keyed on the original `name` and would otherwise have found the workflow. The disk round-trip is entirely unnecessary: the fully-parsed workflow object is already sitting in `this.nodeMap.workflows[workflow.path]` and was already extracted into `workflow.config` by `getWorkerWorkflows`. The worker is throwing away an in-memory object to re-fetch it from disk through a parser that can't tolerate dotted names.

HTTP never hits this because its explicit-route path passes the in-memory object as `preloadedWorkflow`, which routes `init` through the preloaded branch and never touches `LocalStorage`.

| Claim | Evidence (file:line) |
|---|---|
| Worker calls `init` with no `preloaded` arg, forcing the disk branch | `triggers/worker/src/WorkerTrigger.ts:553` |
| `init` takes the `else`/resolver branch when `preloaded === undefined`; preloaded branch (used by HTTP) is skipped | `core/runner/src/Configuration.ts:168-185` |
| Dot heuristic treats the tail as an extension and throws when it isn't `json/yaml/xml/toml` | `core/runner/src/LocalStorage.ts:20-31` (fileTypes at `:11`) |
| Throw happens before the in-memory `workflowLocator[name]` fallback | `core/runner/src/LocalStorage.ts:61-67` |
| The parsed workflow object is already in memory: `path` is the map key, `config` is the extracted `_config` | `triggers/worker/src/WorkerTrigger.ts:511-530` |
| HTTP passes the in-memory object as `preloaded`, bypassing `LocalStorage` entirely | `triggers/http/src/runner/HttpTrigger.ts:1198-1202` |
| Preloaded branch deep-clones + normalizes a bare config object, so `workflow.config` resolves correctly | `core/runner/src/Configuration.ts:168-181`; `core/runner/src/workflow/WorkflowNormalizer.ts:162-185` |

## Why this is a framework design flaw
This is not a typo — it is two correct subsystems wired together incorrectly on the worker path, and the failure mode directly contradicts the framework's own published guidance. The `core/runner/CLAUDE.md` sub-workflow docs and the `allowList` examples (`"handler.payment"`, `"handler.shipping"`, `"publish.site"`) actively **recommend** dotted `domain.action` workflow names. HTTP and sub-workflow resolution both honor that convention because they resolve from the in-memory registry/preloaded object. The worker trigger, however, silently diverges: it re-resolves through the disk-based `LocalStorage` path even though it already holds the parsed object, and that path's filename heuristic is fundamentally incompatible with dotted names. The result is that a naming convention the framework tells authors to use is a guaranteed crash on one of its core triggers — a consistency defect in the loading architecture, not a surface-level bug. The disk re-read is also pure waste: one redundant `fs` round-trip per job for an object that never left memory.

## Proposed fix (primary)
Make the worker run path resolve from the in-memory workflow object instead of disk, mirroring the proven HTTP explicit-route path. In `WorkerTrigger.handleJob`, look up the already-loaded object and pass it as the third `preloaded` argument to `Configuration.init`. The preferred source is the original builder/locator entry `this.nodeMap.workflows[workflow.path]` (the exact analogue of HTTP's `route.workflow`), falling back to the pre-extracted `workflow.config` if the map entry is somehow absent — so `preloaded` is never `undefined` (which would re-trigger the disk branch). `Configuration.init`'s preloaded branch already deep-clones (`JSON.parse(JSON.stringify(...))`) and runs `normalizeWorkflow`, so it handles both builder envelopes (`{_blokV2, _config}`) and bare configs identically. Dotted names then "just work" on the worker path, and every job saves one disk read.

```ts
// triggers/worker/src/WorkerTrigger.ts:553 — resolve in-memory, pass as preloaded
const preloaded =
  (this.nodeMap.workflows && this.nodeMap.workflows[workflow.path]) ?? workflow.config;
await this.configuration.init(workflow.path, this.nodeMap, preloaded);
```

As **defense-in-depth (secondary, lower priority)**, harden `LocalStorage.get()` so a non-file-extension dot is treated as part of the name rather than a fatal error. Only strip a dotted tail when it matches a known `fileType`; otherwise leave `name_fixed` intact and let the lookup fall through to the in-memory `workflowLocator` fallback or the accurate `Workflow not found` error. This unblocks any other path that still routes through `LocalStorage` (e.g. genuinely disk-only dotted JSON/YAML workflows) and removes a sharp, misleading error message.

```ts
// core/runner/src/LocalStorage.ts:20-31 — don't throw on an unknown tail
if (name_fixed.indexOf(".") !== -1) {
  const parts = name.split(".");
  const maybeExt = parts[parts.length - 1].toLowerCase();
  if (this.fileTypes.includes(maybeExt)) {
    workflowFileType = maybeExt;
    name_fixed = parts.slice(0, -1).join(".");
  }
  // else: tail is part of the name — keep name_fixed = name, keep default fileType,
  // let the disk miss fall through to workflowLocator[name] / "Workflow not found".
}
```

**Files to change**
- [ ] `triggers/worker/src/WorkerTrigger.ts` — in `handleJob` (line 553), resolve the in-memory workflow object and pass it as the third `preloaded` arg to `Configuration.init`; routes init through the preloaded branch and bypasses `LocalStorage` for dotted names. (Primary — necessary.)
- [ ] `core/runner/src/LocalStorage.ts` — in `get` (lines 20-31), gate the dot-strip on a known fileType and drop the `File type not supported` throw; fall through to the in-memory fallback / accurate not-found error. (Secondary — defense-in-depth.)
- [ ] `core/runner/CLAUDE.md` — add a one-line note in the worker/workflow-loading section that worker workflows resolve from the in-memory registry (like HTTP and sub-workflows), so dotted `domain.action` names are supported on every trigger.

## Alternatives considered
| Option | Trade-off | Verdict |
|---|---|---|
| **PRIMARY-B:** Unify the worker on `WorkflowRegistry.getInstance().get(name)` like `SubworkflowNode`, instead of the per-trigger nodeMap | Most architecturally consistent (one resolution surface across worker/HTTP/sub-workflows). But the worker trigger does **not** populate `WorkflowRegistry` today — only `HttpTrigger.buildFileBasedRoutes` registers — so this requires also wiring worker workflows into the registry at `listen()`, with its own collision/`isMiddleware` concerns. Larger blast radius. | **Defer** — good follow-up, not needed to fix this bug. The nodeMap-preloaded fix is the minimal surgical change that mirrors HTTP's proven path. |
| **SECONDARY-only:** Fix just `LocalStorage.get()` and leave `handleJob` passing the path string | Smaller diff and fixes the symptom, but leaves the worker doing a pointless disk re-read per job and relies on the `LocalStorage` fallback matching the locator key exactly. Keeps worker resolution semantically different from HTTP. | **Insufficient as sole fix.** Good as the defense-in-depth secondary change, but the preloaded fix is the correct resolution because it removes the disk dependency and matches HTTP. |
| **Docs-only stopgap:** Forbid dots in worker workflow names / map keys | Zero code risk, but directly contradicts the framework's own recommended dotted `domain.action` convention and leaves the confusing error in place. | **Reject** as a resolution; acceptable only as a temporary mitigation note while the real fix lands. |

## Tests
- `triggers/worker/src/WorkerTrigger.handleJob-resolution.test.ts` (new) — **Primary regression:** register a worker workflow under a dotted key/name (`publish.site`, `trigger.worker.queue: "publish"`), drive a job through the `InMemoryAdapter`, and assert the run completes with **no** `File type not supported` error. Set `WORKFLOWS_PATH` to a directory that does **not** contain `publish.json` so success proves resolution came from memory, not disk.
- `triggers/worker/src/WorkerTrigger.handleJob-resolution.test.ts` (new) — **Init contract:** spy/mock `Configuration.prototype.init` and assert `handleJob` invokes it with **three** args `(path, nodeMap, preloaded)`, where `preloaded` equals the in-memory `nodeMap.workflows[path]` (or its config). Guards against regressing back to the 2-arg disk path.
- `core/runner/src/__tests__/LocalStorage.dotted-name.test.ts` (new) — **Secondary unit:** `get("publish.site", locator)` where `locator["publish.site"]` exists returns the parsed config from the in-memory fallback and does **not** throw `File type not supported`; `get("publish.site", undefinedLocator)` throws `Workflow not found: publish.site` (accurate), not the file-type error.
- `core/runner/src/__tests__/LocalStorage.dotted-name.test.ts` (new) — **Back-compat:** `get("users/list.json")` and `get("users/list.yaml")` still parse the dot as a real extension and read from `WORKFLOWS_PATH/<type>/`, proving genuine file-extension behavior is preserved. Include a multi-dot case (`order.line.item`) to confirm only the final segment is checked.
- `triggers/worker/src/WorkerTrigger.test.ts` (extend) — add a focused case asserting a **non-dotted** worker name still resolves correctly after the change (no regression for the common case).

## Edge cases & backward compatibility
- **Dotted name vs dotted map key:** the bug fires on either, because `getWorkerWorkflows` uses the map key as `workflow.path` (the init identifier). The preloaded fix resolves both since it looks up by that same key/object. Tests cover both.
- **Multi-dot names** (`order.line.item`): the hardened `LocalStorage` must check **only** the last segment against `fileTypes`; when it's not a fileType, keep the whole name intact (`name_fixed` stays `order.line.item`), not strip the last segment.
- **Genuine disk-only dotted workflows** (e.g. `a.b.json` on disk): rely on the secondary `LocalStorage` fix to strip a real `.json` extension while leaving an upstream dot in place. Covered by the back-compat test.
- **Zod-schema metadata on v2 builders:** passing the in-memory builder/`_config` as `preloaded` means `init`'s `JSON.parse(JSON.stringify(...))` flattens `input`/`output`/`events` Zod schemas to `{}`. Harmless — that metadata is typed-client only, unused at runtime, and matches HTTP's existing behavior. Noted so nobody expects schemas to survive into the worker ctx.
- **Missing nodeMap entry for a path:** the `?? workflow.config` fallback guarantees `preloaded` is never `undefined` (which would re-trigger the disk branch). Test the fallback explicitly.
- **HMR / re-scan:** `handleJob` reads `this.nodeMap.workflows[workflow.path]` per call, so a re-populated map is picked up at job time — no stale captured reference.
- **`File type not supported` no longer thrown:** a grep confirms no source/test asserts that string except the throw site itself, so removing it is effectively risk-free. A downstream consumer relying on it would now get the more accurate `Workflow not found`.
- **Worker now resolves from memory, not disk:** an operator who intentionally hot-swapped an updated worker JSON on disk while shipping a stale compiled map would now run the in-memory version. This matches HTTP's documented semantics (TS workflows come from the compiled map) and is a consistency improvement; HMR re-loads the map.
- **Latent downstream surfacing:** dotted workflows that always hard-failed will now actually execute for the first time, running real side effects. Expected — those workflows were broken before.
- **Per-run isolation:** the preloaded object is deep-cloned per job (existing `init` behavior), so no shared-mutation risk is introduced; behavior matches HTTP.

## Effort & risk
**Small — roughly 0.5 day including tests and verification.** The primary fix is a ~3-line change in `WorkerTrigger.handleJob` (resolve the preloaded object + pass it as the third arg). The secondary `LocalStorage` hardening is a ~6-line edit (gate the strip on a known fileType, remove one throw). Plus two new test files and a one-line docs note. **Blast radius is low:** no schema or migration changes, the change mirrors an already-proven HTTP code path, and no existing test asserts the removed throw. The main behavioral shift is intended — dotted worker workflows go from "always crash" to "run."

## Open questions for reviewer
- **Registry unification (PRIMARY-B):** should worker workflows also be wired into `WorkflowRegistry` so worker, HTTP, and sub-workflow lookups share one resolution surface? Recommended as a follow-up but intentionally out of scope here to keep the fix surgical.
- **Preloaded source:** confirm the desired source — the in-memory builder object `this.nodeMap.workflows[path]` (exact mirror of HTTP's `route.workflow`) vs the pre-extracted `workflow.config` (avoids a second map lookup). Both normalize correctly; suggestion is builder-with-config-fallback.
- **Broader loading cleanup:** should `LocalStorage.fileTypes` / the dot heuristic be reconsidered more broadly (e.g. probe each known extension on disk) as part of a larger resolution cleanup? Adjacent to this bug but beyond its scope.
- **Other trigger paths:** do any non-worker, non-HTTP run paths (cron, pubsub, queue scaffolds) also call `init` with a bare path string and share this dotted-name hazard? Worth a quick audit; if so, the same preloaded pattern applies.