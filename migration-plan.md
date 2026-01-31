# Migration Plan: Node.js + Express -> Bun + Hono

> **Created:** 2026-01-31
> **Status:** Phase 1 in progress
> **Goal:** Migrate the entire Blok framework from Node.js + Express + pnpm to Bun + Hono + bun workspaces

## Decisions Made
- **Package manager**: Migrate from pnpm to `bun install`
- **Test framework**: Keep Vitest, switch coverage from v8 to istanbul
- **SQLite**: Dual-runtime adapter (bun:sqlite + better-sqlite3 fallback)
- **Module system**: Convert all packages from CommonJS to ESM

---

## Bun Compatibility Assessment (Node.js APIs)

### Fully Compatible (LOW risk) - ~40+ APIs
`path.*`, `os.*`, `events.EventEmitter`, `Buffer`, `timers`, `fetch`, `AbortController`, `performance.now()`, `process.env/cwd/exit/argv/pid/platform`, `process.on("SIGINT"/"SIGTERM"/"exit")`, `util.promisify`, `fs.existsSync/readFileSync/writeFileSync/mkdirSync/chmodSync/unlinkSync`, `fs/promises.readdir/stat`, `crypto.randomBytes/createHash/scryptSync/createCipheriv/createDecipheriv/randomUUID/X509Certificate/generateKeyPairSync/createPrivateKey`

### Needs Attention (MEDIUM risk)
| Issue | Location | Workaround |
|-------|----------|------------|
| `fs.watch({recursive:true})` on Linux | `core/runner/src/hmr/FileWatcher.ts` | Works on macOS; Linux has edge cases in Bun. HMR is dev-only so practical risk is low |
| `crypto.createSign()` case sensitivity | `core/runner/src/security/TLSConfig.ts` | Verify algorithm string uses uppercase (e.g., `'RSA-SHA256'`) |
| MongoDB driver memory leaks under Bun | `triggers/http` (mongodb dep) | Monitor in production; Bun team is aware |
| `@opentelemetry/sdk-trace-web` | `triggers/http/src/runner/metrics/` | Works, but consider `sdk-trace-base` instead |

### Blockers (must fix)
| Issue | Location | Solution |
|-------|----------|---------|
| `process.kill(-pid)` (negative PID) | `packages/cli/src/commands/dev/index.ts:47` | Replace with platform-specific kill via system `kill` command or individual PID tracking |
| `better-sqlite3` native addon | `core/runner/src/tracing/SqliteRunStore.ts` | Dual adapter: `bun:sqlite` when Bun detected, `better-sqlite3` fallback |

---

## Phase 1: Package Manager Migration (pnpm -> bun)

### Files to modify:
- `package.json` (root) - Add `"workspaces"`, remove `"packageManager"` and `"engines.pnpm"`, convert pnpm filter commands
- `pnpm-workspace.yaml` - Keep as reference, then delete after validation

### Steps:
1. Add `"workspaces"` to root `package.json`:
   ```json
   "workspaces": ["core/*", "nodes/**/**", "triggers/*", "templates/**/**", "packages/*", "apps/*"]
   ```
2. Remove `"packageManager": "pnpm@10.14.0"` and `"engines": { "pnpm": ">=10.2.0" }`
3. Convert root scripts from `pnpm --filter X` to `bun run --filter X`
4. Convert `onlyBuiltDependencies` from `pnpm-workspace.yaml` to `"trustedDependencies"` in root package.json
5. Run `bun install` to generate `bun.lockb`
6. Add `pnpm-lock.yaml` to `.gitignore` (or delete it)
7. Update `lint-staged` config: replace `"pnpm run test"` with `"bun run test"`
8. Delete `pnpm-workspace.yaml` after validation

---

## Phase 2: Module System (CommonJS -> ESM)

### Packages to convert (in dependency order):
1. `core/shared` - no deps on other workspace packages
2. `core/workflow-helper` - depends on shared
3. `core/runner` - depends on shared + helper
4. `nodes/*` - depends on runner + shared
5. `triggers/*` - depends on runner + shared + helper
6. `packages/cli` - already ESM, just verify

### Per-package changes:

#### For each package.json:
- Add `"type": "module"`
- Keep `"main": "dist/index.js"` and `"types": "dist/index.d.ts"`

