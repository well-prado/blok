# SPEC — `blokctl runtime add` / `remove` / `list`

> **Status:** Proposal — awaiting your review and approval. No code written yet.
> **Goal:** Let people add or remove language runtimes to an **existing** Blok project (one scaffolded with only a couple) from the CLI, instead of hand-editing `.blok/config.json` + `.env.local` + `supervisord.conf` and copying SDK directories by hand.
> **Grounded in:** a full source trace of how `blokctl create project --runtimes …` wires runtimes today (file:line references throughout).

---

## TL;DR

Add three commands:

```bash
blokctl runtime add <lang>        # e.g. blokctl runtime add python3
blokctl runtime remove <lang>     # e.g. blokctl runtime remove go
blokctl runtime list              # show installed runtimes + what's available to add
```

`<lang>` ∈ `go · rust · java · csharp · php · ruby · python3` (the seven gRPC sidecar SDKs). `node`/`nodejs` is rejected — it's in-process and always present.

**The de-risking insight:** adding or removing a runtime is **purely config/env/SDK-dir work — zero `@blokjs/runner` code changes.** The runner already registers gRPC adapters + `runtime.<lang>` resolvers for all seven languages *unconditionally* at boot; unused ones just sit idle until a step dispatches to them. Every piece of the scaffold's per-runtime setup already exists as an exported function in `packages/cli/src/services/runtime-setup.ts`. What's missing is (a) the command wrapper and (b) **merge-not-rewrite** variants of three generators that today only emit whole files.

---

## Why now — the gap

Runtimes can only be chosen at creation: `blokctl create project --runtimes go,rust` (or the interactive multiselect). There is **no** command to add or remove one later — `grep` for `runtime add` / `addRuntime` / `removeRuntime` finds nothing. A user who scaffolds `--runtimes node` and later wants Python or Go must manually edit `.blok/config.json`, append `.env.local` vars, copy an SDK dir, and splice `supervisord.conf` — easy to get wrong. (Confirmed in the CLI audit; the `--runtimes` handling lives at `packages/cli/src/commands/create/project.ts:68,928-954`.)

---

## How a runtime works today (the 4 surfaces an add/remove must touch)

A "runtime" = one non-Node language SDK process (a gRPC sidecar) that the TS runner dispatches `runtime.<lang>` steps to. Canonical definitions: `packages/cli/src/services/runtime-detector.ts:74-183` (`RUNTIME_DEFINITIONS`).

| kind | gRPC port | sdkDir | install | start |
|---|---|---|---|---|
| `go` | 10001 | `sdks/go` | `go mod download` | `go run ./cmd/server` |
| `rust` | 10002 | `sdks/rust` | `cargo build --release` | `cargo run` |
| `java` | 10003 | `sdks/java` | `mvn package -q -DskipTests` | `java -jar target/blok-java-1.0.0.jar` |
| `csharp` | 10004 | `sdks/csharp` | `dotnet restore` | `dotnet run --project src/Blok.Core` |
| `php` | 10005 | `sdks/php` | `composer install` | `rr serve …` (gRPC) |
| `ruby` | 10006 | `sdks/ruby` | `bundle install` | `bundle exec rackup …` |
| `python3` | 10007 | `sdks/python3` | `pip3 install -r requirements.txt` | `python3 bin/serve.py` |

Convention: `grpcPort = legacyHttpPort + 1000`. The legacy HTTP `port` is dead (gRPC is the sole transport since v0.5) but still written for back-compat.

The four surfaces `create project` writes per runtime — and exactly what add must create / remove must undo:

1. **`.blok/config.json` → `runtimes[<kind>]`** — the full `RuntimeConfig` (`{port, grpcPort, startCmd, grpcStartCmd?, cwd, kind, label, version, requiredVersion, transport:"grpc"}`). Written by `writeProjectConfig` (`runtime-setup.ts:289-313`). Read at dev time by `readProjectConfig` (`dev/index.ts:69`).
2. **Two directories:**
   - `.blok/runtimes/<kind>/` — the SDK server source, copied wholesale from `sdks/<sdkDir>/` (`runtime-setup.ts:104-106`), plus in-place build artifacts (venv / `target/` / `vendor/` / `*.jar`). This is the sidecar's `cwd`.
   - `runtimes/<kind>/nodes/` — **project-level dir for the user's own runtime nodes** (must never be auto-deleted on remove).
3. **`.env.local`** — `RUNTIME_<K>_HOST`, `RUNTIME_<K>_PORT`, `RUNTIME_<K>_GRPC_PORT`, and a once-only `BLOK_TRANSPORT=grpc` (`generateRuntimeEnvVars`, `runtime-setup.ts:335-356`). The runner reads `RUNTIME_<K>_GRPC_PORT`/`_HOST` (`Configuration.ts:84-103`) — Bun auto-loads `.env.local`.
4. **`supervisord.conf`** — one `[program:<kind>_runtime]` block (`generateSupervisordConfig`, `runtime-setup.ts:363-382`). (Runtimes use supervisord, **not** docker-compose; compose is only for brokers.)

