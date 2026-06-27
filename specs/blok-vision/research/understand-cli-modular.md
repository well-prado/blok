Perfect. Now let me write the comprehensive mapping document:

## CLI Command Framework & Modular-Descriptor Pattern: Architecture Mapping

### How It Works Today

**CLI Bootstrap (packages/cli/src/index.ts:44–245)**
- `blokctl` binary (Bun, shebang at line 1) uses `commander` library (services/commander.ts) as the CLI parser
- Top-level program adds commands via side-effect imports (lines 19–38), each importing a command module
- Analytics wrapper (`PosthogAnalytics`) tracks every command execution (line 87–90)
- Non-interactive mode set via `--non-interactive` flag with preAction hook (lines 94–100)
- `create` is a parent command aggregating subcommands: `create project`, `create node`, `create workflow` (lines 104–207)

**Command Registration Pattern**
- Each command lives in `packages/cli/src/commands/<name>/index.ts` (e.g., `observability/index.ts:11–62`)
- Commands instantiate a `Command` object, add arguments/options, and `.action()` wraps execution with analytics
- Example: `observability` (line 11) → 4 subcommands: `add`, `remove`, `list`, `status` (lines 20–60)
- Same pattern: `runtime` (commands/runtime/index.ts), `nodes`, `install`, `deploy`, `monitor`, etc.

**Project Structure Resolver**
- Shared helpers live in `commands/runtime/shared.ts:11–40` (not runtime-specific despite location)
- `resolveProjectRoot(options.directory)` finds `.blok/config.json` by walking parent dirs
- `readConfigSafe(root)` parses `.blok/config.json` (ProjectConfig: triggers, runtimes, observability)
- Both reused by observability commands (shared.ts:13)

---

### Observability Modular-Descriptor Pattern

**Descriptor Interface (commands/observability/descriptor.ts:49–81)**
```ts
export interface ObservabilityModuleDescriptor {
  id: ObservabilityModuleId;                    // "tracing" | "metrics" | "logging" | …
  label: string;                                 // Display name: "Distributed tracing"
  description: string;                           // One-liner for pickers
  dependencies: ObservabilityModuleId[];         // Auto-resolved on add
  envBlock: (opts: { projectDir }) => string;   // Inert-by-default env config
  infraFiles: string[];                          // Paths under infra/ to copy
  composeServices: string[];                     // docker-compose service names
  packageDeps: Record<string, string>;           // package.json deps to merge
  scaffold?: (opts: ObservabilityScaffoldOpts) => Promise<…>;  // Copy/generate files
  setup?: (opts) => Promise<void>;               // Idempotently write env/config
  verify?: (projectDir) => Promise<{ok, message, dashboardUrl?}>; // Health check
  validate?: (projectDir) => Promise<void>;      // Pre-add validation
  cleanup?: (opts) => Promise<void>;             // Reverse scaffold on remove
}
```

**Registry (descriptor.ts:89–269)**
- `REGISTRY: Record<ObservabilityModuleId, ObservabilityModuleDescriptor>` is the source-of-truth
- Seven modules hardcoded: `obs-stack`, `tracing`, `trace-store`, `metrics`, `logging`, `alerting`, `error-sink`
- Each entry is initialized with foundation stubs; module epics fill in `scaffold`, `setup`, `verify`, `cleanup` via imports (e.g., line 104–110 lazy-imports `obs-tiers.js`)
- `getObservabilityModule(id)`, `allObservabilityModules()`, `resolveWithDependencies(ids)` are the public accessors

**Add Flow (commands/observability/add.ts:30–150)**
1. **Input:** module arg or interactive picker (lines 38–59)
2. **Idempotency check:** if already enabled and not `--force`, exit (lines 71–74)
3. **Dependency resolution:** transitive closure via `resolveWithDependencies()` (lines 77–93)
4. **Validation hooks:** `mod.validate()` for each module (line 113)
5. **Scaffold hooks:** `mod.scaffold()` copies infra (lines 114–118)
6. **Setup hooks:** `mod.setup()` writes env/config (line 119)
7. **Config persist:** merge into `.blok/config.json` (lines 126–127)
8. **Env rewrite:** rebuild `.env.local` managed block (lines 130–134)
9. **Package.json merge:** `mergePackageDeps()` at line 139