#### For each tsconfig.json:
- Change `"module"` from `"commonjs"` to `"es2022"` (or `"nodenext"`)
- Change `"moduleResolution"` to `"bundler"` (or `"nodenext"`)
- Change `"target"` to `"es2022"`
- Keep `"declaration": true` for .d.ts generation

#### Convert `require()` to `import()`:
All dynamic `require()` calls must become `await import()`:

| File | Current | New |
|------|---------|-----|
| `core/runner/src/tracing/createStore.ts` | `require("./PostgresRunStore")` | `await import("./PostgresRunStore.js")` |
| Same file | `require("./SqliteRunStore")` | `await import("./SqliteRunStore.js")` |
| Same file | `require("node:path")` | Top-level `import path from "node:path"` |
| Same file | `require("node:fs")` | Top-level `import fs from "node:fs"` |
| `core/runner/src/tracing/SqliteRunStore.ts` | `require("better-sqlite3")` | Runtime-detection adapter (see Phase 5) |

**Note**: The `createStore()` function signature may need to become `async` since dynamic `import()` is async unlike `require()`. Alternatively, use top-level await.

---

## Phase 3: Express -> Hono Migration

### Dependencies change in `triggers/http/package.json`:

**Remove:**
```
express, body-parser, cors
@types/express, @types/body-parser, @types/cors
nodemon, ts-node
```

**Add:**
```
hono (^4.9.7+)
@hono/node-server (^1.19.9)
```

### File-by-file migration:

#### 3.1 `triggers/http/src/AppRoutes.ts`
- Replace `import express` with `import { Hono }`
- Replace `express.Router()` with `new Hono()`
- Replace `router.get("/", (_, res) => { res.status(200).send(html) })` with `app.get("/", (c) => c.html(html, 200))`
- Export `Hono` instance instead of `Router`

#### 3.2 `triggers/http/src/runner/Util.ts`
- Remove `import type { Request } from "express"`
- Change `handleDynamicRoute(dynamicRoute: string, req: Request)` signature to `handleDynamicRoute(dynamicRoute: string, requestPath: string, existingParams: Record<string, string>)`
- Make it a pure function that returns params without mutating `req`
- `validateRoute()` needs no changes

#### 3.3 NEW FILE: `triggers/http/src/runner/HonoTraceRouterAdapter.ts`
This adapter bridges the `TraceRouter` interface from `@blok/runner` to Hono. The `core/runner` package MUST NOT be modified.

The adapter:
- Implements the `TraceRouter` interface (`use`, `get`, `post`, `put`, `delete`)
- Creates a Hono sub-app internally
- For each registered route, creates a Hono handler that:
  - Builds a `TraceRequest` from Hono's `c.req` + `c.env.incoming` (raw Node.js request)
  - Builds a `TraceResponse` that writes to `c.env.outgoing` (raw Node.js response)
  - Returns `RESPONSE_ALREADY_SENT` from `@hono/node-server/utils/response`
- SSE streaming works by writing directly to `c.env.outgoing` (same behavior as current Express)
- Exports `createTraceRouterAdapter()` returning `{ traceAdapter, traceApp }`

#### 3.4 `triggers/http/src/runner/HttpTrigger.ts` (THE BIG ONE)

**Imports:**
```typescript
// REMOVE: express, bodyParser, cors, type Express/Request/Response
// ADD:
import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { serve, type HttpBindings } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import { createTraceRouterAdapter } from "./HonoTraceRouterAdapter";
```

**Class properties:**
```typescript
// BEFORE: private app: Express = express();
// AFTER:
type AppBindings = { Bindings: HttpBindings };
private app: Hono<AppBindings> = new Hono<AppBindings>();
// server stays: private server: Server | null = null;
```

**Middleware stack (lines 85-89):**
```typescript
// BEFORE: express.static, bodyParser.*, cors()
// AFTER:
this.app.use("/public/*", serveStatic({ root: "./" }));
this.app.use(bodyLimit({ maxSize: 150 * 1024 * 1024, onError: (c) => c.text("Payload too large", 413) }));
this.app.use(cors());
```
Note: Hono does NOT need body-parser. Body parsing is lazy via `c.req.json()`, `c.req.text()`, `c.req.parseBody()`.

