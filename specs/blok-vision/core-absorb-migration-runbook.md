# Runbook — absorb `@blokjs/{runner,shared,helper}` into `@blokjs/core`

- **Status:** Planned, not started. Scoped 2026-07-24. Execute as a focused block.
- **Goal:** A cold `npm install` of a scaffolded Blok project shows **zero
  `@blokjs/*` deprecation warnings**, and the deprecation message ("Use
  `@blokjs/core`") becomes *true* — i.e. `@blokjs/core` is the real, standalone
  implementation and `@blokjs/{runner,shared,helper}` are thin shims over it.
- **Completes:** the `@blokjs/core` consolidation epic (#374).
- **Motivation:** post-v1.6.1, all three are deprecated toward `@blokjs/core`,
  but `@blokjs/core` *depends on* all three (it is a 155-LOC re-export barrel),
  so `npm install @blokjs/core` still installs and warns on all three. The
  deprecation currently punishes correct behaviour.

## Why this is one atomic change (the catch)

There is **no safe incremental checkpoint.** `core/core/src/runtime.ts` does
`export * from "@blokjs/runner"`, and `@blokjs/runner` imports `@blokjs/shared`
/ `@blokjs/helper`. The moment any one of the three becomes a shim-over-core
while `@blokjs/core` still re-exports the not-yet-absorbed engine, you get a
`core → runner → shared-shim → core` **module cycle** that breaks at load. So
the core-merge + shim conversion must land together, then all consumers +
tests are made green in the same pass. Budget accordingly (multi-day).

**Recommended isolation:** do the whole thing in a dedicated git worktree so
`main`/the release branch stays green and publishable throughout.

## Current state (measured 2026-07-24)

| Package | Dir | Files | LOC (src, non-test) | Tests |
|---|---|---|---|---|
| `@blokjs/shared` | `core/shared` | 32 | 2,545 | 16 in `__tests__/` |
| `@blokjs/helper` | `core/workflow-helper` | 17 | 3,797 | in `tests/` (v2, schemas, forEach, …) |
| `@blokjs/runner` | `core/runner` | 132 | 34,712 | 32 in `src/`, 92 in `__tests__/` |
| `@blokjs/core` | `core/core` | 5 | 155 | 9 in `src/` |

All four are ESM (`"type":"module"`), `target/module es2022`,
`moduleResolution: bundler` (→ supports Node `#` subpath imports).

Dependency direction: `shared` (base) ← `helper` ← `runner` ← `core`. One
back-edge: `helper` references `@blokjs/runner` (only in a comment in
`core/shared/src/NodeBase.ts:52` — no code edge from shared; the real
helper→runner type edge is in `StepOpts`). Cycles within the merged package are
fine for ESM as long as nothing evaluates a cycle at module-init.

### Real (non-`@blokjs`) deps to merge into `@blokjs/core`

```
dayjs ^1.11.19, lodash ^4.17.21, zod ^3.24.2,
@grpc/grpc-js ^1.12.0, @grpc/proto-loader ^0.7.13,
@opentelemetry/api ^1.9.0, @opentelemetry/exporter-trace-otlp-grpc ^0.221.0,
@opentelemetry/exporter-trace-otlp-http ^0.221.0, @opentelemetry/sdk-trace-node ^2.10.0,
@opentelemetry/semantic-conventions ^1.30.0,
fast-xml-parser ^5.3.4, jsonschema ^1.5.0, smol-toml ^1.6.0,
uuid ^11.1.0, yaml ^2.8.2, zod-to-json-schema ^3.24.0
```
Plus every OPTIONAL/native dep runner declares (better-sqlite3, the broker
SDKs, etc.) — copy runner's full `dependencies` + `optionalDependencies` +
`peerDependencies` verbatim, then union shared/helper's.

### Build steps to merge into `@blokjs/core`'s build

- runner: `sync:proto` — `mkdir -p dist/adapters/grpc/proto/blok/runtime/v1 && cp src/adapters/grpc/proto/blok/runtime/v1/runtime.proto dist/...` → becomes `dist/runner/adapters/...`.
- helper: `build:schema` — `bun run scripts/build-schema.ts` (emits `schemas/workflow.v2.json`). Move `core/workflow-helper/scripts/` too.
- runner: `type-test` — `tsc -p tsconfig.typetest.json`. Move + repath.

### Deep subpaths external code imports (must stay reachable, → `@blokjs/core/…`)

| Subpath | count | resolves to (in merged core) |
|---|---|---|
| `@blokjs/runner/testing` | 16 | `dist/runner/testing/index.js` |
| `@blokjs/runner/TriggerBase` | 12 | `dist/runner/TriggerBase.js` |
| `@blokjs/helper/internal` | 8 | `dist/helper/internal.js` |
| `@blokjs/runner/stepBuilder` `/handles` `/dsl` | 5 each | `dist/runner/*.js` |
| `@blokjs/runner/defineNode` | 3 | `dist/runner/defineNode.js` |
| `@blokjs/runner/workflow/{WorkflowRegistry,WorkflowNormalizer,PersistenceHelper}` | 1 each | `dist/runner/workflow/*.js` |
| `@blokjs/runner/{tracing/RunTracker,SubworkflowNode,RunnerNode}` | 1 each | `dist/runner/*.js` |
| `@blokjs/helper/schema` | 1 | the `workflow.v2.json` |

`@blokjs/shared` is only ever imported bare (no subpath consumers).

### Import sites to repoint, by area (grep `@blokjs/{runner,shared,helper}`)

| Area | files (test / src) |
|---|---|
| core/shared | 2 (0/2) |
| core/workflow-helper | 10 (1/9) |
| core/runner | 117 (58/59) |
| core/core | 11 (6/5) |
| triggers | 115 (53/62) |
| nodes | 35 (5/30) |
| packages/cli | 38 (19/19) |
| packages/client | 3 (2/1) |

## Target architecture

`core/core/src/` after the merge:

```
src/
  index.ts  dsl.ts  runtime.ts  testing.ts  http.ts   ← the public barrels (kept)
  shared/**   ← moved verbatim from core/shared/src
  helper/**   ← moved verbatim from core/workflow-helper/src
  runner/**   ← moved verbatim from core/runner/src
```

**Internal cross-package imports use Node subpath imports** (`#`), so no
depth-aware relative math. In `core/core/package.json`:

```jsonc
"imports": {
  "#shared":    { "types": "./dist/shared/index.d.ts",  "default": "./dist/shared/index.js" },
  "#shared/*":  { "types": "./dist/shared/*.d.ts",      "default": "./dist/shared/*.js" },
  "#helper":    { "types": "./dist/helper/index.d.ts",  "default": "./dist/helper/index.js" },
  "#helper/*":  { "types": "./dist/helper/*.d.ts",      "default": "./dist/helper/*.js" },
  "#runner":    { "types": "./dist/runner/index.d.ts",  "default": "./dist/runner/index.js" },
  "#runner/*":  { "types": "./dist/runner/*.d.ts",      "default": "./dist/runner/*.js" }
}
```

Then within `core/core/src/**` rewrite (single scripted pass, depth-independent):
`@blokjs/shared` → `#shared`, `@blokjs/shared/x` → `#shared/x`, same for
`@blokjs/helper`→`#helper`, `@blokjs/runner`→`#runner`. The barrels
(`runtime.ts` etc.) do the same (`export * from "@blokjs/runner"` → `#runner`).

**`core/core/package.json` `exports`** (explicit keys beat the `*` catch-all):

```jsonc
"exports": {
  ".":          { "types": "./dist/index.d.ts",   "import": "./dist/index.js" },
  "./dsl":      { "types": "./dist/dsl.d.ts",      "import": "./dist/dsl.js" },
  "./runtime":  { "types": "./dist/runtime.d.ts",  "import": "./dist/runtime.js" },
  "./testing":  { "types": "./dist/runner/testing/index.d.ts", "import": "./dist/runner/testing/index.js" },
  "./internal": { "types": "./dist/helper/internal.d.ts",      "import": "./dist/helper/internal.js" },
  "./schema":   "./schemas/workflow.v2.json",
  "./package.json": "./package.json",
  "./*":        { "types": "./dist/runner/*.d.ts", "import": "./dist/runner/*.js" }
}
```

The `./*` catch-all makes `@blokjs/core/TriggerBase`, `/handles`,
`/workflow/WorkflowRegistry`, … resolve into the runner subtree — matching the
runner deep-subpaths above. `./internal`, `./dsl`, `./runtime`, `./testing` are
explicit so they win over the catch-all.

**The three shims** (`core/shared`, `core/workflow-helper`, `core/runner`) each
become ~a one-file package: `src/index.ts` = `export * from "@blokjs/core/…"`,
`dependencies: { "@blokjs/core": "workspace:*" }`, keep `deprecated` set, and an
`exports` map forwarding the public subpaths they currently expose. Runner's
`"./*"` wildcard shim needs one re-export stub per public deep-subpath (only the
~12 in the table above are worth forwarding; generate a `dist/<name>.js` =
`export * from "@blokjs/core/<name>"` for each, since an export map can't target
another package's files). shared has no subpaths → single-file shim. helper
forwards `./internal` and `./schema`.

## Execution stages (all in one worktree, land together)

1. **Move source** (git mv, whole subtrees so intra-package relative imports stay intact):
   `core/shared/src`→`core/core/src/shared`, `core/workflow-helper/src`→
   `core/core/src/helper`, `core/runner/src`→`core/core/src/runner`. Move the
   support dirs too: helper `scripts/`, runner proto under `runner/adapters/...`.
2. **Rewrite cross-package imports** in `core/core/src/**` to `#shared`/`#helper`/`#runner` (scripted).
3. **Wire barrels + package.json**: merge deps, add `imports`, rewrite `exports`,
   merge build steps (`sync:proto` path → `dist/runner/...`, `build:schema`, type-test), tsconfig `rootDir` stays `./src`.
4. **Build `@blokjs/core` green** (`tsc`) — iterate. This is the hardest gate.
5. **Relocate tests** into core: `core/{shared,runner}/__tests__`,
   `core/workflow-helper/tests`, and repath their `../src/...` →
   `../src/{shared,helper,runner}/...` (scripted, per source package). Runner's
   32 in-`src` tests move with the subtree (no change). Merge vitest configs.
6. **Convert the three packages to shims** (Target architecture above). Keep their
   dirs + package names + `deprecated`; gut their src to re-export core.
7. **Repoint external consumers** (triggers, nodes, packages/cli, packages/client):
   deps `@blokjs/{runner,shared,helper}` → `@blokjs/core`; imports
   `@blokjs/runner` → `@blokjs/core/runtime` (bare) or `@blokjs/core/<subpath>`;
   `@blokjs/shared` → `@blokjs/core/runtime`; `@blokjs/helper` → `@blokjs/core` /
   `@blokjs/core/internal`. Scripted, then fix stragglers by `tsc`.
8. **Lockstep + release plumbing**: `scripts/release.ts` / `release-preflight.ts`
   enumerate the publishable dirs by `package.json:name` — the shims still
   publish (keep them in the list). Cross-dep ranges: every consumer now pins
   `@blokjs/core@^<v>`; the shims pin core too. Bump the whole set together.

## Verification (the "test everything" gate)

- `bunx nx run-many -t test --skip-nx-cache` → all projects green.
- `bun run release --dry-run` → pre-flight passes (lockstep, cross-dep, tag, clean tree).
- Scaffold audit, **cold cache** (the real proof):
  ```bash
  cd /tmp && rm -rf coreaudit && mkdir coreaudit && cd coreaudit
  npm init -y && npm install @blokjs/trigger-http@<next> \
    --cache "$(pwd)/.npmcache" --no-audit --no-fund 2>&1 | grep -i "npm warn deprecated"
  ```
  MUST print nothing for `@blokjs/{runner,shared,helper}`. Then a full
  `npx blokctl@<next> create project` + `npm audit` = 0 warnings, 0 vulns, and
  the demo `/countries-dsl` workflow still runs (see the v1.6.1 smoke test).
- Adversarially re-verify: the `core/core/src/migration-surface.test.ts` +
  `shim-identity.test.ts` already assert the surface stays complete — keep them
  green; extend if the shim forwarding misses a public export.

## Gotchas found during scoping

- **The cycle** (above) — cannot ship a partial state.
- **`./*` catch-all points at `dist/runner/*`**, so any *shared/helper* file that
  external code imports by deep subpath would NOT resolve — but none do today
  (only `@blokjs/helper/internal`, handled explicitly). Re-grep before finalizing.
- **`@blokjs/runner/testing` resolves to `dist/testing/index.js` today** (a dir),
  not `dist/testing.js`. In core it becomes `dist/runner/testing/index.js` — set
  the explicit `./testing` export accordingly, don't rely on the `*` catch-all.
- **Runner ships a `.proto` at runtime** via `sync:proto`; the copy destination
  moves under `dist/runner/...` and `GrpcCodec`'s proto-load path is relative to
  its own `import.meta`/`__dirname`, so it follows the file — but re-run the grpc
  integration tests specifically.
- **better-sqlite3 native binding** must rebuild for the current Node ABI in the
  worktree (`npm rebuild better-sqlite3`) — same gotcha hit during the security work.
- **Shim export maps can't target another package's files** — each forwarded
  subpath needs a physical re-export stub in the shim's dist.
