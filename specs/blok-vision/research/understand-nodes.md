## Node Model & Packaging: Reality Map

### How it works today

**Node Definition (defineNode)**
- `core/runner/src/defineNode.ts:344` — `defineNode({name, description, input: Zod, output: Zod, execute()})` factory returns a `FunctionNode` instance (extends `BlokService<T>`).
- `defineNode.ts:89–299` — `FunctionNode` wraps the user function, handles Zod validation on input/output, maps errors to `GlobalError`, and bridges to `BlokService.run()`.
- Zod schemas are converted to JSON Schema (via `zod-to-json-schema`) at line 126 for backward compatibility with the legacy JSON Schema validator.
- Flow control nodes set `definition.flow = true` at line 115; the runner recognizes them and calls `processFlow()` instead of `process()` (RunnerSteps.ts).

**Node Base Class (NodeBase)**
- `core/shared/src/NodeBase.ts` — abstract base (shared across all runtimes).
- Core fields: `name`, `contentType`, `active`, `stop`, and V2 knobs (`as`, `spread`, `ephemeral`, `idempotencyKey`, `retry`, `subworkflow`, `wait`, `maxDurationMs`).
- `process(ctx, step)` and `processFlow(ctx)` abstract methods; `run(ctx)` to be implemented.
- `blueprintMapper` resolves `${path}` and `js/...` expressions in step inputs before execution.

**Node Registration (GlobalOptions → Configuration)**
- `core/runner/src/types/GlobalOptions.ts` — tuple of `{nodes: NodeMap, workflows: WorkflowLocator}`.
- `NodeMap` (src/NodeMap.ts:3) — simple `Map<string, NodeBase>` with `addNode(name, node)` and `getNode(name)` methods.
- Workflow authors register nodes: `const opts = {nodes: new NodeMap(); opts.nodes.addNode("@blokjs/api-call", apiCallNode); ...}` then pass `opts` to `Configuration.init()`.

**Node Resolution at Runtime (Configuration)**
- `Configuration.nodeResolver` (src/Configuration.ts:423) dispatches by `node.type` key:
  - **`"module"`** (src/Configuration.ts:626) — `moduleResolver(node, opts)` calls `opts.nodes.getNode(node.node)` to fetch from the GlobalOptions registry. Clone the node and set step-level metadata (`name`, `node`, `type`, `active`, `stop`).
  - **`"runtime.python3"`, `"runtime.go"`, etc.** (src/Configuration.ts:492) — `runtimeResolver(node)` wraps a `RuntimeAdapter` in `RuntimeAdapterNode` for gRPC dispatch to external SDKs.
  - **`"subworkflow"`** (src/Configuration.ts:573) — `subworkflowResolver(node)` creates a `SubworkflowNode` that looks up the child workflow by name in `WorkflowRegistry`.
  - **Control flow** (`"forEach"`, `"loop"`, `"switch"`, `"tryCatch"`) — each has a dedicated resolver that creates the corresponding node class.

**Current Node Packaging (nodes/{category}/{name}@{version})**
- Directory layout: `nodes/web/api-call@1.0.0/`, `nodes/control-flow/if-else@1.0.0/`, `nodes/utility/helpers@1.0.0/`.
- Each has its own `package.json` with `"name": "@blokjs/<node-name>"` (e.g., `"@blokjs/api-call"`), versioned in the directory name but NOT in package.json version field.
  - **Confusing duality**: package.json `"version": "0.7.0"` is shared across all nodes (monorepo bump). Directory `@1.0.0` suffix signals intent but is NOT enforced.
- Dependencies: `@blokjs/runner`, `@blokjs/shared`, `zod` (Zod is universal for all node input/output schemas).
- Build: `tsc` → `dist/index.js`, export a `defineNode` instance as default.
- `nodes/utility/helpers@1.0.0/src/index.ts:94–119` — exports `HELPER_NODES` map prebuilt for convenience: `{"@blokjs/expr": ExprNode, "@blokjs/throw": ThrowNode, ...}`.