**Config Mutations (services/observability-mutations.ts)**
- `withObservabilityModule(config, id, moduleConfig)` — pure; adds to `config.observability` map (lines 19–25)
- `withoutObservabilityModule(config, id)` — pure; removes entry, drops key if empty (lines 32–36)
- `rewriteObservabilityEnvBlock(envContent, moduleBlocks)` — pure; fenced block with delimiters `# >>> Blok observability` (lines 15–16)
  - Idempotent: strips old block, rebuilds from module env blocks
  - Rejects `BLOK_METRICS_ENABLED` (metrics on-by-default; only `BLOK_METRICS_DISABLED=1` allowed)

**Remove Flow (commands/observability/remove.ts:17–90)**
1. Parse module id, validate exists
2. Warn about dependent modules (line 40)
3. Confirm (skipped with `--yes`)
4. Run `mod.cleanup()` if present (line 58)
5. Drop from config, rewrite env (lines 61–71)
6. Note: infra files left unless `cleanup()` deletes them (line 74–85)

**List & Status (list.ts, status.ts)**
- `list`: shows enabled modules + available to add, optional `--json` (list.ts:11–70)
- `status`: runs `mod.verify()` on each enabled module, shows health + dashboard URL (status.ts:13–47)

---

### Seams & Extension Points

**1. Descriptor Registration**
- **Seam:** `REGISTRY` constant in descriptor.ts is hardcoded (line 89)
- **Extension:** Module epics (e.g., MO-TRACING) import and re-export an extended registry OR mutate the existing one
- **Current:** obs-stack's scaffold hook lazy-imports `obs-tiers.js` (line 104); no dynamic loader yet

**2. Hook Injection Points**
- `scaffold`: module copies files, generates config (can be expensive, fails leave SDK dir clean)
- `setup`: write env vars, run migrations, register with an external service
- `verify`: probe health (curl endpoints, parse env, check file presence)
- `cleanup`: unwind setup; **not required** — infra files are left by design so operator edits survive
- **Current:** all hooks are optional; foundation stubs are no-ops or empty

**3. Command Subcommand Pattern**
- Each top-level cmd (observability, runtime, nodes) is a parent `Command` object
- Subcommands added via `addCommand()` (e.g., observability.ts:20–60)
- Option `-d, --directory <path>` is standard for project-aware commands
- **Extension point:** add new subcommands by creating a `.ts` file and calling `observability.addCommand(newCmd)`

**4. .blok/config.json Schema (services/runtime-setup.ts:95–100)**
```ts
export interface ProjectConfig {
  triggers?: Record<string, TriggerConfig>;
  runtimes?: Record<string, RuntimeConfig>;
  observability?: Record<string, ObservabilityModuleConfig>;  // Flat map: id → {enabled, addedAt, version, settings}
}
```
- Additive: new top-level keys (e.g., `workflows?`) can be added without breaking existing configs
- Module-specific state under `settings` (e.g., obs-stack stores `{ tier: "lite" }`)

**5. .env.local Fencing**
- Delimiter markers: `# >>> Blok observability (managed by blokctl) >>>` and `# <<< …<<<` (lines 15–16)
- **Contract:** only the CLI rewrites inside the fence; user edits outside survive
- Other components (runtime, future modular-X) can use similar fencing with their own markers

**6. Analytics Tracking**
- Every command action wrapped with `analytics.trackCommandExecution()` (index.ts:126–128)
- Captures command name + options + execution time
- **Extension:** new commands auto-tracked by pattern (no special registration needed)

---

### MCP Trigger Architecture

**Workflow Opt-In (triggers/mcp/src/McpTrigger.ts:13–25, examples/mcp-greeter.ts)**
```ts
export default workflow({
  name: "search_code",
  input: z.object({ query: z.string() }),
  trigger: { mcp: {
    path: "/mcp",
    serverName: "tetrix-platform",
    tool: { description: "Search the indexed codebase" }
  }},
  steps: [ … ]
});
```
- `trigger.mcp` config key; stored in workflow's `_config` (builder) or root (JSON)
- `input` Zod schema → JSON-Schema via `zod-to-json-schema` (line 65, function `toInputJsonSchema` at line 157)
- Optional fields: `serverName` (default: "blok-mcp"), `serverVersion`, `transports` (default: ["sse", "streamable-http"]), `tool.name`, `resource.uri`

**Registry Scan (McpTrigger.ts:259–315)**
- Trigger reads `WorkflowRegistry` at boot (line 271)
- For each workflow with `trigger.mcp` config, groups by `(path, serverName)` (lines 272–292)
- Each group becomes one MCP **server** hosting multiple **tools** (line 129–130: `ServerGroup`)
- Tools extracted from workflows; resources extracted if `cfg.resource` present (lines 295–311)