**Health check (lines 91-93):**
```typescript
this.app.all("/health-check", (c) => c.text("Online and ready for action", 200));
```

**Metrics (lines 95-101):**
```typescript
this.app.get("/metrics", (c) => {
    try {
        metricsHandler(c.env.incoming, c.env.outgoing);
        return RESPONSE_ALREADY_SENT;
    } catch (error) {
        return c.text("Error serving metrics", 500);
    }
});
```
The `metricsHandler` from OpenTelemetry Prometheus exporter expects raw Node.js `(IncomingMessage, ServerResponse)` which `c.env.incoming`/`c.env.outgoing` provide via `@hono/node-server`.

**Trace router (lines 107-111):**
```typescript
if (process.env.BLOK_TRACE_ENABLED !== "false") {
    const { traceAdapter, traceApp } = createTraceRouterAdapter();
    registerTraceRoutes(traceAdapter);
    this.app.route("/__blok", traceApp);
}
```

**App routes (line 117):**
```typescript
this.app.route("/", apps); // apps is now a Hono sub-app
```

**Catch-all workflow handler (lines 119-330):**
Key transformations:
- `req.query?.requestId` -> `c.req.query("requestId")`
- `req.params.workflow` -> `c.req.param("workflow")`
- `req.headers["x-blok-execute-node"]` -> `c.req.header("x-blok-execute-node")`
- `req.method` -> `c.req.method`
- `req.body` -> `await c.req.json()` (async, lazy)
- `req.path` -> `c.req.path`
- `ctx.request = req as unknown as RequestContext` -> Build explicit `RequestContext` object:
  ```typescript
  ctx.request = {
      body: c.req.method !== "GET" ? await c.req.json().catch(() => ({})) : {},
      headers: Object.fromEntries([...c.req.raw.headers.entries()]),
      params: handleDynamicRoute(path, c.req.path, c.req.param() as Record<string,string>),
      query: Object.fromEntries(new URL(c.req.url).searchParams.entries()),
      method: c.req.method,
      path: c.req.path,
      url: c.req.url,
  } as RequestContext;
  ```
- `res.setHeader("Content-Type", ...)` -> `c.header("Content-Type", ...)`
- `res.status(200).send(data)` -> `return c.body(data, 200)`
- `res.status(code).json(obj)` -> `return c.json(obj, code)`
- Register as: `this.app.all("/:workflow/*", handler)`, `this.app.all("/:workflow", handler)`, `this.app.all("/", handler)`

**Server lifecycle (lines 332-343):**
```typescript
// BEFORE: this.server = this.app.listen(this.port, callback)
// AFTER:
this.server = serve({ fetch: this.app.fetch, port: Number(this.port) });
this.logger.log(`Server is running at http://localhost:${this.port}`);
if (process.env.BLOK_HMR === "true" || process.env.NODE_ENV === "development") {
    await this.enableHotReload();
}
done(this.endCounter(this.initializer));
```
`serve()` from `@hono/node-server` returns a standard `http.Server`, so `this.server.close()` in `stop()` still works.

**getApp() return type:**
```typescript
// BEFORE: getApp(): Express
// AFTER:  getApp(): Hono<AppBindings>
```

#### 3.5 `triggers/http/src/index.ts`
- Update comment from "Expose the Express app" to "Expose the Hono app"
- Return type of `getHttpApp()` changes automatically since `HttpTrigger.getApp()` now returns Hono

#### 3.6 Scripts in `triggers/http/package.json`:
```json
"dev": "bun --watch run src/index.ts",
"start": "bun run dist/index.js",
"reload": "bun --env-file=.env.local run src/index.ts",
```
Remove `nodemon`, `ts-node` from devDependencies.

#### 3.7 Test files migration:
- `triggers/http/__tests__/unit/AppRoutes.test.ts` - Use Hono's `app.request()` test helper instead of Express mock internals
- `triggers/http/__tests__/unit/Util.test.ts` - Remove Express Request type, pass plain strings to refactored `handleDynamicRoute`
- `triggers/http/__tests__/unit/index.test.ts` - Mock Hono instead of Express
- `triggers/http/__tests__/unit/HttpTrigger.test.ts` - Mock `@hono/node-server`'s `serve()`, test Hono app

---

## Phase 4: CLI Migration (blokctl)

### Files to modify:
- `packages/cli/src/index.ts` - Change shebang from `#!/usr/bin/env node` to `#!/usr/bin/env bun`
- `packages/cli/src/commands/dev/index.ts` - Fix `process.kill(-pid)` blocker, replace `npx nodemon` with `bun --watch`
- `packages/cli/package.json` - Remove nodemon from recommendations

