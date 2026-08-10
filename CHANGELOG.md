# Changelog

All notable changes to Blok are recorded here.

The project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html);
the monorepo's git tag (`vX.Y.Z`) is the canonical version. Individual
packages on npm version independently within each release line.

## [Unreleased]

_Nothing yet._

## [2.1.0] — 2026-08-10

> **Upgrade promptly if you use `idempotencyKey`, `concurrencyKey` or
> `debounce.key`.** On 2.0.x an expression-shaped value that was not
> `js/`-prefixed resolved to a **literal constant** instead of failing — so
> every request shared one cache entry and the first response was replayed to
> every caller for the 24h TTL (and per-tenant concurrency limits collapsed
> into one global bucket). A structural `{$ref}` in those fields was silently
> **dropped**, disabling the cache with no signal. Both are fixed here, and a
> bad key now throws a named error instead of corrupting results.


### Fixed

- **`idempotencyKey` / `concurrencyKey` / `debounce.key` no longer degrade to
  CONSTANTS when the expression isn't recognised** (#706). These three fields are
  resolved by a `js/`-or-LITERAL rule, and every non-`js/` string was taken as a
  literal — so `"idempotencyKey": "$.req.body.requestId"` became one cache entry
  keyed on the string `$.req.body.requestId`, and the first response was replayed
  to **every** subsequent caller for the full 24h TTL. On a payment or order step
  that is cross-customer response bleed, not a perf regression; the
  `concurrencyKey` equivalent collapses every tenant into one bucket, turning a
  per-tenant limit of N into a global limit of N. It was strictly worse than the
  documented fail-open contract, because resolution never failed — it *succeeded*
  as a constant. Five real occurrences shipped in this repo, all written by people
  following the docs.

  Literal keys are still legal (a static dedup key is a real use case), but a value
  that is expression-SHAPED and unresolvable — a leading `$.`, a bare `ctx.`, a
  `${…}` interpolation, `{{…}}`, or an unlowered `{$ref}` / `{$tpl}` object — now
  throws `UnresolvableKeyExpressionError`, naming the field, the step and the
  correct form. The same values are reported statically by `validateRefs` /
  `blokctl check` (new `unresolvable-key` diagnostic) and by the HTTP trigger's
  boot-time pass, so CI catches them before a deploy does.

  **Behavior change, deliberately.** A workflow that is (unknowingly) relying on a
  constant key will now error instead of silently sharing one cache entry or one
  concurrency bucket. That is the point: the runtime symptom was invisible. Fix by
  writing the `js/` form (`"js/ctx.request.body.requestId"`) or, in the
  `@blokjs/core` DSL, passing the typed handle — or drop the expression syntax if
  you genuinely meant a constant.

  Two silent-disable holes closed along the way: `readConcurrencyConfig` and
  `readSchedulingConfig` coerced a non-string key (an unlowered `{$ref}`) to `""`,
  which turned the concurrency gate and debounce off entirely with no signal.