**No runner code registration exists or is needed:** `Configuration.nodeTypes()` hard-codes all seven `runtime.<lang>` resolvers (`Configuration.ts:432-490`), and `initializeRuntimeRegistry()` registers a `GrpcRuntimeAdapter` per language unconditionally at boot (`Configuration.ts:71-99`). So a runtime that isn't installed simply idles (health probe fails, circuit opens) — confirming add/remove is config-only.

---

## `blokctl runtime add <lang>` — behavior

**Preflight / validation**
1. Reject `node`/`nodejs` (in-process, always present) and `bun`/`docker`/`wasm` (no scaffold path). Reject unknown kinds.
2. Idempotency: if `config.runtimes[<lang>]` **and** `.blok/runtimes/<lang>/` already exist → no-op with a message, unless `--force` (reinstall).
3. `detectRuntimes()` toolchain check (incl. the secondary tool for java/php/ruby). Abort with a clear message if the toolchain is missing (or `--skip-toolchain-check` to scaffold anyway).
4. **Port-collision check (NEW — the scaffold never does this):** ensure the canonical `grpcPort` isn't already claimed by another `config.runtimes` entry or a live listener. Offer `--grpc-port <n>` to override; the override must thread consistently into **both** the config and `.env.local`.

**Source + build** (reuse the existing `setupRuntime` machinery)
5. Resolve a repo source for `sdks/<sdkDir>/` — at the **project's pinned `@blokjs/runner` version** (proto compatibility), via the cached `~/.blok/blok` clone, a fresh clone at that tag, or `--local <path>`.
6. Copy `sdks/<sdkDir>/` → `.blok/runtimes/<lang>/`; `ensureDir runtimes/<lang>/nodes/`.
7. Run the language install/build (`setupPython3/Go/Rust/Java/CSharp/Php/Ruby`, `runtime-setup.ts:159-284`) — capturing the java/ruby `startCmd` overrides and php `grpcStartCmd`, and (python3) the venv + `nodes`/`core` symlinks.

**Config / env mutation (idempotent merges, NOT full rewrites)**
8. Read-merge-write `config.runtimes[<lang>] = newRuntimeConfig`, preserving `triggers` and existing runtimes.
9. Upsert `RUNTIME_<K>_*` into `.env.local` (dedup-safe; ensure a single `BLOK_TRANSPORT=grpc`).
10. Splice one `[program:<lang>_runtime]` block into `supervisord.conf` (skip if already present).
11. Ensure the `.blok/runtimes/**/{bin,obj,__pycache__,target}` artifact ignores exist in `.gitignore`.

**Explicit no-ops** (call out in `--help`/docs): no `@blokjs/runner` change, no `package.json` change, no docker-compose change.

