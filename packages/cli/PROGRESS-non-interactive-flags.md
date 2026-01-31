# Progress: Non-Interactive CLI Flags

## Status: COMPLETE

### Bug Fix: `workspace:*` resolution in scaffolded projects
- [x] Identified root cause: trigger `package.json` files contain `workspace:*` refs that aren't properly converted
- [x] Fix `workspace:*` -> `file:` path resolution in `create/project.ts` — added `overrides` section to scaffolded `package.json` for transitive workspace dep resolution
- [x] Rebuild CLI — build passes, all 516 tests pass

---

## Phase 1: Infrastructure
- [x] Create `packages/cli/src/services/non-interactive.ts`
- [x] Add `--non-interactive` global flag to `packages/cli/src/index.ts`
- [x] Build and verify `blokctl --help` shows flag

## Phase 2: Create Commands
- [x] `create/project.ts` — 5 new flags (`--trigger`, `--runtimes`, `--package-manager`, `--examples`, `--no-examples`), break apart `p.group()`
- [x] `create/node.ts` — 4 new flags (`--runtime`, `--package-manager`, `--node-type`, `--template`), break apart `p.group()`
- [x] `create/workflow.ts` — add non-interactive guard

## Phase 3: Deploy, Login, Publish
- [x] `deploy/index.ts` — add `--yes`/`-y` flag
- [x] `login/index.ts` — add non-interactive guard
- [x] `publish/node.ts` — add `--runtime`, `--bump` flags
- [x] `publish/workflow.ts` — add non-interactive guards for workflow selection

## Phase 4: Install, Search, Generate, Migrate
- [x] `install/node.ts` — add `--package-manager` flag
- [x] `search/nodes.ts` — add `--install`, `--list` flags
- [x] `search/workflow.ts` — add `--install`, `--list` flags
- [x] `generate/index.ts` (ai-node) — add `--code`, `--code-file` flags
- [x] `migrate/node.ts` — add `--backup`/`--no-backup` flags

## Phase 5: Tests
- [x] Tests for `non-interactive.ts` utility (17 tests)
- [x] Existing command tests still pass (all 543 tests pass)
- [x] Non-interactive-specific tests for `create project` and `create node` (10 tests)

---

## Notes
- All new flags are backward compatible (optional)
- `BLOK_NON_INTERACTIVE=1` env var as alternative to `--non-interactive` flag
- Total: ~25 new flags across 12 commands + 1 global flag
- Build passes, all 543 tests pass (up from 516)