**Transport Multiplexing (McpTrigger.ts:451–540)**
- **SSE (legacy 2024-11-05):** `GET /path/sse` opens stream, `POST /path/messages?sessionId=…` for JSON-RPC (lines 464–516)
  - Sessions tracked in `sseSessions` map (line 202)
  - Identity parsed from `x-user-context` header (line 476) into `McpUserContext: {userId, email}` (line 72–75)
- **Streamable-HTTP (current official):** stateless single `ALL /path` endpoint (lines 518–540)
  - Fresh MCP server + transport per request
  - Same user context parsing (line 525)

**Workflow Dispatch (McpTrigger.ts:372–445)**
- Tool call → `dispatchTool()` (lines 372–388)
- Resource read → `dispatchResource()` (lines 390–392)
- Both route through `runWorkflow()` (lines 400–445):
  1. Get workflow from registry, init Configuration
  2. Build ctx with `args` as `ctx.request.body`, user context in `ctx._mcp`
  3. Run middleware chain + workflow
  4. Return `ctx.response.data` as tool result
  5. Metrics: `blok_mcp_tool_calls_total`, `blok_mcp_sse_sessions_total` (lines 187–194)

**Same-Port Orchestration (triggers/http/src/index.ts:27–48)**
- HTTP server entry point creates **one shared** `Hono<AppBindings>` app (line 33)
- Passes to HttpTrigger, WebSocketTrigger, SSETrigger, WebhookTrigger, McpTrigger (lines 34–38)
- All share the same NodeMap / WorkflowRegistry (lines 43–47)
- Boot order: WS/SSE/Webhook register hooks, then HttpTrigger.listen() fires pre-catch-all hooks, mounts routes, starts server (lines 61–65)
- **Hook mechanism:** `HttpTrigger.addPreCatchAllHook(cb)` (HttpTrigger.ts), called at line 229 during registry scan
  - Routes registered BEFORE the catch-all `/:workflow{.+}` (line 49, WorkflowRouter)
  - Prevents catch-all from matching explicit MCP/SSE/WS routes

**Identity & Credentialing (McpTrigger.ts:72–75, 141–153)**
- `x-user-context` header or `?user_context=` query param carries base64-encoded `{userId, email}`
- Parsed by `parseUserContext()` (lines 142–153), passed to `ctx._mcp.userContext`
- **NOT access control** — no scoping; app handles authorization
- Redacted in logs by global sanitizer middleware

---

### Hard Constraints & Invariants

**1. Idempotency**
- `blokctl observability add --force` re-applies even if enabled (add.ts:71)
- `blokctl runtime add --force` reinstalls (runtime/add.ts:87–101)
- **Critical:** config writes + env rewrites must be pure or at least stable across reruns
- Env rewrite is idempotent by design (fence-based, strips then rebuilds)

**2. Dependency Ordering**
- Observability modules can depend on others; transitive closure is resolved at add time (descriptor.ts:285–302)
- Remove warns but doesn't force dependent removal (remove.ts:40–46) — operator's call
- **No circular dependencies** — resolver will infinite-loop if present

**3. Project Root Resolution**
- `.blok/config.json` is the anchor; search walks up parent dirs (resolveProjectRoot logic)
- Monorepo: each Blok app has its own `.blok/config.json`; observability state is per-root
- **No global registry** — all state is file-based and local

**4. Env Block Fencing**
- Delimiters MUST be exact: `# >>> Blok observability (managed by blokctl) >>>` (observability-mutations.ts:15)
- Content between delimiters is **replaced wholesale** on every add/remove (rewriteObservabilityEnvBlock)
- User comments/config outside fence are never touched
- **Contract violation:** if a user manually edits inside the fence, next CLI run overwrites

**5. Trigger Route Precedence**
- MCP/SSE/WebSocket routes mount BEFORE the HTTP catch-all (orchestration pattern)
- Enforced via `addPreCatchAllHook()` firing before catch-all mount (HttpTrigger.listen)
- **Seam:** if a future trigger forgets to register a hook, its routes lose to catch-all

**6. MCP Server Grouping**
- All workflows sharing the same `(path, serverName)` are aggregated into one server (McpTrigger.ts:272–292)
- If two workflows have the same tool name but different inputs, later one wins (no validation)
- **Invariant:** tool names must be unique within a server group

**7. Transport Statefulness**
- SSE is stateful: sessions tracked in-memory (sseSessions map, line 202)
- Streamable-HTTP is stateless: fresh server per request
- **Implication:** SSE sessions don't survive process restart; Streamable-HTTP is fine

