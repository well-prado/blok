Perfect. The brief is complete and saved. Let me return the final output:

## Trigger Framework Map: Complete

I've mapped the Trigger framework systematically. Here's the executive summary:

**Today:** Triggers are hardwired into Blok as 8 independent subclasses of `TriggerBase` (HTTP, Worker, Cron, Webhook, WebSocket, SSE, gRPC, MCP). Each has its own package with `listen()` override + config reading. HTTP-family triggers (Webhook, WebSocket, SSE) share a single Hono app via callback injection.

**Seams & extension points (8 key ones):**
1. `getTriggerType()` — customize run-record tags
2. `extractDispatchPayload()` — persist dispatch state for durability
3. `applyMiddlewareChain()` — trigger-level middleware resolution
4. `registerWorkflowsFromNodeMap()` — populate WorkflowRegistry for worker/cron
5. `seedGlobalMiddlewareFromEnv()` — BLOK_GLOBAL_MIDDLEWARE env var
6. HMR hooks — `onHmrNodeChange/WorkflowChange/TriggerChange`
7. Hono app sharing — callback injection for post-server startup
8. Lifecycle hook bundle — crash auto-flip, orphan recovery, janitor, graceful shutdown

**Hard constraints:**
- TriggerBase abstract; each family binds its own socket/queue
- Configuration immutable per instance; worker passes fresh per-job to avoid mutation
- Middleware registry singleton; no hot-reload without restart
- Shared Hono app can't dynamically mount/unmount routes after server live
- Single scheduler + crash/shutdown handler per process (idempotent)

**What must change:** Currently triggers are auto-imported (HttpTrigger deps declare WebSocket/SSE/Webhook in package.json) with no discovery mechanism, no config block in `.blok/config.json`, no CLI commands. The vision needs:
1. `TriggerDescriptor` interface + registry (mirroring observability module pattern)
2. CLI commands: `blokctl trigger add/remove/list/status`
3. `.blok/config.json` `triggers` block with dependency resolution
4. Package decoupling via peer-deps + dynamic imports
5. Configuration.ts validation against enabled triggers
6. Port + socket conflict detection in setup hooks

**Risks:** Port collisions, dependency cycles, existing deployment migration, sibling coupling to HTTP, orphaned infra, version skew, concurrent scheduler writes (12 total enumerated).

The full brief (1000+ lines) is in the scratchpad with file:line refs, code examples, and detailed precedent from the observability system (the exact pattern to mirror).