### Fix the `process.kill(-pid)` BLOCKER:

Current code (`dev/index.ts:43-53`):
```typescript
function killAllGroups(signal: NodeJS.Signals) {
    for (const child of runningProcesses) {
        if (child.pid && child.exitCode === null) {
            try {
                process.kill(-child.pid, signal); // BROKEN IN BUN
            } catch {}
        }
    }
}
```

Replace with platform-safe approach:
```typescript
import { spawn as bunSpawn } from "node:child_process";

function killAllGroups(signal: NodeJS.Signals) {
    for (const child of runningProcesses) {
        if (child.pid && child.exitCode === null) {
            try {
                // Bun doesn't support process.kill(-pid), use system kill command
                const sig = signal === "SIGKILL" ? "9" : "15";
                bunSpawn("kill", [`-${sig}`, `--`, `-${child.pid}`], { stdio: "ignore" });
            } catch {
                // Fallback: kill individual process
                try { child.kill(signal); } catch {}
            }
        }
    }
}
```

### Replace nodemon with Bun watch mode (`dev/index.ts:193`):
```typescript
// BEFORE: spawnProcess("npx", ["nodemon@3.1.9"], "NodeJS Runner", currentPath);
// AFTER:  spawnProcess("bun", ["--watch", "run", "src/index.ts"], "Blok Runner", currentPath);
```

---

## Phase 5: SQLite Dual-Runtime Adapter

### Files to modify:
- `core/runner/src/tracing/SqliteRunStore.ts` - Add runtime detection for bun:sqlite vs better-sqlite3

### Strategy:
Create a thin abstraction layer at the top of `SqliteRunStore.ts`:

```typescript
// Detect runtime and load appropriate SQLite driver
function loadSqliteDriver(dbPath: string) {
    if (typeof globalThis !== "undefined" && "Bun" in globalThis) {
        // Use Bun's built-in SQLite
        const { Database } = require("bun:sqlite");
        return new Database(dbPath);
    }
    // Fallback to better-sqlite3 for Node.js
    const mod = "better-sqlite3";
    const Database = require(mod);
    return new Database(dbPath);
}
```

The `bun:sqlite` API is intentionally modeled after `better-sqlite3`, so most operations are identical:
- `.prepare(sql)` -> same
- `.run(...)`, `.get(...)`, `.all(...)` -> same
- `.exec(sql)` -> same
- `.pragma(...)` -> same
- `.transaction(fn)` -> same
- `.close()` -> same

Key differences to handle:
- `import("better-sqlite3").Database` type vs `Database` from `bun:sqlite` - use a shared interface type
- `result.changes` property - verify compatibility
- Prepared statement caching - verify `bun:sqlite` `Statement` has same API

---

## Phase 6: Build System Updates

### tsconfig changes:

#### Root `tsconfig.json`:
```json
{
    "compilerOptions": {
        "target": "es2022",
        "module": "es2022",
        "moduleResolution": "bundler",
        "strict": true,
        "declaration": true,
        "sourceMap": true,
        "esModuleInterop": true
    }
}
```

#### Per-package tsconfig.json files:
- `core/runner/tsconfig.json` - `module: "es2022"`, `moduleResolution: "bundler"`
- `core/shared/tsconfig.json` - same
- `core/workflow-helper/tsconfig.json` - same
- `triggers/http/tsconfig.json` - same
- All other triggers - same