**Failure handling:** on a build failure mid-add, leave the project in a clean state — do **not** write a config entry pointing at an unbuilt dir (or mark it clearly incomplete so `blokctl dev`'s cwd/version check warns predictably).

---

## `blokctl runtime remove <lang>` — behavior

**Undo set**
1. Delete `config.runtimes[<lang>]`. If it was the **last** runtime, drop the `runtimes` key entirely (so `blokctl dev` takes its no-runtimes path cleanly).
2. Remove the `RUNTIME_<K>_*` lines from `.env.local`. Only remove `BLOK_TRANSPORT=grpc` + the `# Runtimes` header if **no** runtimes remain (it's process-global, not per-runtime).
3. Delete `.blok/runtimes/<lang>/` (incl. build output). For python3, also remove the `runtimes/<lang>/{nodes,core}` junction symlinks (they'd dangle).
4. **Never auto-delete `runtimes/<lang>/nodes/`** (the user's own node source). Warn that it remains; offer `--purge-nodes` for an explicit opt-in.
5. Remove the `[program:<lang>_runtime]` block from `supervisord.conf`.
6. **Warn if workflows still reference the runtime:** grep the project for `runtime.<lang>` step `use:`/`type:` and list them — those steps will fail at run time once the sidecar is gone.

---

## `blokctl runtime list` — behavior

Read `config.runtimes` + `detectRuntimes()` and print a table: **installed** runtimes (kind, version, gRPC port, toolchain-available?) and **available to add** (the supported kinds not yet installed, with toolchain availability). Pure read; no mutation. (Nice-to-have but cheap, and it makes add/remove discoverable.)

---

## Required refactors (the "merge, don't rewrite" gap)

The scaffold's generators assume a one-shot full write. Add/remove need incremental variants — small, well-scoped additions to `services/runtime-setup.ts`:

| Today (full rewrite) | Add for incremental ops |
|---|---|
| `writeProjectConfig(dir, configs[], triggers)` | `addRuntimeToConfig(dir, runtimeConfig)` / `removeRuntimeFromConfig(dir, kind)` — read-merge-write, preserve everything else |
| `generateRuntimeEnvVars(configs[])` (re-emits header + `BLOK_TRANSPORT` every call → naive append corrupts) | `upsertRuntimeEnvVars(dir, runtimeConfig)` / `removeRuntimeEnvVars(dir, kind)` — idempotent line-level edits |
| `generateSupervisordConfig(configs[])` (whole file) | `spliceSupervisordProgram(dir, runtimeConfig)` / `removeSupervisordProgram(dir, kind)` |
| per-runtime loop inlined in `project.ts:928-951` | extract `addRuntime(kind, projectDir, source, opts)` and have **both** `create project` (loop) and the new command call it (DRY) |
| repo-source resolution inlined in `create project` | extract `resolveRepoSource(projectDir, {local})` resolving at the project's pinned framework version |

This refactor also de-duplicates `create project` (its loop becomes `addRuntime` called N times), so it's a net simplification, not just new surface.

---

## Edge cases (the part worth your scrutiny)

- **`node`/`nodejs`/`bun`/`docker`/`wasm`** — rejected for both add and remove.
- **Runtime not present / partial state** — config entry without a dir (or vice-versa, from a manual edit): repair/clean both sides; don't assume symmetry. "Not installed" → exit 0 with a clear message.
- **Last runtime removed** — drop the `runtimes` key; `dev` takes the no-runtimes path.
- **Port collision (add)** — canonical ports are fixed per kind, so this only happens with a manual re-point or a co-located second project; `--grpc-port` escape hatch must thread into config **and** `.env.local`.
- **Manual edits** — match on `kind`, not exact generated text; tolerate missing blocks; don't duplicate a hand-added entry. **`.env.local` dedup is the sharpest footgun.**
- **`.gitignore` asymmetry** — HTTP-primary scaffolds get artifact-only ignores (SDK source tracked); non-HTTP-primary scaffolds get a wholesale `.blok/` ignore (SDK source untracked). Add/remove should normalize so build artifacts are ignored consistently.
- **SDK-version skew** — the copied SDK must match the project's `@blokjs/runner` proto version; resolve the source at the pinned version, not blindly the latest cached clone.
- **java/ruby `startCmd` overrides + php `grpcStartCmd`** — persist exactly as `setupRuntime` returns them, or `blokctl dev` boot fails.
- **Workflows referencing `runtime.<lang>` after remove** — warn (see remove §6).

---

## Tests

- **Unit (`packages/cli/tests/services/`):** `addRuntimeToConfig`/`removeRuntimeFromConfig` (preserve triggers + sibling runtimes; last-runtime drops the key); `upsert/removeRuntimeEnvVars` (no duplicate header/`BLOK_TRANSPORT`; idempotent); `splice/removeSupervisordProgram`.
- **Command (`packages/cli/tests/commands/runtime/`):** against a temp HTTP-only fixture project, `runtime add python3` (mock the heavy build) → assert all four surfaces correct; `runtime remove python3` → all undone, `runtimes/python3/nodes/` preserved; idempotent add (+`--force`); remove-absent; last-runtime; `--grpc-port` override threads to config + env; `runtime list` output.

---

## Open questions / decisions for you

1. **Command shape:** `blokctl runtime add/remove/list` (subcommand group — recommended, mirrors `migrate`/`publish`/`search`) vs flat `blokctl add-runtime`?
2. **Source resolution for add:** clone at the project's pinned version / reuse `~/.blok/blok` / require `--local`? (Proto compatibility makes "at pinned version" the safe default — but it implies a network clone unless cached.)
3. **The dead `marketplace runtime` command** (`commands/marketplace/runtime.ts`, ~520 lines, never wired into the CLI) manages a *remote Docker-image catalog* — unrelated to local SDK sidecars, but it owns the word "runtime." Wire it up, **rename** it (e.g. `marketplace images`) to avoid confusion with the new `runtime` group, or delete it?
4. **Per-runtime Dockerfiles on add:** the scaffold doesn't copy per-runtime Dockerfiles today (only the primary trigger's). Out of scope for v1, or include?
5. **`--purge-nodes` on remove:** confirm the default is to *keep* `runtimes/<lang>/nodes/` and only delete it on explicit opt-in.

---

## Effort estimate

**~2–3 days.** The building blocks (`setupRuntime`, the per-language installers, `detectRuntimes`, the health probe, the config/env/supervisord generators) all exist; the work is the merge/splice/dedup refactors (½ day), the `runtime add/remove/list` command + CLI registration (½ day), the edge-case handling (½–1 day), and tests (½–1 day). Zero framework/runner changes. Blast radius is confined to `packages/cli`.
