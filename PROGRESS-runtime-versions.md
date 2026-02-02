# Blok Runtime Version Management — Progress

> Tracks implementation progress for the runtime version management feature.
> See `ROADMAP-runtime-versions.md` for the full feature specification.

---

## Phase Overview

| Phase | Name | Status | Description |
|-------|------|--------|-------------|
| 0 | Documentation | Done | Roadmap and progress tracking files |
| 1 | Semver Foundation | Done | Shared semver utility module + tests |
| 2 | Config Schema Extension | Done | `version` + `requiredVersion` in `.blok/config.json` |
| 3 | CLI Version Enforcement | Done | `blokctl dev` validation + `blokctl check` command |
| 4 | Node-Level Requirements | Done | `runtimeRequirements` in `defineNode()` |
| 5 | Health Version Reporting | Done | Runtime version from SDK `/health` endpoint |
| 6 | Marketplace Integration | Done | `>=` operator + manifest `runtimeVersions` |

---

## Detailed Checklist

### Phase 0: Documentation
- [x] Create `ROADMAP-runtime-versions.md`
- [x] Create `PROGRESS-runtime-versions.md`

### Phase 1: Semver Foundation
- [x] Create `packages/cli/src/services/semver-utils.ts`
  - [x] `parseSemver(version)` — parse "1.22.5" into `{ major, minor, patch }`
  - [x] `compareSemver(a, b)` — return -1, 0, or 1
  - [x] `satisfiesConstraint(version, constraint)` — supports `>=`, `^`, `~`, exact
  - [x] `parseConstraint(constraint)` — parse ">=3.10.0" into `{ operator, version }`
  - [x] `computeDefaultConstraint(version)` — "3.12.0" → ">=3.12.0"
  - [x] `formatVersionMismatch(runtime, found, required, source)` — structured error message
  - [x] `formatVersionSuccess(runtime, found, required)` — success message
- [x] Create `packages/cli/src/services/semver-utils.test.ts`
  - [x] Tests for `>=` operator (8 tests)
  - [x] Tests for `^` (caret) operator (7 tests)
  - [x] Tests for `~` (tilde) operator (5 tests)
  - [x] Tests for exact version matching (4 tests)
  - [x] Edge cases: 0.x versions, missing patch, whitespace
  - [x] `parseSemver` tests (6 tests)
  - [x] `compareSemver` tests (6 tests)
  - [x] `semverGte` tests (5 tests)
  - [x] `parseConstraint` tests (6 tests)
  - [x] `computeDefaultConstraint` tests (5 tests)
  - [x] `formatVersionMismatch` tests (3 tests)
  - [x] `formatVersionSuccess` tests (1 test)
  - [x] **All 59 tests passing**

### Phase 2: Config Schema Extension
- [x] Extend `RuntimeConfig` interface with `version?: string` and `requiredVersion?: string`
- [x] Update `setupRuntime()` to pass version through and compute `requiredVersion`
- [x] `writeProjectConfig()` already persists all RuntimeConfig fields (no change needed)
- [x] Add `RuntimeValidationResult` type
- [x] Add `validateProjectRuntimes(projectDir)` function
- [x] Add `detectRuntimeVersion(kind)` to `runtime-detector.ts`
- [x] Backward compatible — old configs without version fields skip validation

### Phase 3: CLI Version Enforcement
- [x] Add `--skip-version-check` option to `blokctl dev` command
- [x] Add version validation gate in `devProject()` function
- [x] Green checkmarks output on success
- [x] Structured error output on failure (expected/found/fix)
- [x] Warning output with `--skip-version-check`
- [x] Update project creation hints to show version pins
- [x] Create `packages/cli/src/commands/check/index.ts`
- [x] Register `blokctl check` in CLI command structure
- [x] CI-friendly exit codes (0 pass / 1 fail)

### Phase 4: Node-Level Runtime Requirements
- [x] Add `runtimeRequirements?` to `FnNodeDefinition` interface
- [x] Store `runtimeRequirements` on `FunctionNode` class
- [x] Create `core/runner/src/version/RuntimeVersionValidator.ts`
- [x] Create `core/runner/src/version/__tests__/RuntimeVersionValidator.test.ts`
  - [x] **All 13 tests passing**
- [x] Add `versions` map to `RuntimeRegistry`
- [x] Add `setVersion()`, `getVersion()`, `getVersions()` to `RuntimeRegistry`
- [x] Add `validateNodeRuntimeRequirements()` in `Configuration.ts`
- [x] Wire validation into `moduleResolver()`

### Phase 5: Runtime Health Version Reporting
- [x] Enhance `HttpRuntimeAdapter.checkHealth()` to parse `version` from response
- [x] Store version in `RuntimeRegistry.setVersion()`
- [ ] Verify Python SDK health endpoint returns version (requires running SDK)
- [ ] Verify Go SDK health endpoint returns version (requires running SDK)

### Phase 6: Marketplace Integration
- [x] Add `>=` operator support to `RuntimeDiscovery.resolveVersion()`
- [x] Add `runtimeVersions?: Partial<Record<string, string>>` to `RuntimePackageManifest`

---

## Verification Results

- **Build:** All packages compile successfully (`bun run build` — 0 errors)
- **Tests:** 1505 passing, 13 skipped, 40 failed (pre-existing `better-sqlite3` native module mismatch)
  - Semver utils: 59/59 passing
  - RuntimeVersionValidator: 13/13 passing
  - All new code fully tested

---

## Files Modified/Created

### Created
| File | Phase | Purpose |
|------|-------|---------|
| `ROADMAP-runtime-versions.md` | 0 | Feature roadmap |
| `PROGRESS-runtime-versions.md` | 0 | Progress tracker |
| `packages/cli/src/services/semver-utils.ts` | 1 | Semver utilities |
| `packages/cli/src/services/semver-utils.test.ts` | 1 | Semver tests (59 tests) |
| `core/runner/src/version/RuntimeVersionValidator.ts` | 4 | Version validator |
| `core/runner/src/version/__tests__/RuntimeVersionValidator.test.ts` | 4 | Validator tests (13 tests) |
| `packages/cli/src/commands/check/index.ts` | 3 | `blokctl check` command |

### Modified
| File | Phase | Changes |
|------|-------|---------|
| `packages/cli/src/services/runtime-setup.ts` | 2 | `version` + `requiredVersion` on RuntimeConfig, `validateProjectRuntimes()` |
| `packages/cli/src/services/runtime-detector.ts` | 2 | `detectRuntimeVersion(kind)` |
| `packages/cli/src/commands/create/project.ts` | 3 | Version pin hints |
| `packages/cli/src/commands/dev/index.ts` | 3 | Version validation gate + `--skip-version-check` |
| `packages/cli/src/index.ts` | 3 | Register `check` command + `--skip-version-check` option |
| `core/runner/src/defineNode.ts` | 4 | `runtimeRequirements` on `FnNodeDefinition` + `FunctionNode` |
| `core/runner/src/Configuration.ts` | 4 | `validateNodeRuntimeRequirements()` in `moduleResolver()` |
| `core/runner/src/RuntimeRegistry.ts` | 4 | Version tracking (`setVersion`, `getVersion`, `getVersions`) |
| `core/runner/src/adapters/HttpRuntimeAdapter.ts` | 5 | Health version extraction + `RuntimeRegistry.setVersion()` |
| `core/runner/src/marketplace/RuntimeDiscovery.ts` | 6 | `>=` operator in `resolveVersion()` |
| `core/runner/src/marketplace/RuntimeCatalog.ts` | 6 | `runtimeVersions` on `RuntimePackageManifest` |