**Workflow Step Reference**
- Step `use: "@blokjs/api-call"` field maps to `node.type = "module"` internally; at runtime, Configuration looks up `"@blokjs/api-call"` in `GlobalOptions.nodes`.
- Workflow definition (helper/src/types/StepOpts.ts): `use` is mandatory for module steps; flow nodes carry `steps` arrays; subworkflow steps carry `subworkflow: string` name.

### Seams & extension points

1. **Node discovery**: `GlobalOptions.nodes` is hardcoded in the trigger setup; nodes are manually registered. No auto-discovery or npm-install-then-import pattern yet.

2. **Version binding**: Directory name carries semver (`@1.0.0`) but `package.json` version is monorepo-global. A consumer importing `@blokjs/api-call` from npm would get the shared version, not the intent-versioned one.

3. **Input/output schema reflection**:
   - `FunctionNode.getReflectionSchemas()` (defineNode.ts:282) — lazily converts Zod to JSON Schema for the node catalog (`/__blok/nodes` REST API).
   - Legacy nodes (class-based, non-defineNode) expose `inputSchema` / `outputSchema` fields directly; defineNode wraps them as `{}` (permissive) during `run()` so Zod is the only true validator.

4. **Runtime adapter contract**:
   - `RuntimeAdapterNode` (src/RuntimeAdapterNode.ts) wraps external SDKs (Python, Go, etc.) via gRPC.
   - Node can declare `runtimeRequirements` (e.g., `{ python3: ">=3.11.0" }`); validated at load time by `RuntimeVersionValidator`.

5. **Middleware & node interception**:
   - Nodes are opaque to the runner; no hook for node-level middleware (e.g., auth check, logging per node).
   - Workflow-level middleware wraps the entire workflow (v0.5.2); step-level middleware doesn't exist.

6. **Flow control**: Nodes can be flow nodes (`flow: true`) and return `NodeBase[]` instead of data. The runner intercepts and recurses into the returned steps. Enables if-else, switch, forEach, loop, tryCatch patterns.

### Hard constraints/invariants

1. **Node identity**: A node is identified by its `name` field (Zod definition). There is NO separate package name ↔ node name mapping; `@blokjs/api-call` IS the name both as a package and as a step `use:` reference.

2. **Monorepo versioning**: All nodes in `nodes/**/**` share the same `package.json` version bump. Independent per-node versioning is not possible today without breaking the workspace build.

3. **Zod is mandatory for input/output**: `defineNode` requires `input: z.ZodTypeAny` and `output: z.ZodTypeAny`. Legacy class-based nodes can skip Zod but must define `inputSchema`/`outputSchema` (JSON Schema).

4. **GlobalOptions must be provided at boot**: Nodes are NOT auto-imported from `node_modules/@blokjs/*`; they must be explicitly registered in `GlobalOptions.nodes` before `Configuration.init()` is called. This is a deliberate design to keep the runner fast and deterministic (no FS scanning, no require-all pattern).

5. **One-to-one node-per-package (current practice)**: Each directory is one node. `helpers@1.0.0/src/index.ts` exports a pre-built `HELPER_NODES` map containing 20+ nodes, but they're all in one package. Splitting them into separate npm packages would require separate directories + workspace entries.

6. **No version negotiation**: A workflow references `use: "@blokjs/api-call"`; the runner fetches whatever version is registered in `GlobalOptions.nodes`. If two versions are needed, they must both be imported and registered under different names (e.g., `@blokjs/api-call@1` and `@blokjs/api-call@2`), which breaks the naming convention.

### What must change for the vision

**For independently-publishable, independently-versioned nodes:**

1. **Decouple package name from node name**.
   - Today: `"name": "@blokjs/api-call"` in package.json IS the node name in workflows.
   - Required: Node name (for step `use:` references) should be independent of npm package name.
   - Example: package `@blokjs/api-call@^1.2.0` could export nodes named `api-call` + `api-call-v2` (or with full scope + version: `@blokjs/api-call/v1`, `@blokjs/api-call/v2`).

