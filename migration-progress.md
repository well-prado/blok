# Migration Progress: Node.js + Express -> Bun + Hono

> **Started:** 2026-01-31
> **Last Updated:** 2026-01-31
> **Overall Status:** Phase 1 in progress

## Legend
- DONE - Completed
- IN PROGRESS - Currently being worked on
- PENDING - Not started yet
- BLOCKED - Waiting on dependencies

---

## Phase 1: Package Manager Migration (pnpm -> bun) - IN PROGRESS

| Step | Status | Details |
|------|--------|---------|
| Add `"workspaces"` to root package.json | DONE | Added: `["core/*", "nodes/**/**", "triggers/*", "templates/**/**", "packages/*", "apps/*"]` |
| Add `"trustedDependencies"` to root package.json | DONE | Added: `["@biomejs/biome", "@bufbuild/buf", "esbuild", "nx", "protobufjs"]` |
| Remove `"packageManager"` field | DONE | Removed `"packageManager": "pnpm@10.14.0"` |
| Remove `"engines.pnpm"` field | DONE | Removed `"engines": { "pnpm": ">=10.2.0" }` |
| Convert scripts from `pnpm --filter` to `bun run --filter` | DONE | All root scripts converted |
| Update `lint-staged` from pnpm to bun | DONE | Changed `"pnpm run test"` to `"bun run test"` |
| Add `pnpm-lock.yaml` to `.gitignore` | DONE | Added under "Lockfiles - bun project" section |
| Fix duplicate workspace name collision | DONE | Changed `templates/node-function/package.json` name from `"node-name"` to `"node-function-name"` |
| Run `bun install` | DONE | 1142 packages installed successfully, `bun.lockb` generated |
| Trust `better-sqlite3` for native compilation | DONE | Ran `bun pm trust better-sqlite3` |
| Delete `pnpm-workspace.yaml` | PENDING | Should be deleted after `bun run build` and `bun run test` pass |
| Verify `bun run build` | PENDING | Must pass before proceeding to Phase 2 |
| Verify `bun run test` | PENDING | Must pass before proceeding to Phase 2 |

### Files Modified in Phase 1:
1. `package.json` (root) - workspaces, trustedDependencies, scripts, removed packageManager/engines
2. `.gitignore` - Added pnpm-lock.yaml
3. `templates/node-function/package.json` - Changed name to fix duplicate

### Issues Encountered:
- **Duplicate workspace name**: Both `templates/node/package.json` and `templates/node-function/package.json` had `"name": "node-name"`. Fixed by renaming the latter to `"node-function-name"`. Safe because CLI scaffolding uses "node-name" as a placeholder that gets replaced with the actual project name.
- **better-sqlite3 blocked**: Bun blocked the native compilation postinstall script. Fixed with `bun pm trust better-sqlite3`.

---

## Phase 2: Module System (CommonJS -> ESM) - PENDING

| Step | Status | Details |
|------|--------|---------|
| Convert `core/shared` | PENDING | Add `"type": "module"`, update tsconfig |
| Convert `core/workflow-helper` | PENDING | Depends on core/shared |
| Convert `core/runner` | PENDING | Depends on shared + helper |
| Convert `nodes/*` | PENDING | Depends on runner + shared |
| Convert `triggers/*` | PENDING | Depends on runner + shared + helper |
| Verify `packages/cli` (already ESM) | PENDING | Just verify it still works |
| Convert `require()` to `import()` in createStore.ts | PENDING | 4 dynamic requires to convert |
| Convert `require()` in SqliteRunStore.ts | PENDING | Will be handled in Phase 5 dual adapter |

---

## Phase 3: Express -> Hono Migration - PENDING

