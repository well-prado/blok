# Plan: Add Non-Interactive CLI Flags to All blokctl Commands

## Goal
Make every `blokctl` command fully runnable without interactive prompts by adding CLI flags for every interactive question. This enables AI agents and CI/CD pipelines to invoke any command in a single line.

---

## Design Decisions

- **Global flag**: `--non-interactive` (alias `--ni`) — when set, commands MUST NOT prompt; they fail with a clear error if a required value is missing
- **No separate `--ci` flag** — `--non-interactive` covers all use cases; CI environments can set `BLOK_NON_INTERACTIVE=1` env var as an alternative
- **No `--json` output flag in this plan** — output formatting is a separate concern; this plan focuses purely on eliminating interactive prompts
- **Pattern**: `flagValue ?? (nonInteractive ? throwMissingError(flagName) : await prompt())`
- **Backward compatible** — all new flags are optional; without them, commands behave exactly as today

---

## Shared Infrastructure

### New file: `packages/cli/src/services/non-interactive.ts`

```typescript
// Global non-interactive state
let _nonInteractive = false;

export function isNonInteractive(): boolean {
  return _nonInteractive || process.env.BLOK_NON_INTERACTIVE === "1";
}

export function setNonInteractive(value: boolean): void {
  _nonInteractive = value;
}

/**
 * Resolve a value: use flag if provided, otherwise prompt interactively.
 * In non-interactive mode, throws if no flag value and no default.
 */
export function resolveOrThrow<T>(
  flagName: string,
  flagValue: T | undefined,
  defaultValue?: T,
): T {
  if (flagValue !== undefined) return flagValue;
  if (defaultValue !== undefined) return defaultValue;
  if (isNonInteractive()) {
    throw new Error(
      `Missing required flag --${flagName} (non-interactive mode). ` +
      `Run without --non-interactive to use interactive prompts, or provide --${flagName}.`
    );
  }
  // Caller should fall through to interactive prompt
  return undefined as T;
}

/**
 * Validate that a value is one of the allowed options.
 */
export function validateChoice<T extends string>(
  flagName: string,
  value: T,
  allowed: readonly T[],
): T {
  if (!allowed.includes(value)) {
    throw new Error(
      `Invalid value "${value}" for --${flagName}. Allowed: ${allowed.join(", ")}`
    );
  }
  return value;
}

/**
 * Parse comma-separated string into array.
 */
export function parseCommaSeparated(value: string): string[] {
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}
```

### Modify: `packages/cli/src/index.ts`

Add global `--non-interactive` option to the root Commander program:

```typescript
program
  .option("--non-interactive, --ni", "Disable interactive prompts (fail if required flags are missing)")
  .hook("preAction", (thisCommand) => {
    const opts = thisCommand.opts();
    if (opts.nonInteractive) {
      setNonInteractive(true);
    }
  });
```

---

## Per-Command Changes

### Commands with NO interactive prompts (no changes needed)
These 15 commands already work non-interactively:
- `dev`, `build`, `logout`, `install workflow`, `search docs`, `generate ai-workflow`, `generate ai-trigger`, `generate ai-runtime`, `trace`/`studio`, `graph`, `profile`, `cost`, `monitor`, `config set`, `config list`, `marketplace runtime`

### Commands requiring new flags (12 commands)

---

### 1. `create project` — `packages/cli/src/commands/create/project.ts`

**New flags:**
| Flag | Short | Type | Default | Description |
|------|-------|------|---------|-------------|
| `--trigger` | `-t` | string | `"http"` | Trigger type to install |
| `--runtimes` | `-r` | string | `"node"` | Comma-separated runtime list |
| `--package-manager` | `-m` | string | auto-detect | Package manager: npm, yarn, pnpm, bun |
| `--examples` | | boolean | `false` | Install example workflows and nodes |

**Existing flags kept:** `--name`/`-n`, `--local`/`-l`

**Logic change:**
- Break apart `p.group()` call — resolve each field individually via flag or prompt
- `name`: use `opts.name ?? (nonInteractive ? throw : await p.text(...))`
- `trigger`: use `opts.trigger ?? (nonInteractive ? "http" : await p.select(...))`
- `runtimes`: use `parseCommaSeparated(opts.runtimes) ?? (nonInteractive ? ["node"] : await p.multiselect(...))`
- `packageManager`: use `opts.packageManager ?? (nonInteractive ? detectPM() : await p.select(...))`
- `examples`: use `opts.examples ?? (nonInteractive ? false : await p.select(...))`