2. **Auto-discovery + lazy loading of installed nodes**.
   - Today: manual registration in `GlobalOptions` before `Configuration.init()`.
   - Required: scan `node_modules/@blokjs/*` at trigger boot, dynamically import each package's main export, auto-register all exported nodes.
   - Trade-off: slower boot (FS scan + dynamic imports) vs. explicit registation. Must decide on opt-in (env var `BLOK_SCAN_NODES=true`) or default.

3. **Per-node versioning in npm registry**.
   - Today: nodes are part of the monorepo, bumped together via changesets.
   - Required: each node is a separate npm package with its own `package.json`, versioned independently.
   - Implication: the monorepo structure `nodes/{category}/{name}@{version}/` becomes the published package structure on npm (e.g., `@blokjs/api-call`, `@blokjs/if-else`, etc., each with independent semver).

4. **Version resolution in workflows**.
   - Today: `use: "@blokjs/api-call"` is versionless; runs whatever is registered.
   - Required: workflows must specify a version constraint OR pin a version for reproducibility (e.g., `use: "@blokjs/api-call@^1.0.0"` or `use: "@blokjs/api-call@1.2.3"`).
   - Implementation: Configuration.moduleResolver() would parse the version constraint, fetch from the node registry, and instantiate the matching version.

5. **Node registry / marketplace**.
   - Today: nodes are co-located in the monorepo or manually imported from external npm packages.
   - Required (long-term vision goal #3): a central "npm for Blok" website listing all published nodes, their schemas, versions, and download counts.
   - Short-term: just make npm packages discoverable (standard `@blokjs/` scope + clear naming convention).

6. **Middleware hook at node instantiation**.
   - Today: nodes are instantiated once per workflow load in Configuration.getSteps().
   - Required: allow per-node middleware (auth, logging, observability) without wrapping the entire workflow.
   - Example: `@blokjs/api-call` could declare a middleware that logs every API call or validates rate limits.

### Risks/gotchas

1. **Breaking change**: Redefining node identity will break existing workflows that reference `use: "@blokjs/api-call"` if the package is renamed or versioning changes.
   - Mitigation: semver the workflow schema (v1 = versionless `use`, v2 = versioned `use`).

2. **Node registry lock-in**: once nodes are independently published, a broken update (e.g., `@blokjs/api-call@2.0.0` introduces a regression) can silently break workflows in production if version constraints are loose (`^2.0.0`).
   - Mitigation: workflows should pin exact versions; provide a `blokctl pin-node-versions` migration tool.

3. **Import size explosion**: scanning `node_modules/@blokjs/*` at boot could load 100+ node packages if not lazy. Each import is slower.
   - Mitigation: lazy-load only nodes referenced in the workflow's steps; require an explicit allowlist.

4. **Monorepo still owns `@blokjs/runner` and `@blokjs/shared`**: Core deps are not versioned per-node. A breaking change in @blokjs/runner forces all nodes to update.
   - Mitigation: maintain backward compatibility in runner/shared for 2+ major versions; version it separately from nodes.

5. **Cross-runtime SDK nodes (Python, Go, etc.)**: Today, external SDK nodes are wrapped via `RuntimeAdapterNode` and gRPC. If they're published independently, who owns the versioning? The Blok core team (versioning in sync with the monorepo) or per-SDK teams?
   - Decision needed: define the gRPC protocol version boundary. Decouple Blok runner version from Python/Go/Rust SDK versions.

6. **Circular deps between nodes**: if Node A (e.g., orchestrator) calls Node B (e.g., database query) via subworkflow dispatch, and both are independently versioned, dependency resolution becomes complex.
   - Non-issue for now; rare pattern. Surfaces if we add explicit node-to-node import syntax.

---

**File references for deeper dives:**
- Core model: `/core/runner/src/defineNode.ts` (FunctionNode), `/core/shared/src/NodeBase.ts` (base)
- Resolution: `/core/runner/src/Configuration.ts` (nodeResolver, moduleResolver, runtimeResolver)
- Packaging: `/nodes/web/api-call@1.0.0/package.json` (structure), `/nodes/utility/helpers@1.0.0/src/index.ts` (HELPER_NODES map)
- V2 persistence: `/core/runner/src/workflow/PersistenceHelper.ts` (state output rules)