---

### What Must Change for the Vision

**1. Modular Triggers (Goal: "add/remove triggers like observability")**
- **Current:** Triggers are hardcoded in the framework (HTTP, WS, SSE, Webhook, MCP, gRPC, Cron, PubSub, Worker)
  - Each trigger is a separate package in `triggers/<name>/`
  - Boot orchestration is baked into `triggers/http/src/index.ts` (line 27–48)
- **Required changes:**
  - Create a `TriggerModuleDescriptor` interface mirroring `ObservabilityModuleDescriptor` (id, label, deps, setup/cleanup hooks)
  - Add a trigger registry (like observability's REGISTRY) to list available triggers
  - CLI commands: `blokctl trigger add <name>`, `blokctl trigger remove`, `blokctl trigger list`
  - Move orchestration logic out of App class → dynamic trigger loader (iterate enabled triggers, wire hooks)
  - **Seam:** descriptor entry point for each trigger package (e.g., `triggers/http/descriptor.ts` exporting a descriptor)
  - **Risk:** bootstrapping the HTTP trigger itself (can't add it if it's the bootstrap server)

**2. Modular Node/Workflow Install (Goal: "CLI + MCP-based AI install of nodes/workflows")**
- **Current:** Nodes are discovered at startup by scanning `runtimes/<lang>/nodes/` (file-based)
  - Workflows scanned from `workflows/` directory
  - No CLI to install a node/workflow from a registry
- **Required changes:**
  - Node registry interface: `NodeModuleDescriptor` (id, version, runtime, entry point, dependencies)
  - Workflow registry interface: `WorkflowModuleDescriptor` (id, version, triggers, nodes it needs, input/output schemas)
  - CLI: `blokctl install node @org/name@1.0.0 --runtime=node`, `blokctl install workflow @org/name@1.0.0`
  - **Seam:** registry service (local package.json-like manifest or remote API)
  - Backend: download from a CDN/npm/marketplace, unpack to `runtimes/<lang>/nodes/` or `workflows/`, update config
  - MCP skill: expose node/workflow list + install as MCP resources/tools (Claude Code invokes `blokctl install node ...`)

**3. CLI Install from MCP (Goal: "Install nodes/workflows via MCP and/or CLI+Skills")**
- **Current:** No MCP surface for CLI commands
  - No structured node/workflow discovery over MCP
- **Required changes:**
  - Add MCP **resources** for available nodes (uri: `blok://nodes/list`, `blok://node/@org/name/manifest`)
  - Add MCP **tools** for installation: `install_node`, `install_workflow`, `list_nodes`, `list_workflows`
  - These tools invoke the CLI under the hood (or directly call the installation logic)
  - Workflow auth: carry user identity from Claude Code → blokctl session (project token)
  - **Seam:** expose the Blok SDK's registry client as an MCP-callable service

**4. Create-Time Modular Picker (Goal: "Build NEW workflows visually; Observability + Triggers + Nodes at create")**
- **Current:** `blokctl create project` accepts flags for triggers + runtimes + obs modules (index.ts:110–120)
  - Single picker for observability stack tier (--obs-stack, line 116)
  - But wired into project creation, not composable
- **Required changes:**
  - Decouple observability picker into a shared "module selector" component
  - At `create project`, show pickers for:
    1. Which triggers to enable (HTTP by default; add MCP, WebSocket, etc.)
    2. Which runtimes (Node by default; pick Python3, Go, etc.)
    3. Which observability modules (none by default; pick Tracing, Metrics, etc.)
    4. Which starter nodes/workflows to scaffold (examples, or community marketplace)
  - **Seam:** picker logic is a pure function (given available modules, return selected ids)
  - CLI calls it interactively; MCP can call it non-interactively with pre-selected options

**5. Rework .ts Workflow Definition (Goal: "Evaluate whether .ts is the best format at all")**
- **Current:** Workflows are authored as TypeScript (helpers/src/workflow builder), compiled to JSON at build time
  - Stored as `.ts` files in `workflows/`
  - Triggers stored in workflow's `_config` on the builder
- **Required changes:**
  - Compare `.ts` authoring vs. `.json` (vs. YAML, Jsonnet, Dhall)
  - Evaluate visual canvas → JSON export (Studio generates deployable JSON)
  - Trade-off: TypeScript is expressive (full JS, easy IDE support) but loses visual edit-ability
  - Recommendation: keep TypeScript for hand-authored workflows, accept JSON from visual canvas + MCP/CLI installs
  - **Implication:** workflow format becomes a choice; migration tooling needed if default changes

**6. Expression System & Branching Ergonomics (Goal: "Better if-else/switch, ctx vars, $ expressions")**
- **Current:** `@blokjs/expr` step evaluates plain JavaScript (mcp-greeter.ts:54)
  - Ctx vars injected into scope; no explicit binding
  - "$" prefix for expressions is adhoc (not standard)
- **Required changes:**
  - Standardize expression syntax (e.g., `${ expression }` as a Workflow DSL convention)
  - Add first-class if/else/switch step types (not just expr nodes)
  - Expose ctx as a stable variable name (not auto-inject)
  - Document expression scoping in the visual canvas + CLI help

---

### Risks & Gotchas

**1. Config Drift & Version Skew**
- **Risk:** Observability modules added by Blok v0.6.0, then project upgraded to v0.8.0. Old scaffold may be stale.
- **Mitigation:** `ObservabilityModuleConfig.version` records framework version (add.ts:98). Future `observability upgrade` can detect and re-scaffold.
- **Gotcha:** If a module's `scaffold()` hook is removed or changes in a breaking way, old projects can't upgrade cleanly.

**2. Partial Failures in Multi-Step Setups**
- **Risk:** `blokctl observability add logging` requires trace-store. If trace-store setup fails halfway, logging is left dangling (config written, but env/infra incomplete).
- **Mitigation:** add.ts does validation + scaffold BEFORE config write (line 101–123). On failure, SDK dir is cleaned (line 142) but config is not written. However, env rewrite (line 134) happens after config, so if it fails, config is persisted but env is incomplete.
- **Fix needed:** Wrap steps 6–7 (config + env write) in a transaction OR do env write first, then config.

**3. Hook Lazy-Import Failures**
- **Risk:** obs-stack's `scaffold()` lazy-imports `obs-tiers.js` (line 104). If import fails at runtime, the error isn't caught until add time.
- **Mitigation:** None currently. Module epics must test their lazy imports.
- **Recommendation:** Load & validate all hooks at descriptor-registry time, not at add time.

**4. SSH Transport for MCP**
- **Risk:** MCP SSE sessions are in-memory (sseSessions map, line 202). If the Node process crashes or is restarted, active IDE sessions lose connection.
- **Mitigation:** Streamable-HTTP is stateless, but SSE is not. Users connecting over SSH or unstable networks will experience reconnects.
- **Implication:** Remove SSE from default transports? Or add reconnection logic to IDE MCP clients?

**5. Circular Module Dependencies**
- **Risk:** Module A depends on B, Module B depends on A. Resolver will infinite-loop.
- **Mitigation:** None; resolver has no cycle detection (descriptor.ts:290).
- **Fix:** Add a visited set to `resolveWithDependencies()` or assert acyclicity at descriptor registration time.

**6. Same-Port Trigger Conflicts**
- **Risk:** Two workflows on different ports (e.g., MCP at /mcp, WebSocket at /ws). HTTP catch-all matches first. If `/mcp` is not registered before catch-all, it becomes an HTTP route.
- **Mitigation:** Hook system (addPreCatchAllHook) ensures routes register before catch-all. But if a new trigger forgets the hook, silent loss.
- **Safeguard:** Document the orchestration pattern; consider a validation step at boot (e.g., assert all registered triggers have explicit routes, not relying on catch-all).

**7. User Context Loss in Observability Tracing**
- **Risk:** MCP carries `x-user-context` to workflows (McpTrigger.ts:417). But observability modules (tracing, logging) don't know about user context; traces don't tag the user.
- **Mitigation:** User context should be injected into ctx.request.headers, then extractable by observability middleware.
- **Current state:** tracing module doesn't consume user context. Fix: update tracing's verify/setup to tag spans with user when present.

**8. Env Block Encoding & Special Chars**
- **Risk:** Module `envBlock()` returns raw strings. If a module includes a newline or a delimiter substring, fence parsing breaks.
- **Mitigation:** None; descriptors are trusted to return well-formed env blocks.
- **Safeguard:** Add escaping / validation to `rewriteObservabilityEnvBlock()`.

**9. MCP Tool Name Collisions**
- **Risk:** Two workflows with the same tool name in the same server group. Latter silently overrides.
- **Mitigation:** None; McpTrigger.ts doesn't validate uniqueness.
- **Fix:** At registry scan (getServerGroups), detect collisions and throw or warn.

---

This mapping reflects the codebase state as of June 2026 and is accurate for the vision roadmap planning phase.