### Build scripts:
Keep `tsc` for declaration file generation (Bun doesn't generate .d.ts files).
Change `npx tsc` to `bun run tsc` for speed.

```json
"build": "rimraf ./dist && bun run tsc",
"build:dev": "bun run tsc --watch"
```

---

## Phase 7: Docker Updates

### `triggers/http/Dockerfile`:
Change production stage from Node.js to Bun:

```dockerfile
# BEFORE: FROM node:23.11.1-slim AS release
# AFTER:
FROM oven/bun:1-slim AS release
WORKDIR /usr/src/app

COPY --from=install /temp/prod/node_modules node_modules
COPY --from=prerelease /usr/src/app/dist dist
COPY --from=prerelease /usr/src/app/package.json .
COPY --from=prerelease /usr/src/app/workflows workflows
COPY --from=prerelease /usr/src/app/public public

# BEFORE: ENTRYPOINT [ "node", "-r", "./dist/runner/metrics/opentelemetry_metrics.js", "dist/index.js" ]
# AFTER:
ENTRYPOINT [ "bun", "--preload", "./dist/runner/metrics/opentelemetry_metrics.js", "run", "dist/index.js" ]
```

### Other Dockerfiles to update:
- `dockerfiles/Dockerfile` - Update runtime stages
- `dockerfiles/Dockerfile.node` - Convert from node to bun runtime
- `dockerfiles/Dockerfile.deploy.http` - Same pattern

---

## Phase 8: Vitest Coverage Update

### Files to modify:
All `vitest.config.ts` files across packages.

### Change:
```typescript
// BEFORE:
coverage: { provider: "v8", ... }

// AFTER:
coverage: { provider: "istanbul", ... }
```

### Package changes:
Replace `@vitest/coverage-v8` with `@vitest/coverage-istanbul` in devDependencies.

---

## Phase 9: Other Trigger Packages

### Triggers that need attention:
- Each trigger's `package.json` needs `"type": "module"` and tsconfig ESM changes
- `triggers/http/package.json` - Full Hono migration (Phase 3)
- `triggers/cron/` - Verify cron scheduler compatibility with Bun
- `triggers/websocket/` - `ws` library works with Bun; optionally migrate to Bun native WebSocket later
- `triggers/grpc/` - Uses Fastify + ConnectRPC; verify `@connectrpc/connect-node` under Bun (MEDIUM risk)
- `triggers/queue/` - kafkajs, amqplib, ioredis all work with Bun
- `triggers/sse/` - Pure HTTP streaming, should work
- `triggers/webhook/` - Uses `crypto` from node:crypto, compatible
- `triggers/worker/` - Background processing, verify BullMQ under Bun
- `triggers/pubsub/` - Cloud SDK usage, should work

### Scripts update for all triggers:
```json
"dev": "bun --watch run src/index.ts",
"start": "bun run dist/index.js"
```
Remove `nodemon`, `ts-node` from all devDependencies.

---

## Phase 10: Cleanup

1. Remove all `nodemon.json` config files
2. Remove `ts-node` from all devDependencies
3. Remove `nodemon` from all devDependencies
4. Delete `pnpm-lock.yaml` and `pnpm-workspace.yaml`
5. Update `engines` field in all package.json from `"node": ">=18"` to include Bun
6. Update `.gitignore` to include `bun.lockb` (binary) and remove `pnpm-lock.yaml`
7. Update `CLAUDE.md` and `AGENTS.md` to reference Bun + Hono instead of Node.js + Express
8. Update `README.md` if it references Node.js/Express/pnpm

---

## Execution Order

The phases MUST be executed in this order due to dependencies:

```
Phase 1: Package Manager (pnpm -> bun)
    |
Phase 2: Module System (CJS -> ESM)
    |
    +---> Phase 3: Express -> Hono (triggers/http)
    |         |
    |         +---> Phase 3.1: AppRoutes.ts
    |         +---> Phase 3.2: Util.ts
    |         +---> Phase 3.3: HonoTraceRouterAdapter.ts (NEW)
    |         +---> Phase 3.4: HttpTrigger.ts
    |         +---> Phase 3.5: index.ts
    |         +---> Phase 3.6: package.json scripts
    |         +---> Phase 3.7: Test files
    |
    +---> Phase 4: CLI (blokctl) - parallel with Phase 3
    |
    +---> Phase 5: SQLite adapter - parallel with Phase 3
    |
Phase 6: Build system (tsconfig updates)
    |
Phase 7: Docker updates
    |
Phase 8: Vitest coverage
    |
Phase 9: Other triggers
    |
Phase 10: Cleanup
```

---

## Verification Plan

### After Phase 1 (Package Manager):
```bash
bun install                        # Should succeed with no errors
bun run build                      # All packages build
bun run test                       # All tests pass
```

### After Phase 2 (ESM):
```bash
bun run build                      # tsc compiles ESM output
bun run test                       # All tests pass with ESM
```

### After Phase 3 (Hono Migration):
```bash
cd triggers/http
bun run build                      # Compiles with Hono types
bun run test                       # All HTTP trigger tests pass
bun run dev                        # Server starts on port 4000

# Manual verification:
curl http://localhost:4000/health-check      # Returns 200 "Online and ready for action"
curl http://localhost:4000/metrics           # Returns Prometheus metrics
curl http://localhost:4000/__blok/health     # Returns trace API health
curl -X POST http://localhost:4000/         # Workflow execution
# Open http://localhost:4000/__blok in browser -> Blok Studio loads
```

### After Phase 4 (CLI):
```bash
bun run build:cli
blokctl dev                        # Dev server starts, runtimes spawn, health checks pass
# Ctrl+C -> All processes killed cleanly (verify process.kill fix)
```

### After Phase 5 (SQLite):
```bash
BLOK_TRACE_STORE=sqlite bun run dev
# Run some workflows, check /__blok/runs shows traces
# Verify .blok/trace.db is created and contains data
```

### After Phase 7 (Docker):
```bash
cd triggers/http
docker build -t blok-http .        # Build succeeds
docker run -p 4000:4000 blok-http  # Container starts, responds to requests
```

### Full integration test:
```bash
bun install && bun run build && bun run test  # Everything passes
blokctl dev                        # Full dev experience works
```

---

## Critical Files Summary

| File | Change Type | Phase |
|------|------------|-------|
| `package.json` (root) | Modify | 1 |
| `pnpm-workspace.yaml` | Delete | 1 |
| All `tsconfig.json` files | Modify | 2, 6 |
| All `package.json` files | Add `"type": "module"` | 2 |
| `core/runner/src/tracing/createStore.ts` | require -> import | 2 |
| `triggers/http/package.json` | Deps swap | 3 |
| `triggers/http/src/AppRoutes.ts` | Rewrite | 3 |
| `triggers/http/src/runner/Util.ts` | Refactor signature | 3 |
| `triggers/http/src/runner/HonoTraceRouterAdapter.ts` | **NEW FILE** | 3 |
| `triggers/http/src/runner/HttpTrigger.ts` | Major rewrite | 3 |
| `triggers/http/src/index.ts` | Minor update | 3 |
| `triggers/http/__tests__/**` | Rewrite mocks | 3 |
| `packages/cli/src/index.ts` | Shebang change | 4 |
| `packages/cli/src/commands/dev/index.ts` | Fix kill + nodemon | 4 |
| `core/runner/src/tracing/SqliteRunStore.ts` | Dual adapter | 5 |
| `triggers/http/Dockerfile` | Bun runtime | 7 |
| All `vitest.config.ts` | v8 -> istanbul | 8 |

---

## Important Architecture Notes

### TraceRouter Interface (MUST NOT MODIFY)
Located in `core/runner/src/tracing/TraceRouter.ts`. Defines minimal Express-compatible interfaces:
- `TraceRequest`: `method`, `params`, `query`, `headers`, `body?`, `on(event, listener)`
- `TraceResponse`: `setHeader()`, `status()`, `json()`, `write()`, `end()`, `sendStatus()`, `flushHeaders()`
- `TraceRouter`: `use()`, `get()`, `post()`, `put()`, `delete()`

The HonoTraceRouterAdapter bridges these interfaces to Hono without touching core/runner.

### BunRuntimeAdapter (ALREADY EXISTS)
Located in `core/runner/src/adapters/BunRuntimeAdapter.ts`. Already detects Bun via `"Bun" in globalThis`. No changes needed.

### OpenTelemetry Metrics Handler
The Prometheus exporter's `getMetricsRequestHandler()` expects raw Node.js `(IncomingMessage, ServerResponse)`. Under Hono + `@hono/node-server`, these are available as `c.env.incoming` and `c.env.outgoing`.

### RequestContext Building
The current code casts `req as unknown as RequestContext`. Under Hono, we must explicitly build the `RequestContext` object from Hono's context methods since there's no Express-compatible `req` object.