**Non-interactive example:**
```bash
blokctl create project --non-interactive -n my-service --trigger http --runtimes node,python3 --package-manager bun --no-examples
```

---

### 2. `create node` — `packages/cli/src/commands/create/node.ts`

**New flags:**
| Flag | Short | Type | Default | Description |
|------|-------|------|---------|-------------|
| `--runtime` | `-r` | string | `"typescript"` | Runtime: typescript, python3, go, java, rust, csharp, php, ruby |
| `--package-manager` | `-m` | string | auto-detect | Package manager |
| `--node-type` | `-t` | string | `"module"` | Node type: module, class |
| `--template` | | string | `"standard"` | Template: standard, ui |

**Existing flags kept:** `--name`/`-n`, `--style`/`-s`

**Logic change:**
- Break apart `p.group()` — resolve name, runtime, packageManager, nodeType, style, template individually
- For TypeScript-only prompts (node-type, style, template): skip if runtime !== "typescript"

**Non-interactive example:**
```bash
blokctl create node --non-interactive -n my-node --runtime typescript --node-type module --style function --template standard
```

---

### 3. `create workflow` — `packages/cli/src/commands/create/workflow.ts`

**No new flags needed** — already has `--name`/`-n` which skips the only prompt.

**Logic change:** Add `isNonInteractive()` check — if non-interactive and no `--name`, throw error instead of prompting.

---

### 4. `deploy` — `packages/cli/src/commands/deploy/index.ts`

**New flags:**
| Flag | Short | Type | Default | Description |
|------|-------|------|---------|-------------|
| `--yes` | `-y` | boolean | `false` | Auto-confirm name mismatch update |

**Existing flags kept:** `--name`/`-n`, `--build`, `--public`, `--directory`/`-d`

**Logic change:**
- The only interactive prompt is `p.confirm()` for name mismatch
- If `--yes` or `--non-interactive`: auto-confirm (update .blok.json name)

---

### 5. `login` — `packages/cli/src/commands/login/index.ts`

**No new flags needed** — already has `--token`/`-t` and `BLOKS_TOKEN` env var.

**Logic change:** Add `isNonInteractive()` check — if non-interactive and no token flag/env, throw error.

---

### 6. `install node` — `packages/cli/src/commands/install/node.ts`

**New flags:**
| Flag | Short | Type | Default | Description |
|------|-------|------|---------|-------------|
| `--package-manager` | `-m` | string | auto-detect | Package manager to use |

**Logic change:** Package manager select prompt skipped when flag provided or non-interactive (auto-detect fallback)

---

### 7. `publish node` — `packages/cli/src/commands/publish/node.ts`

**New flags:**
| Flag | Short | Type | Default | Description |
|------|-------|------|---------|-------------|
| `--node` | `-n` | string | | Node name to publish (skip select prompt) |
| `--runtime` | `-r` | string | `"npm"` | Publishing runtime |
| `--bump` | | string | `"patch"` | Version bump: patch, minor, major |

---

### 8. `publish workflow` — `packages/cli/src/commands/publish/workflow.ts`

**New flags:**
| Flag | Short | Type | Default | Description |
|------|-------|------|---------|-------------|
| `--workflow` | `-w` | string | | Workflow name to publish (skip select prompt) |

---

### 9. `search node` — `packages/cli/src/commands/search/nodes.ts`

**New flags:**
| Flag | Short | Type | Default | Description |
|------|-------|------|---------|-------------|
| `--install` | `-i` | string | | Package name to auto-install |
| `--list` | `-l` | boolean | `false` | List results without install prompt |

---

### 10. `search workflow` — `packages/cli/src/commands/search/workflow.ts`

**New flags:**
| Flag | Short | Type | Default | Description |
|------|-------|------|---------|-------------|
| `--install` | `-i` | string | | Workflow ID to auto-install |
| `--list` | `-l` | boolean | `false` | List results without install prompt |

---

### 11. `generate ai-node` — `packages/cli/src/commands/generate/ai-node.ts`

**New flags:**
| Flag | Short | Type | Default | Description |
|------|-------|------|---------|-------------|
| `--code` | `-c` | string | | Code for --update (skip readline) |
| `--code-file` | | path | | File path for --update code |

