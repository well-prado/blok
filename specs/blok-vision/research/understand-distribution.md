Perfect. Now I have enough context. Let me create the comprehensive markdown report:

## How it works today

### Project Configuration (`.blok/config.json`)

**File location**: `{project}/.blok/config.json` (line 744 in `packages/cli/src/services/runtime-setup.ts`)

The config JSON describes:

```json
{
  "triggers": { "kind": TriggerConfig },  // e.g. "http": { kind, label, port, entryPoint, startCmd }
  "runtimes": { "kind": RuntimeConfig },   // e.g. "python3": { port, grpcPort, startCmd, version, cwd }
  "observability": { "module-id": ObservabilityModuleConfig }  // enabled, addedAt, version, settings
}
```

Created via `writeProjectConfig()` (line 718 in runtime-setup.ts), called from `createProject()` (line 1074 in `packages/cli/src/commands/create/project.ts`). Populated with trigger/runtime metadata detected or selected during `blokctl create project` or later via `blokctl runtime add` / `blokctl observability add`.

**Key fields**:
- `TriggerConfig`: kind, label, port, entryPoint, startCmd — how to spawn each trigger
- `RuntimeConfig`: kind, label, cwd (relative path to `.blok/runtimes/{lang}`), grpcPort, startCmd, version, requiredVersion — how to boot non-Node runtimes
- `ObservabilityModuleConfig`: enabled, addedAt, version, settings — tracks opt-in observability modules (metrics, tracing, etc.)

### Node Installation & Distribution