| Step | Status | Details |
|------|--------|---------|
| Install hono + @hono/node-server | PENDING | |
| Remove express, body-parser, cors + @types/* | PENDING | |
| Migrate AppRoutes.ts | PENDING | Router -> Hono |
| Refactor Util.ts | PENDING | Remove Express Request dependency |
| Create HonoTraceRouterAdapter.ts | PENDING | NEW FILE - bridges TraceRouter to Hono |
| Migrate HttpTrigger.ts | PENDING | Major rewrite |
| Update index.ts | PENDING | Minor comment/type update |
| Update package.json scripts | PENDING | Remove nodemon, ts-node |
| Migrate test files | PENDING | 4 test files to update |

---

## Phase 4: CLI Migration (blokctl) - PENDING

| Step | Status | Details |
|------|--------|---------|
| Fix `process.kill(-pid)` blocker | PENDING | Replace with system `kill` command |
| Replace nodemon with `bun --watch` | PENDING | In dev/index.ts:193 |
| Change shebang to `#!/usr/bin/env bun` | PENDING | In packages/cli/src/index.ts |

---

## Phase 5: SQLite Dual-Runtime Adapter - PENDING

| Step | Status | Details |
|------|--------|---------|
| Create `loadSqliteDriver()` function | PENDING | Runtime detection: bun:sqlite vs better-sqlite3 |
| Verify API compatibility | PENDING | .prepare(), .run(), .get(), .all(), .exec(), .pragma(), .transaction(), .close() |
| Test under both runtimes | PENDING | |

---

## Phase 6: Build System Updates - PENDING

| Step | Status | Details |
|------|--------|---------|
| Update root tsconfig.json | PENDING | module: es2022, moduleResolution: bundler |
| Update all package tsconfig.json files | PENDING | Same pattern |
| Convert build scripts to use `bun run tsc` | PENDING | |

---

## Phase 7: Docker Updates - PENDING

| Step | Status | Details |
|------|--------|---------|
| Update triggers/http/Dockerfile | PENDING | Production stage: node -> bun |
| Update dockerfiles/Dockerfile | PENDING | |
| Update dockerfiles/Dockerfile.node | PENDING | |
| Update dockerfiles/Dockerfile.deploy.http | PENDING | |

---

## Phase 8: Vitest Coverage Update - PENDING

| Step | Status | Details |
|------|--------|---------|
| Replace @vitest/coverage-v8 with @vitest/coverage-istanbul | PENDING | |
| Update all vitest.config.ts files | PENDING | provider: "v8" -> "istanbul" |

---

## Phase 9: Other Trigger Packages - PENDING

| Trigger | Status | Risk Level | Notes |
|---------|--------|------------|-------|
| triggers/cron | PENDING | LOW | Verify cron scheduler compatibility |
| triggers/websocket | PENDING | LOW | ws library works with Bun |
| triggers/grpc | PENDING | MEDIUM | Fastify + ConnectRPC - verify under Bun |
| triggers/queue | PENDING | LOW | kafkajs, amqplib, ioredis all work |
| triggers/sse | PENDING | LOW | Pure HTTP streaming |
| triggers/webhook | PENDING | LOW | Uses node:crypto, compatible |
| triggers/worker | PENDING | LOW | Verify BullMQ under Bun |
| triggers/pubsub | PENDING | LOW | Cloud SDK usage |

---

## Phase 10: Cleanup - PENDING

| Step | Status | Details |
|------|--------|---------|
| Remove nodemon.json config files | PENDING | |
| Remove ts-node from devDependencies | PENDING | |
| Remove nodemon from devDependencies | PENDING | |
| Delete pnpm-lock.yaml and pnpm-workspace.yaml | PENDING | |
| Update engines field in package.json files | PENDING | |
| Update .gitignore for bun.lockb | PENDING | |
| Update CLAUDE.md and AGENTS.md | PENDING | Reference Bun + Hono |
| Update README.md | PENDING | |

---

## Known Blockers

| Blocker | Phase | Status | Solution |
|---------|-------|--------|----------|
| `process.kill(-pid)` not supported in Bun | 4 | PENDING | Use system `kill` command via child_process spawn |
| `better-sqlite3` native addon | 5 | PENDING | Dual adapter: bun:sqlite + better-sqlite3 fallback |

## Known Risks

| Risk | Level | Phase | Mitigation |
|------|-------|-------|------------|
| `fs.watch({recursive:true})` Linux edge cases | MEDIUM | - | HMR is dev-only, practical risk is low |
| `crypto.createSign()` case sensitivity | MEDIUM | - | Verify algorithm strings use uppercase |
| MongoDB driver memory leaks under Bun | MEDIUM | - | Monitor in production |
| `@opentelemetry/sdk-trace-web` | LOW | - | Consider sdk-trace-base instead |
| gRPC trigger (`@connectrpc/connect-node`) | MEDIUM | 9 | Needs verification under Bun |