---

### 12. `migrate node` — `packages/cli/src/commands/migrate/node.ts`

**New flags:**
| Flag | Short | Type | Default | Description |
|------|-------|------|---------|-------------|
| `--backup` | | boolean | `true` | Create backup (default) |
| `--no-backup` | | boolean | | Skip backup |

---

## Implementation Order

### Phase 1: Infrastructure
1. Create `packages/cli/src/services/non-interactive.ts`
2. Add `--non-interactive` global flag to `packages/cli/src/index.ts`

### Phase 2: Create commands (most complex, highest AI value)
3. Update `create/project.ts` — 5 new flags, break apart `p.group()`
4. Update `create/node.ts` — 4 new flags, break apart `p.group()`
5. Update `create/workflow.ts` — add non-interactive guard

### Phase 3: Deploy, login, publish
6. Update `deploy/index.ts` — 1 new flag (`--yes`)
7. Update `login/index.ts` — add non-interactive guard
8. Update `publish/node.ts` — 3 new flags
9. Update `publish/workflow.ts` — 1 new flag

### Phase 4: Install, search, generate, migrate
10. Update `install/node.ts` — 1 new flag
11. Update `search/nodes.ts` — 2 new flags
12. Update `search/workflow.ts` — 2 new flags
13. Update `generate/ai-node.ts` — 2 new flags
14. Update `migrate/node.ts` — 1 new flag (boolean pair)

### Phase 5: Tests
15. Add tests for `non-interactive.ts` utility
16. Update existing tests for commands that changed signature
17. Add non-interactive-specific tests for `create project` and `create node`

---

## Files Modified (Complete List)

| File | Change | Phase |
|------|--------|-------|
| `packages/cli/src/services/non-interactive.ts` | **NEW** | 1 |
| `packages/cli/src/index.ts` | Add global flag | 1 |
| `packages/cli/src/commands/create/project.ts` | 5 new flags, refactor prompts | 2 |
| `packages/cli/src/commands/create/node.ts` | 4 new flags, refactor prompts | 2 |
| `packages/cli/src/commands/create/workflow.ts` | Non-interactive guard | 2 |
| `packages/cli/src/commands/deploy/index.ts` | 1 new flag | 3 |
| `packages/cli/src/commands/login/index.ts` | Non-interactive guard | 3 |
| `packages/cli/src/commands/publish/node.ts` | 3 new flags | 3 |
| `packages/cli/src/commands/publish/workflow.ts` | 1 new flag | 3 |
| `packages/cli/src/commands/install/node.ts` | 1 new flag | 4 |
| `packages/cli/src/commands/search/nodes.ts` | 2 new flags | 4 |
| `packages/cli/src/commands/search/workflow.ts` | 2 new flags | 4 |
| `packages/cli/src/commands/generate/ai-node.ts` | 2 new flags | 4 |
| `packages/cli/src/commands/migrate/node.ts` | 1 new flag | 4 |
| `packages/cli/tests/` | New and updated tests | 5 |

**Total new flags:** ~25 across 12 commands + 1 global flag
**Total files modified:** 15 (14 existing + 1 new)

---

## Verification

```bash
# After Phase 1:
cd packages/cli && bun run build && blokctl --help

# After Phase 2 (create commands):
blokctl create project --non-interactive -n test-project --trigger http --runtimes node --package-manager bun --no-examples -l .
blokctl create node --non-interactive -n test-node --runtime typescript --node-type module --style function --template standard
blokctl create workflow --non-interactive -n test-workflow
blokctl create project --non-interactive  # Should error: "Missing required flag --name"

# After Phase 3-4 (all commands):
blokctl deploy --non-interactive -n my-service -d . --yes
blokctl login --non-interactive -t $BLOKS_TOKEN
blokctl publish node --non-interactive --node my-node --bump patch
blokctl search node api --non-interactive --list
blokctl migrate node --non-interactive -p ./src/nodes/my-node.ts --no-backup

# After Phase 5:
cd packages/cli && bun run test

# Full integration (AI agent creating a project):
blokctl create project --non-interactive -n ai-project --trigger http --runtimes node,python3 --package-manager bun --no-examples && \
blokctl create node --non-interactive -n hello-world --runtime typescript --node-type module --style function --template standard && \
blokctl create workflow --non-interactive -n hello-api
```