**How @blokjs/* nodes are pulled in:**

1. **Via npm**: Nodes ship as scoped npm packages (`@blokjs/api-call`, `@blokjs/if-else`, `@blokjs/helpers`, etc.) published to a private registry. Defined in `package.json` dependencies with version range `^0.7.0`.

2. **Via `blokctl install node`** (line 22 in `packages/cli/src/commands/install/node.ts`):
   - Fetches registry token via `registryManager.getRegistryToken(token)` calling `/repository-token` endpoint (line 19 in registry-manager.ts)
   - Creates temporary `.npmrc` with `@{namespace}:registry=https://{registry.url}` and auth token
   - Runs `npm install @{namespace}/{node}` 
   - Updates project's `src/Nodes.ts` to import and register the node
   - Cleans up `.npmrc`

3. **Via create scaffold**: When scaffolding a project with `blokctl create project --local {path}`, the CLI clones a specific release tag (`v0.7.0`) from GitHub (line 49 in project.ts) into `~/.blok/blok`, then copies templates + nodes from `{repo}/nodes/{category}/{name}@{version}/`. The `package.json` uses `workspace:*` refs for in-repo deps, replaced with `file:` links or npm version ranges on copy-out.

**Node authoring** (templates in `templates/node/`):
- `config.json`: Node metadata (name, version, description, input/output schemas, config shape) — single source for studio/registry
- `package.json`: deps on `@blokjs/shared`, `@blokjs/runner`, `@blokjs/helper`, Zod
- Nodes use `defineNode()` wrapper (line 37 in `nodes/web/api-call@1.0.0/index.ts`) with Zod schemas for type-safe input/output validation

**Node search** (`blokctl search node`): Calls `/package-list?searchTerm=X&format=npm` (line 20 in search/nodes.ts), returns list from registry. User can `--install` or select interactively.

### Workflow Installation & Distribution

**How workflows are shipped:**

1. **Via file copy**: Examples workflows live in `examples/workflows/{name}.json` (5 built-in: data-pipeline, ecommerce-checkout, scheduled-report, user-registration, webhook-processor). Copied to `{project}/workflows/json/` during scaffold if `--examples` is set.

2. **Via `blokctl publish workflow`** (line 116 in publish/workflow.ts):
   - Loads workflow JSON from `workflows/json/{name}.json`
   - POSTs to `/publish-workflow` endpoint with workflow content + ID
   - Workflow stored server-side (registry/backend)

3. **Via `blokctl install workflow`** (line 23 in install/workflow.ts):
   - Calls `/published-workflow-by-id/{id}` to fetch workflow from registry
   - Writes to `workflows/json/{name}.json`

4. **Workflow definition format**: JSON (line 10 in publish/workflow.ts shows `WorkflowSchema` interface) with structure:
   ```json
   {
     "name", "version", "description",
     "trigger": { "http": {...} | "cron": {...} | ... },
     "steps": [{ "name", "node", "type": "local|module|runtime.python3", "inputs" }],
     "nodes": { "step-id": { "inputs": {...} } }
   }
   ```
   No TypeScript variant for user-authored workflows; TS workflows live only in `examples/ts-workflows/` for demo + multiruntime hello-worlds.

### Example Workflows & Templates

**Shipped with `--examples`**:
- `examples/workflows/`: 5 JSON templates (webhook-processor, data-pipeline, etc.) copied to project
- `examples/ts-workflows/`: runtime-specific hello-world TS workflows + MCP greeter (line 762 in project.ts) copied to `src/workflows/examples/` for each selected runtime
- `examples/templates/`: (directory exists but purpose unclear from grep)
- `triggers/{kind}/src/nodes/`: Trigger-specific nodes (hmac-verify, mapper, error) copied to `src/nodes/`

**Node templates**:
- `templates/node/`: Scaffold for authoring a new node (config.json, package.json, tsconfig.json, src/index.ts)
- `templates/node-function/`: Function-first variant (simplified, no class boilerplate)
- `templates/node-ui/`: For UI/React nodes (babel config for minification)

### Current "Install a Node" End-to-End Flow

1. User runs `blokctl search node {name}`
2. CLI fetches `/package-list?searchTerm={name}` from backend (line 20 in search/nodes.ts)
3. User selects package from results
4. CLI calls `install()` with package name, which:
   - Fetches registry token via `getRegistryToken(token)` (line 66 in install/node.ts)
   - Writes `.npmrc` with scoped registry + auth
   - Runs `npm install @{namespace}/{node}`
   - Parses `src/Nodes.ts`, adds `import {node}` + object entry
   - Deletes `.npmrc`
5. `src/Nodes.ts` now exports node in global nodes registry
6. Workflows can reference `@blokjs/{node}` in step definitions

---

## Seams & Extension Points

1. **Registry backend**: All node/workflow distribution hinges on `/repository-token`, `/package-list`, `/publish-workflow`, `/published-workflow-by-id` endpoints. Currently talks to `https://runner.dac-us-east-1.deskree.com/public/deployment` (line 2 in constants.ts). Could be overridden but no config UI exists.

2. **Package manager abstraction**: `manager as pm` (packages/cli/src/services/package-manager.ts) wraps npm/yarn/pnpm/bun, making it pluggable for non-npm runtimes. Publish flow uses `manager.PUBLISH({registry, npmrcDir})` which returns JSON stdout.

3. **Node registration**: `src/Nodes.ts` is a hand-written registry file that imports all used nodes and re-exports as default. No auto-scan; additions require `blokctl install` to edit the file. Triggers can also carry their own node directories (line 649 in project.ts) merged into global `src/nodes/`.

4. **Workflow loader**: `workflow-loader.ts` reads JSON/YAML/TOML workflows from disk (line 1: `packages/cli/src/services/workflow-loader.ts`). No studio integration yet for visual editing.

5. **Project structure**: Schema is loose — `.blok/config.json` is single source of truth for infra (runtimes/triggers/obs), but project shape is convention (src/nodes, src/triggers, src/workflows, runtimes/{lang}).

6. **Observability modules**: Pluggable; defined in `observability/descriptor.ts`. Each module has `enabled`, `addedAt`, `version`, optional `settings`. `blokctl observability add/remove` manages lifecycle.

---

## Hard Constraints/Invariants

1. **Registry is centralized & authenticated**: No offline mode. `blokctl login` caches token in `~/.blok/local-token.json`. Search/publish/install all require Bearer token.

2. **Nodes are always npm packages**: Cross-runtime support is future work. All shipped nodes are `@blokjs/X` scoped to npm only; Python/Go/etc. SDKs have local node registration (registry pattern, line 47 in AGENTS.md) but no distribution story.

3. **`.blok/config.json` is append-only**: No UI to remove runtimes/triggers/obs modules. `blokctl runtime remove` exists (line 47 in commands/runtime/remove.ts) but mutates config by rewriting entire file.

4. **Workflow definition is JSON-only for distribution**: `examples/ts-workflows` exist for demos but are not the user authoring format. User workflows ship as `.json`, no `.ts` workflows in published form.

5. **Version pinning**: Framework deps lock to `^0.7.0` at create time. `workspace:*` refs inside monorepo are replaced with version range or `file:` links on export.

6. **Trigger versioning**: Triggers are monorepo packages; no independent versioning. `@blokjs/trigger-http`, `@blokjs/trigger-worker`, etc., all release with the framework.

7. **Module discovery is CLI-centric**: No built-in package.json / node-catalog.json to list available nodes. Only `blokctl search` talks to backend.

---

## What Must Change for the Vision

### For Visual Editing (Studio)
- Workflow definition needs round-trip fidelity: JSON → visual canvas → JSON. Currently no "save to canvas" or "export canvas to JSON".
- Node metadata (from `config.json`) must be queryable in studio without npm install — registry should expose node schemas as a catalog API.
- Live node & workflow updates: Changes to `src/Nodes.ts` or `workflows/` need HMR to studio so users see changes without restart.

### For Node/Workflow Marketplace
- **Node catalog API**: `/nodes` endpoint returning paginated list with { name, version, description, inputSchema, outputSchema, namespace }. Current `/package-list` is too sparse.
- **Workflow catalog API**: `/workflows?tags=[]&author=&popularity=` for discovery, filtering, social proof.
- **Versioning for nodes**: Currently all @blokjs/* versioned together. Independently versioned nodes require registry to track versions per package.
- **Metadata enrichment**: Tags, author, downloads, stars, README, changelog. `config.json` only has name/version/description.
- **Distribution for non-Node runtimes**: Python nodes on PyPI, Go on Go modules, Rust on crates.io. Registry must be polyglot.

### For Node Authoring Ergonomics
- **Standalone node packages**: Today nodes live in monorepo under `nodes/{category}/{name}@{version}/` and are published via npm. Move to simpler per-repo structure: `blokctl create node` scaffolds a new npm package, `blokctl publish node` pushes to @blokjs/ namespace (or user's own).
- **No manual Nodes.ts editing**: Auto-discovery of installed nodes (scan node_modules for @blokjs/* + user-installed) and regenerate Nodes.ts, or switch to dynamic require/ESM import.
- **Better if/else/switch authoring**: Today `@blokjs/if-else` is a single node. Vision: first-class branching syntax in workflows, or dedicated nodes for switch/case patterns. Study n8n's branching.

### For Version & Dependency Management
- **Lock files for workflows**: Workflow JSON should pin node versions (`"node": "@blokjs/api-call@1.2.3"`) not just names.
- **Config.json schema versioning**: As config evolves (new keys, new module types), need `"schemaVersion": "1.0.0"` in `.blok/config.json` to migrate old projects.
- **Transitive dependency resolution**: Today nodes pull in @blokjs/shared/@blokjs/runner directly. Registry should track and resolve dependencies (a node may depend on another node).

### For Workflow Definition Format
- **Rethink ".ts" for workflows**: YAML/TOML/JSON are more portable and visual-editor-friendly. TS workflows (Examples.ts line 756+) are demo-only but signal TS is experimental. Standardize on JSON or pick YAML for both examples and user workflows.
- **Expression system ("$" / "js/")**: Today uses `"js/expr"` and `"${var}"` (line 164 in webhook-processor.json). Study n8n's expression editor. Needs visualization + autocomplete in studio.

### For Template/Scaffold Distribution
- **Template registry**: `blokctl create node --template {name}` should list available templates (function-first, class-based, custom framework variants) from registry, not just local templates/.
- **Example workflows as templates**: `blokctl create workflow --from-example webhook-processor` should be discoverable and copyable.

---

## Risks/Gotchas

1. **No offline mode**: Internet-required for search/install/publish. No caching of registry metadata. Bootstrapping a project in a dark environment fails.

2. **Registry is single point of failure**: Deskree backend outage blocks all CLI operations. No graceful degradation (e.g., fall back to npm directly).

3. **Workspace ref replacement is error-prone**: Line 846-868 in project.ts manually replaces `workspace:*` with version ranges or `file:` links. Fragile if package.json format changes or new workspace deps added.

4. **Nodes.ts is hand-authored**: `blokctl install node` naively regex-patches Nodes.ts (line 107-153 in install/node.ts). Breaks if user refactors file or uses non-standard formatting. No AST-based edit.

5. **Implicit node loading via import side-effects**: Node registration happens at import time (line 12 in api-call/index.ts: `export default defineNode(...)`). If a node is imported but not in Nodes.ts global, it's orphaned. No validation that all used nodes are registered.

6. **No node API versioning story**: Node interface is defined by @blokjs/shared. Breaking changes to NodeBase or defineNode() force simultaneous upgrade of all nodes. No semver compatibility checking.

7. **Observability config can diverge from infra**: `.blok/config.json` tracks which obs modules are "enabled" but doesn't validate that the corresponding infra (docker-compose, helm charts) is actually deployed. Config can become stale.

8. **Multi-language runtimes are under-integrated**: Python/Go/Rust/etc. runtimes have their own node registry (e.g., Python: `blok.registry.register()`), separate from npm. No single source of truth for "which nodes exist".

9. **No transitive dependency resolution for nodes**: A user node may import @blokjs/api-call, but if api-call isn't in Nodes.ts, it won't be loaded. Registry doesn't track or surface this.

10. **Example workflows reference nodes that must be copied**: `--examples` copies example nodes (chain-init, hmac-verify) to `src/nodes/` (line 657 in project.ts). If user doesn't ask for examples, a workflow using those nodes fails silently.

11. **Workflow format is JSON-only but editing is text-only**: No studio yet means users must hand-write JSON with complex nesting. Easy to break workflow structure.

12. **Config.json is invisible to users**: Lives in `.blok/`, undocumented in most projects. Users unfamiliar with modular triggers/runtimes may not know it exists, leading to confusion when `blokctl observability add` mutates a file they didn't write.