- **`http+sse` and `http+websocket` scaffolds could not be installed with npm**
  (#741). The generator injected `@hono/node-server@^1.19.9` while
  `triggers/http` pins `overrides: {"@hono/node-server": "^2.0.11"}` — npm
  refuses an override that contradicts a direct dependency and failed the install
  with `EOVERRIDE`; bun accepts it, which is how it shipped. Both sites now read
  one exported `HONO_NODE_SERVER_RANGE`, and the generator emits the
  `overrides`/`resolutions` pin itself, since sse- and websocket-only scaffolds
  inherit none.

  Four more defects in the same blind spot went with it: cron-, mcp- and
  webhook-only `blokctl create` threw `ENOENT` on `.env.example` (those trigger
  packages ship none, so those three combos had **never** scaffolded); the three
  abstract trigger bases declared `BlokService<unknown>` where `NodeMap.addNode`
  takes `NodeBase`, so generated projects failed their own typecheck; the
  inherited `build` script was `bun run tsc`, unusable for npm-only users; and
  the `chat-ui` example node used `__dirname`, which Bun defines and Node does
  not — so every built `--examples` scaffold crashed on boot under plain Node.

  A new combo matrix (`tests/e2e/scaffold-smoke/combos.sh`, wired into CI)
  creates, `npm install`s, builds and boots seven trigger combinations on plain
  npm/Node, asserting each step's exit code. The previous smoke built one
  maximal scaffold under bun and never checked a build exit code, which is
  exactly why all five of these were invisible.

- **`GlobalError` broke `instanceof` for its own subclasses** (#736). The
  constructor called `Object.setPrototypeOf(this, GlobalError.prototype)`
  unconditionally, clobbering the prototype of any subclass that did not re-pin
  its own after `super()` — defeating the named-error checks
  (`UnresolvableKeyExpressionError`, `WorkflowInputValidationError`, …) that the
  error vocabulary exists to enable. It now pins `new.target.prototype`, the
  standard Error-subclass pattern, so every subclass inherits correct identity
  without ceremony.

### Added

- **Bulk data can now cross the runtime boundary: automatic claim-check offload
  for oversized step inputs** (#677, ADR 0014 Phase 2). Everything a workflow
  hands a `runtime.*` node was inlined into one unary gRPC message, fully
  buffered on both ends under a symmetric 16 MiB limit; the only tools were the
  Phase 1 fail-fast error and "restructure your pipeline". Set `BLOK_BLOB_DIR`
  to a directory the runner and its sidecars share and inputs over
  `BLOK_BLOB_THRESHOLD_BYTES` (default 1 MiB) are written there instead, with a
  small `{"$blokBlob": {"id", "bytes", "codec"}}` reference on the wire in their
  place. The sidecar reads the file and the node receives its real inputs —
  no app-level claim-check code, no node changes.

  The offload runs **before** the `GRPC_REQUEST_TOO_LARGE` guard, so a payload
  that used to be refused now goes through; a blob is deleted the moment its
  call settles, so disk tracks concurrent oversized calls rather than run
  history (the Janitor sweeps only what a crashed runner orphaned, after
  `BLOK_BLOB_RETENTION_MS`, default 1 h).

  **Negotiated, not assumed.** `ListNodesResponse` gains an additive
  `capabilities` field (proto field 5), and the runner sends a reference only to
  a runtime advertising `blob-v1` — which an SDK does exactly when its own
  `BLOK_BLOB_DIR` is set. A half-configured deployment therefore keeps the old
  inline behaviour and the loud Phase 1 error, instead of handing a node a
  reference it cannot read. Blob ids are validated on both ends so a wire-supplied
  id can never escape the blob directory.

  Off unless configured. **All seven runtime SDKs implement the SDK half**
  (#738) — go, rust, java, csharp, php and ruby joined python3, each resolving
  the sentinel from its own `BLOK_BLOB_DIR` and advertising `blob-v1` exactly
  when that variable is set. The cross-runtime CI lane drives a real 2 MiB
  payload through all seven containers and asserts each node receives its true
  inputs, not the reference. Kubernetes: set
  `blobStore.enabled=true` for a shared `emptyDir` across the runner and every
  sidecar. Dev (`scripts/dev-full.ts`) defaults it to `.blok/blobs`. Only the
  request direction is offloaded — a node's return value is still bounded by the
  message limit. Docs: `docs/d/reliability/large-payloads.mdx`.

- **`{"$ref"}` / `{"$tpl"}` in the three RESOLVED-KEY positions — step
  `idempotencyKey`, trigger `concurrencyKey`, trigger `debounce.key` — is now
  a first-class authoring form, not just a runtime backstop** (#728).
  Earlier work taught `WorkflowNormalizer` to LOWER a structural ref in these
  three positions to the `js/…` wire string at load, but the static layer
  hadn't caught up: `V2RegularStepSchema.idempotencyKey` (and the
  sub-workflow / trigger equivalents) were `z.string().min(1)` — Zod rejected
  the object outright — and `validateRefs.collectKeySites` walked the raw
  doc and reported a structural ref as `unresolvable-key` even though it
  lowers cleanly. Both now accept it: the Zod schemas widen to `string |
  {$ref}/{$tpl}` (`core/workflow-helper/src/types/{StepOpts,TriggerOpts}.ts`,
  regenerating `schemas/workflow.v2.json` per the #304 anti-drift gate), and
  `collectKeySites` / `collectTriggerKeySites` exempt a structural value from
  the shape check — the same treatment `wait.for` / `wait.until` already got
  in #704. The expression-shaped-but-unresolvable string class from #706
  (`$.…`, bare `ctx.…`, `${…}`, `{{…}}`) is still rejected —
  `unresolvableKeyShape` itself is unchanged, only its caller now skips a
  value it already knows will lower.

  **Severity note, for context**: before the lowering pass existed, a
  structural `idempotencyKey` wasn't just unlowered — `WorkflowNormalizer`
  type-checked the field BEFORE lowering it, so a `{$ref}` failed
  `typeof === "string"` and was SILENTLY DROPPED (`WorkflowNormalizer.ts:421`
  at the time), disabling the idempotency cache for that step with no error
  and no warning.

- **`buf breaking` now runs in CI** (#739). The Makefile targets existed but no
  workflow ever invoked buf, so the wire contract had no breaking-change gate —
  `proto:check` only catches copy drift between the canonical proto and the SDK
  copies, never a renumbered or deleted field. The check now runs in the
  integration workflow against the last release tag (proven red against a
  deliberate field renumber), and the target resolves the repository through
  `git rev-parse --git-common-dir` so it also works from a git worktree.

### Changed

- **The `@blokjs/trigger-sse` EventSource integration tests no longer race the
  server** (#739). They waited a fixed 100 ms for the handler to subscribe, and a
  subscriber created after a publish sees nothing without a `lastEventId` — so
  under parallel load the events were dropped and the client blocked until the
  suite timed out 15 s later, with nothing in the output to say why. They now
  handshake on the bus's subscriber count, bind an ephemeral port instead of one
  shared with the webhook suite, and bound the read with an assertion rather than
  a framework timeout.

- **The workflow-`input` gate's rejection is now a named, exported error**
  (#678, ADR 0015). The trigger-boundary gate threw an anonymous `GlobalError`;
  it now throws `WorkflowInputValidationError` (exported from `@blokjs/core/runtime`
  and `@blokjs/shared`, alongside `ConcurrencyLimitError` and friends), a
  `GlobalError` **subclass** — same `400`, same
  `WORKFLOW_INPUT_VALIDATION` tag on `context.name`, same structured
  `validation_errors` — so every transport translation (HTTP 400, MCP `isError`,
  gRPC status, worker DLQ, pub/sub dead-letter, webhook 4xx) is unchanged.
  New: callers can `instanceof` it and read `err.info.workflowName` /
  `err.info.issues`, and the rejection **names the workflow** —
  `Input validation failed for workflow 'search': query (Required)`. The 400 body
  gained `error` and `workflowName` alongside `validation_errors` (additive).

  Scope that was implied is now documented and pinned by tests: the
  `runWorkflow` testing path is **not** gated — it drives the runner directly,
  the same position a `subworkflow:` child occupies, and neither passes through
  `TriggerBase.run()`. A test therefore runs the payload its author wrote,
  verbatim, with no declared `.default()`s applied. To test the input contract
  itself, `safeParse` the schema in the test or exercise the transport.

- **Packaging gate now covers every publishable-looking package; `blokctl`'s
  tarball no longer ships its own test suite** (#697). Follow-up to #687/#696:
  four `private: false` packages sat outside `PUBLISHABLE` (`scripts/release.ts`)
  and so outside the packed-artifact gate entirely.
  - `@blokjs/syntax` and `@blokjs/lsp-server` are **added back to
    `PUBLISHABLE`**. Both actually shipped to npm at `0.2.0`/`0.2.1` during the
    changesets era, then fell out of the lockstep publish list without ever
    being marked `private`. Their in-repo version kept advancing (currently
    `0.6.0` locally vs. `0.2.1` on the registry) while `packages/lsp-server/
    editors/*` (Neovim, Emacs, Helix, Sublime) kept telling users to
    `npm install -g @blokjs/lsp-server` — real, already-published, stale
    tooling with zero gate coverage. Both are bumped to `2.0.1` to rejoin
    lockstep and will publish on the next release.
  - `@blokjs/browser` is set **`private: true`**. It carries a lockstep-looking
    version (`2.0.1`) but has never actually been published (`npm view
    @blokjs/browser` 404s), has no user-facing docs instructing an install, and
    is reached by `@blokjs/trigger-http` only via an optional `try { await
    import(...) }` with no manifest dependency — so there was no live breakage,
    just a misleading manifest state.
  - `blok-vscode` is set **`private: true`** — it publishes to the VS Code
    Marketplace via `vsce`, not npm.
  - The packaging gate (`scripts/check-packed-exports.ts`) now fails fast if
    any workspace package is neither `private: true` nor listed in
    `PUBLISHABLE` — the four packages above can't silently drift out of gate
    coverage again.
  - `blokctl`'s published tarball no longer contains `dist/__tests__/`
    (`packages/cli/tsconfig.json` now excludes test files from the build, same
    pattern `core/runner` already used).
- **TypeScript workflows are now auto-routed by file-scan, like JSON
  already was** (#695). `HttpTrigger.buildFileBasedRoutes()` scanned
  `src/workflows/*.ts` at boot but only used the result to build a
  display map — the route table itself was built from JSON + the manual
  `src/Workflows.ts` map only, so a `.ts` workflow with an `http` trigger
  produced **zero routes** until it was ALSO hand-registered in
  `Workflows.ts`. That made the framework's own recommended authoring
  format the one that still needed a manual step. A workflow scanned from
  disk AND listed in `Workflows.ts` (the common shape mid-migration)
  resolves to exactly one route — not a collision — with a deterministic
  winner and a boot warning if the two sources genuinely disagree.
  `Workflows.ts` is now the back-compat / advanced path (workflows
  outside the scan root, or a deliberate explicit map), not something new
  workflows need — see the [HTTP trigger docs](docs/d/triggers/http.mdx#file-based-routing).

  > **⚠️ Upgrade note:** if your project has `.ts` files under
  > `src/workflows/` that declare an `http` trigger but were never added
  > to `src/Workflows.ts` — leftover experiments, half-finished drafts,
  > copy-pasted scaffolds — those routes were previously **silently
  > inert**. After upgrading they **start serving traffic** at their
  > declared (or file-derived) path. Audit `src/workflows/` before
  > upgrading in production, or run `blokctl routes` to see the full
  > table before deploying.

## [2.0.1] — 2026-08-07

### Fixed

- **Scaffolded projects now build and run under plain Node** (#709). The v2.0.0
  packaging fix healed every published package, but a generated project compiles
  the copied template source with its own `tsc` — which never rewrites
  specifiers — so `npm run build && node dist/...` (any Node container or
  serverless deploy) failed with `ERR_MODULE_NOT_FOUND` while the Bun dev path
  hid it. Template sources now carry explicit NodeNext specifiers, generated
  projects get `moduleResolution: "nodenext"` (an extensionless import in YOUR
  code is now a compile error, not a deploy-time crash), and a
  `check:template-esm` CI gate keeps it that way.
- **`npm run start` works on fresh scaffolds.** The inherited `start` script
  pointed at a `dist/index.js` no project build produces; it now runs the real
  primary-trigger entry under Node (`node dist/triggers/<kind>/index.js`).

## [2.0.0] — 2026-08-07

### Security

- **Scaffolded projects now audit clean (was 34 vulnerabilities: 13 high, 17
  moderate, 4 low).** `npx blokctl create project` shipped a dependency tree with
  seven root advisories; everything else was cascade. Fixed by upgrading:
  - `@opentelemetry/*` **1.x → 2.10.0** and the exporters to **0.221.0** —
    clears the two HIGHs (`exporter-prometheus` crash-via-malformed-request
    GHSA-q7rr-3cgh-j5r3, `propagator-jaeger` DoS GHSA-45rx-2jwx-cxfr) plus
    `@opentelemetry/core` unbounded W3C-baggage allocation GHSA-8988-4f7v-96qf.
  - `@hono/node-server` **1.19.9 → 2.0.11** — `serve-static` path traversal
    (GHSA-frvp-7c67-39w9). This one was reachable: the HTTP trigger serves
    `/public/*` via `serveStatic`.
  - `ai` **4.x → 7.0.36** (+ `@ai-sdk/openai` **4.0.19**) — clears the AI SDK
    filetype-whitelist bypass, `@ai-sdk/provider-utils` resource consumption, and
    drops `jsondiffpatch` (XSS) from the tree entirely.

  The template also pins `overrides["@hono/node-server"]`: `@hono/node-ws@1.3.1`
  (latest) still declares a peer on node-server `^1.19.11` despite never
  importing it at runtime, and without the pin npm reinstalls the vulnerable 1.x
  nested. `blokctl` now MERGES rather than replaces `overrides` when scaffolding
  from a local repo, so that pin survives.

### Fixed

- **Every published `@blokjs/*` package was Bun-only and crashed Node's ESM
  loader** (#687). `tsc` copies module specifiers through verbatim, so source
  written as `import Configuration from "./Configuration"` shipped exactly that
  in `dist/`. Bun resolves the extensionless form; Node does not. Consequence:
  `npx blokctl` was broken, and so was every consumer on the Node loader —
  vitest, plain `node`, `tsx`, Next.js/Vite SSR externals. Downstream projects
  were papering over it with `server: { deps: { inline: [/@blokjs\//] } }` in
  `vitest.config.ts`; that workaround can now be deleted.

  `scripts/fix-esm-extensions.ts` runs as part of `bun run build` and rewrites
  every emitted relative specifier to the explicit form Node needs
  (`./Configuration.js`, `./tracing/index.js`), in `.js` and `.d.ts` alike.
  **Always build with `bun run build`, never a bare `nx run-many -t build`** —
  the fixup is part of the root script.

  Fixed alongside it, both found by the new gate:
  - `@blokjs/react` used `__dirname` in an ESM module. Bun provides it, Node
    does not, so importing the published package threw `ReferenceError`.
  - `@blokjs/runner`'s `Blok.d.ts` reached into `@blokjs/shared/dist/**` for a
    type that already exists locally, emitting a deep specifier no
    node16/nodenext type resolver can follow.

  Sourcemaps are no longer shipped. Published packages contain `dist` only, so
  the maps pointed at `src/` files that were never in the tarball — consumers
  got "points to missing source files" warning spam for maps that could not
  have worked.

- **Graceful shutdown could hang forever when an OTLP collector was
  unreachable.** `TracingBootstrap`'s `shutdown()` awaited `provider.shutdown()`
  unbounded; that force-flushes queued spans through the OTLP exporter, which
  retries against a dead endpoint — so SIGTERM never completed. The flush is now
  bounded (`BLOK_TRACING_SHUTDOWN_TIMEOUT_MS`, default `2000`). Surfaced by the
  OpenTelemetry 2.x upgrade, but the hang was latent before it.

### Added

- **Packaging gate: `bun run ci:packaging`** (#687). Nothing in this repo ever
  loaded a published artifact the way a user does — every suite runs under Bun,
  against the workspace, where symlinks and Bun's resolver hide packaging
  defects. The new gate `npm pack`s all 18 publishable packages, installs the
  tarballs into a throwaway project, and imports **every subpath of every
  exports map** (157 today, wildcards expanded) with real Node; then runs
  `tests/e2e/node-consumer` — vitest on Node with a deliberately empty config —
  followed by `publint` and `@arethetypeswrong/cli`. Runs on every PR via
  `.github/workflows/packaging.yml`. `bun run scripts/fix-esm-extensions.ts
  --check` is the fast local signal.

- **Runtime-boundary payload safety (ADR 0014).** Non-NodeJS runtime nodes now
  fail fast with a `GRPC_REQUEST_TOO_LARGE` error naming the node and a per-blob
  byte breakdown when a request would exceed the gRPC message limit — instead of
  an opaque `RESOURCE_EXHAUSTED`. New opt-in `BLOK_GRPC_STATE_DIET=1` stops
  shipping the accumulated workflow state + previous-step output on every remote
  call (keeps `env` + trigger body); use it only when runtime nodes follow the
  v2 ABI and never read `ctx.vars` / `ctx.response.data`. New docs page:
  *Reliability → Large payloads across the runtime boundary*.

### Behavior changes

- **Workflow `input` Zod is now enforced at the trigger boundary (ADR 0015).**
  A workflow that declares `input` on `workflow({ input })` now has each request
  validated in `TriggerBase.run` before the body reaches any step: the body is
  `safeParse`d and **replaced with the parsed value**, so declared `.default()`s
  and coercions apply and unknown keys are stripped. Workflows that declared a
  schema *and* relied on undeclared body fields must switch to
  `z.object({...}).passthrough()`. Kill switch:
  `BLOK_VALIDATE_WORKFLOW_INPUT=0`. Undeclared `input` → unchanged.

  Enforced for **http, mcp, grpc, worker, pubsub, and webhook** — the triggers
  whose body is the caller/producer payload the schema describes. A malformed
  payload yields `400` (HTTP/webhook), an `isError` result (MCP), an error status
  (gRPC), a **DLQ'd job with no retries burned** (worker), or a
  **dead-lettered/dropped message** (pub/sub) — never a poison-message loop.
  `cron`, `sse`, and `websocket` are excluded: their `ctx.request.body` is
  framework-generated, not caller input.

- **Non-retryable failures are now terminal on worker/pub-sub.** A validation
  failure carries a `WORKFLOW_INPUT_VALIDATION` tag; worker routes it straight to
  DLQ instead of exhausting the retry budget, and pub/sub dead-letters (or ACK-
  drops) it instead of nacking forever. Three worker adapters were fixed to honour
  the terminal `job.fail(err, false)` contract they previously ignored: **BullMQ**
  (a discarded job now lands in the failed set with the real error — previously
  `moveToFailed` threw `Lock mismatch` because the lock token was never captured),
  **SQS** (deletes, optionally after a DLQ send, instead of waiting out the
  visibility timeout), and **pg-boss** (no longer re-throws, so it does not retry).
  A webhook validation failure now returns a real 4xx and is **not** recorded as a
  processed delivery, so the sender can retry after correcting the payload.

### Deprecated

- **Hand-written `js/ctx....` and `${ctx....}` strings are no longer an
  authoring form.** They are the runtime wire format that the load-boundary
  lowering pass (`lowerRefs`, ADR 0001) emits, and nothing else. You author with
  typed handles in TypeScript, or with structural references in JSON:
  `{"$ref": {"step": "fetch", "path": ["data"]}}`, `@trigger` for the trigger
  payload, `@error` for a caught error, `{"$tpl": ["text", {"$ref": …}]}` for a
  string that embeds one.
  - **Nothing breaks.** Workflows carrying the old strings load and run
    unchanged. The runner now logs **one** structured deprecation warning per
    workflow whose step `inputs` still hold hand-written path strings, naming
    the workflow, each offending step and the count. Silence it with
    `BLOK_SUPPRESS_LEGACY_EXPR_WARNING=1`. Removal target: **next major**.
  - The warning fires only for expressions that have an exact structural
    equivalent — the set `blokctl migrate refs` can rewrite. Non-structural
    expressions (fallbacks, optional chaining, `.map`/`.reduce`, calls,
    `process.env`) are the sanctioned ADR 0008 escape hatch: the `` js`…` `` tag
    in TypeScript, a plain `js/` string in JSON. They never warn.
  - Control and trigger-config positions are unaffected and keep path strings —
    `branch.when` / `loop.while` (raw `ctx.*`, no prefix), `switch.on`,
    `forEach.in`, `wait.for` / `wait.until`, `subworkflow`, step
    `idempotencyKey`, and trigger `concurrencyKey` / `debounce.key`. The
    lowering pass is scoped to step `inputs`; a structural ref elsewhere would
    be walked into by the Mapper rather than resolved.
  - The docs were re-layered to match. `docs/d/reference/mapper.mdx` moved under
    a new **Internals** nav group and opens with a banner stating it is the wire
    format, not an authoring API. `@blokjs/expr` stays the documented exception
    (its `expression` input is verbatim JS and must **not** carry a `js/`
    prefix). Full before/after for every legacy shape: [legacy expression
    strings migration guide](docs/c/migration-guides/legacy-expression-strings.mdx).
  - A CI gate (`bun run check:no-legacy-expr`,
    `.github/workflows/no-legacy-expr.yml`) fails the build if a pure-path
    `js/ctx....` string or a `${ctx....}` interpolation reappears on the public
    authoring surface — docs, templates, examples, editor packages, and the
    repo's agent guides.

### Breaking changes

- **The `$` proxy is deleted.** `import { $ } from "@blokjs/core"` and
  `import { $ } from "@blokjs/helper"` are now compile errors — there is no
  flag to bring it back. `$` compiled `$.state.foo` / `$.request.body` /
  `$.prev.x` / `$.error.message` straight to `"js/ctx.*"` strings at
  definition time, bypassing the typed `step()` handles, the structural
  `{$ref}` IR, and `validateWorkflow`'s static ref checking — the exact
  stringly-typed failure mode the core redesign exists to kill. Everything it
  did is covered by an existing, better-typed mechanism:
  - New TypeScript workflows: the producing step's typed handle (`h`/`h.field`)
    replaces `$.state.<id>`; the trigger entry handle (`req`/`job`/`event`/…)
    replaces `$.request`; `tpl` replaces string interpolation; `eq/ne/gt/gte/
    lt/lte/not` (operating on handles) replace `$`-based branch/loop
    conditions; a typed `ErrorHandle` inside `tryCatch`'s `catch` arm replaces
    `$.error`.
  - Legacy object-style / JSON workflows: write the literal `"js/ctx.*"`
    string directly — it's the same string `$` always compiled to.
  - `blokctl migrate refs` mechanically rewrites both shapes (step inputs to
    typed handles / structural `{$ref}`, `branch`/`loop` conditions to raw
    `ctx.*` strings) and marks non-mechanical sites for hand migration.
  - `@blokjs/helper`'s `eq/ne/gt/gte/lt/lte/not` comparators remain exported
    (back-compat) but now take a raw ctx-path **string** (e.g.
    `eq("ctx.request.method", "POST")`) instead of a `$` value.
  - Full before/after table: [`$` proxy removal migration
    guide](docs/c/migration-guides/dollar-proxy-removal.mdx).
  - A CI gate (`bun run check:no-dollar-proxy`, `.github/workflows/no-dollar-proxy.yml`)
    fails the build if `proxy/$`, `unwrapProxies`, or `$.state`/`$.request`/`$.vars`
    reappear anywhere outside this changelog entry and the migration guide.
  - Workflows **serialized** by old versions (JSON files or step trees
    already containing `"js/ctx.*"` wire strings) still load and run
    unchanged — only the `$` **authoring** surface is gone.

## [v0.6.0] — 2026-05-14

The headline shift since v0.4.0. Adds the reliability primitives that
let production workloads opt into idempotency, retries, timeouts,
rate-limit gates, scheduling (delay / ttl / debounce), durable
sub-workflows, and cross-process coordination — without changing v1
workflow behaviour by default. Also lands the new trigger surface
(WebSocket, SSE, Webhook, Pub/Sub, expanded worker adapters) on a
shared Hono server, the wait-inside-primitives primitives
(forEach/loop/switch/tryCatch + wait), and a substantially richer
Studio UI.

### Breaking changes

- `BLOK_FILE_BASED_ROUTING` default flipped to **ON**. JSON workflows under `workflows/json/` auto-register at their `trigger.http.path`. Opt out with `BLOK_FILE_BASED_ROUTING=false` or `BLOK_ROUTING_LEGACY=1`. Codemod: `bunx blokctl migrate paths`.
- `set_var` field removed from v2 workflow schema. `WorkflowNormalizer.assertNoSetVar` throws at workflow load if still present. Codemod: `bunx blokctl migrate workflows`.
- `RUNTIME_TRANSPORT=http` and `HttpRuntimeAdapter` removed — gRPC is the sole runtime transport since v0.5. Stale env values throw at trigger boot.

### Reliability primitives (Tier 1 + Tier 2)

- `idempotencyKey` on any step caches results against `(workflow, step.id, key)` with a 24h default TTL. Cache hit short-circuits `step.process()` entirely. `idempotencyKeyTTL` overrides per step.
- `retry: { maxAttempts, minTimeoutInMs?, maxTimeoutInMs?, factor? }` for capped exponential backoff. Per-attempt failures emit `NODE_ATTEMPT_FAILED`; final exhaustion emits `NODE_FAILED`.
- `maxDuration` on any step — each retry attempt gets its own timeout. Final-attempt timeout flips the run to the new **`"timedOut"`** state. `StepTimeoutError` exported from `@blokjs/runner`.
- Cooperative cancellation: `ctx.signal: AbortSignal` flows through to nodes. `POST /__blok/runs/:runId/cancel` fires the signal and flips status to `"cancelled"`. Sub-workflow children inherit a chained signal.
- Crash auto-flip: `uncaughtException` + `unhandledRejection` handlers flip every in-flight `running` run to **`"crashed"`** before the process dies. `recoverOrphanedRuns()` at boot flips stale `running` rows older than `BLOK_ORPHAN_THRESHOLD_MS`. Page-aware (drains all rows, not just the first page).

### Per-tenant concurrency gate (Tier 2 #6)

- `concurrencyKey` + `concurrencyLimit` + `onLimit: "throw" | "queue"` on any HTTP / Worker trigger.
- `onLimit: "queue"` defers the run via `DeferredRunScheduler` with capped exponential backoff (`queueRetry: { minBackoffMs, maxBackoffMs, factor }`). New run state **`"queued"`**.
- Cross-process backends: `BLOK_CONCURRENCY_BACKEND=nats-kv` (revision-based CAS) or `redis` (server-side Lua, no OCC retry loop). FW-5 production refusal on default bucket / key-prefix names.
- New OTel counters: `blok_concurrency_acquired_total`, `denied_total{mode}`, `released_total`, `occ_retries{outcome}`, `backend_install_total`.
- New REST endpoints: `GET /__blok/concurrency/health`, `GET /__blok/concurrency/state` (powers Studio's `ConcurrencyTile`).
- D6 — `BLOK_METRICS_PER_KEY=1` opts in to per-`concurrency_key` labels (default OFF strips the high-cardinality label).

### Scheduling gates (Tier 2 #5 + #7)

- `delay` + `ttl` on triggers — HTTP returns `202 Accepted` immediately. New run states **`"delayed"`** and **`"expired"`**.
- `debounce: { key, mode, delay, maxDelay? }` — trailing (default) or leading. Latest-payload-wins via captured closure. One run record per ping (coalesce losers get **`"debounced"`** terminal with `intoRunId` pointing at the active run).
- Durable scheduler: HTTP `delay` and `queue` writes to `scheduled_dispatches` table (sqlite v9 / PG v3). `recoverDispatches()` at boot re-registers timers + marks past-TTL rows as expired.
- Cross-process scheduler claim coordination — sqlite v13 / PG v6 add `claimed_by` + `claimed_at` so multi-process deployments don't double-fire dispatches. Heartbeat every 20s (tunable).
- Cross-process debounce backend: `BLOK_DEBOUNCE_BACKEND=nats-kv` or `redis`. Shared doc per `(workflow, debounceKey)` bucket with owner-lease attribution. Owner-local payload semantic.

### Sub-workflows (Tier 2 #4)

- `subworkflow: "<name>"` step invokes another workflow function-call-style. `wait: true` (default) waits for child completion; `wait: false` fires-and-forgets with `{runId, workflowName, scheduledAt}`.
- G3 — polymorphic dispatch: `subworkflow:` accepts `$.<path>` / `js/...` expressions resolved at dispatch time. Pair with `allowList: [...]` to constrain caller-supplied names.
- G2 — cross-process dispatch: `dispatch: "in-process" | "http-self"`. `http-self` dispatches the child as a fresh HTTP request to `BLOK_SELF_BASE_URL`. Lineage crosses the HTTP boundary via `X-Blok-Parent-Run-Id` / `-Node-Run-Id` / `-Subworkflow-Depth` headers.
- Recursion cap: `BLOK_MAX_SUBWORKFLOW_DEPTH` (default 10).
- AbortSignal cascade — parent abort fires children's signals. Listener-leak fix (#A3) lands here.

### Workflow primitives (v0.5 → v0.6)

- `branch` primitive (replaces v1's `AddIf` / `AddElse`).
- `forEach` — collection iteration with optional `as` binding. Sequential and parallel variants.
- `loop` — while-condition with `maxIterations` cap.
- `switch` — N-way branch; first matching `when` wins.
- `tryCatch` — JS-like try/catch/finally with structured `$.error` envelope (`message`, `name`, `stack`, `code`, `stepId`).
- `wait` primitive — `wait: { for, until }` defers the run via the durable scheduler and resumes from a per-run snapshot of `ctx.state`. Composes with **all** primitives:
  - wait inside `tryCatch` (Phase 1)
  - wait inside `forEach` — sequential (Phase 2) and parallel (Phase 3b)
  - wait inside `loop` (Phase 3)
  - wait inside `switch` (Phase 4)

### Triggers

- **HTTP** — shared Hono server architecture refactor; constructor accepts an external Hono app for multiplexing.
- **WebSocket** — new trigger on the shared Hono port (`@blokjs/trigger-websocket`).
- **SSE** — new trigger on the shared Hono port (`@blokjs/trigger-sse`, Pattern A).
- **Webhook** — new trigger with built-in providers + polymorphic dispatch (`@blokjs/trigger-webhook`). Includes raw-body capture for byte-exact HMAC verification.
- **Worker** — adapter extension: 5 new adapters (BullMQ, RabbitMQ, SQS, NATS JetStream variants); polymorphic `provider` field.
- **Pub/Sub** — new trigger (`@blokjs/trigger-pubsub`); 3 adapters (Kafka, Google Cloud Pub/Sub, NATS) + provider field + ctx-level `publish()`.
- **Cron** — middleware chain applied (consistent with HTTP / Worker).

### Middleware

- Process-global middleware via `WorkflowRegistry.setGlobalMiddleware([...])` or `BLOK_GLOBAL_MIDDLEWARE=name1,name2` env var. Resolution order: process-global → workflow-level → trigger-level → workflow body.
- `mw:<name>` origin badge in Studio's StepRail surfaces which middleware produced each nested step.

### Workflow shape (v2)

- Inline inputs on the step itself; `id` + `use` replace the legacy `name` + `node` + separate `nodes{}` map.
- Default-store-on-success: every step's output lands at `ctx.state[<id>]` automatically. Opt out per step with `ephemeral: true`. `as: "<name>"` renames the storage slot; `spread: true` flattens `result.data` keys into `state` (mutually exclusive with `as`).
- Mapper: `$.state.<id>` proxy (TS DSL) compiles to `js/ctx.state.<id>` strings. New `BLOK_MAPPER_MODE=strict` env var fails fast on resolution errors (recommended for production).

### Studio

- E1 — scheduled-runs view + cancel action for `delayed` / `queued` / `debounced` runs.
- E2 — saved filters server-side (replaces localStorage). New `trace_saved_filters` table.
- E3 — sub-workflow depth badge `↳ sub (N)` for nested invocations.
- E4 — static workflow DAG view (xyflow + dagre flowchart) on each workflow's detail page. Powered by `GET /__blok/workflows/:name` returning the raw `definition`.
- F1 — indexed metadata generated columns via `BLOK_INDEXED_METADATA_KEYS=tier,region`.
- F2 — metadata filter operators (`__ne`, `__gt`, `__lt`, `__in`, `__like`, etc.).
- Sample-body trifecta — empty-state curl resolves through 3 tiers: **author** (`trigger.http.examples.body`) > **recorded** (real first successful run when `recordSample: true`) > **inferred** (static analysis of `ctx.request.body` refs). Operator escape hatch: "Re-record sample" button + `DELETE /__blok/workflows/:name/sample`.
- Sidebar lists registered-but-never-run workflows (merges `WorkflowRegistry.list()` into the run-derived summaries).
- Routing diagnostics — `RoutingDiagnostics` singleton + `GET /__blok/routing` + Studio banner surface boot-time route-build problems (collisions, missing paths).
- G2 follow-up — sky-blue `http` chip in StepRail when sub-workflow dispatched via HTTP self-call (alongside the existing `↳ async`/`↳ sub`).
- Iteration grouping — consecutive sibling rail rows that share `iterationIndex` collapse under an "iteration N" header.
- Live progress + partial-result streaming surfaces in NodeDetail.
- StepRail flag persistence (`flags_json` JSON column on `node_runs`) — `wait`, `dispatch`, `subworkflowDepth`, `middleware`, `iterationIndex` now survive sqlite/PG round-trip.

### Observability

- OTel counters for the concurrency gate + scheduling dispatcher (`blok_concurrency_*`, `blok_scheduling_dispatch_*`).
- OCC retry depth histogram (`blok_concurrency_occ_retries`).
- Backend install attempts counter (`blok_concurrency_backend_install_total`) for misconfiguration visibility.
- Graceful shutdown: SIGTERM / SIGINT drain order `trigger.stop()` → `Janitor.stop()` → `DeferredRunScheduler.clear()` → `backend.disconnect()`. Kill-switch: `BLOK_GRACEFUL_SHUTDOWN_DISABLED=1`.
- Janitor singleton — periodic sweep of expired `idempotency_cache`, `concurrency_locks`, `scheduled_dispatches` rows. Default 5min interval; kill-switch `BLOK_JANITOR_DISABLED=1`.

### Persistence

- SQLite migrations v3 → v16 (additive; existing DBs upgrade transparently).
- Postgres migrations v3 → v9 (mirror of SQLite where applicable).
- `state_snapshot` column for wait-resume across process restart.
- `iteration_context` discriminated union for sequential / parallel forEach + wait cursors and switch + wait cursors.

### Docs

- New migration guide: [v1 → v2 · Reliability primitives](docs/c/migration-guides/v1-to-v2-reliability.mdx) — 5-minute recipes for every primitive + composition reference table.
- v0.4 explicit-paths migration guide and `MissingExplicitPathError` UX.
- Per-feature reference docs for every reliability primitive under `docs/d/reliability/`.
- Scheduling overview + per-feature docs under `docs/d/scheduling/`.
- Comprehensive observability page including REST + counter reference and Prometheus query recipes.
- Wait-inside-primitives implementation spec + ctx.error lifecycle.

### Testing infrastructure

- Phase 2.1 — real-broker integration tests for 5 deferred adapters (NATS / Kafka / Redis / Pub/Sub / SQS).
- Docker-compose CI brings up the full broker fleet for each PR run.
- Benchmarks for concurrency snapshot, durable scheduler scans, Janitor sweeps, crash auto-flip, sub-workflow listener cascade.

---

## [v0.4.0] — earlier 2026

Explicit-path-only routing (preview). See
[`docs/c/migration-guides/v0.4-explicit-paths.mdx`](docs/c/migration-guides/v0.4-explicit-paths.mdx)
for the full migration recipe. Set `BLOK_ROUTING_LEGACY=1` to keep v0.3
behaviour (removed in v0.6).

---

[v0.6.0]: https://github.com/well-prado/blok/releases/tag/v0.6.0
[v0.4.0]: https://github.com/well-prado/blok/releases/tag/v0.4.0
