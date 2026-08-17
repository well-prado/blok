#!/usr/bin/env bash
#
# Scaffold COMBO matrix — create → npm install → npm run build → boot, per
# trigger combination, on plain npm/Node.
#
# The big `run.sh` smoke builds ONE maximal scaffold with `--package-manager
# bun`. That leaves two whole classes of defect invisible, and #741 shipped
# three of them:
#
#   1. npm (unlike bun) REFUSES an `overrides` entry that contradicts a direct
#      dependency — every `http+sse` / `http+websocket` scaffold died with
#      `EOVERRIDE ... @hono/node-server`. Only an npm install catches it.
#   2. Trigger kinds that are never the PRIMARY trigger in the maximal scaffold
#      (cron/mcp/webhook are always preceded by http) never exercise the
#      "base files come from the primary trigger's package dir" path — a
#      cron-only create had crashed on a missing `.env.example` since forever.
#   3. `dist/` still emits on a tsc type error (`noEmitOnError` is off), so a
#      scaffold whose own `npm run build` reports real type errors still boots.
#      Only the build EXIT CODE catches that.
#
# So: one row per combination, and the exit code of each step is the assertion.
#
# Usage:
#   bash tests/e2e/scaffold-smoke/combos.sh
#
# Env:
#   SMOKE_SKIP_BUILD=1   skip the monorepo `bun run build` (assume dist current)
#   SMOKE_COMBOS=a,b     limit to these row names
#   SMOKE_KEEP=1         keep the scaffolded projects for inspection
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
CLI="$ROOT/packages/cli/dist/index.js"
WORKDIR=""

log() { echo "[combos] $*"; }

cleanup() {
  pkill -f "blok-combo-.*/dist/triggers/" 2>/dev/null || true
  [ -n "$WORKDIR" ] && [ -z "${SMOKE_KEEP:-}" ] && rm -rf "$WORKDIR"
}
trap cleanup EXIT

# name | triggers | primary trigger (its dist entry is booted) | boot mode | port | extra create args
#
# boot modes:
#   0  create + build only (nothing standalone to boot)
#   1  boot the compiled entry, require the process to survive
#   2  as 1, plus require the entry to have BOUND the port — `/health-check`
#      must answer. #748: mcp/webhook used to emit a "<kind> trigger not yet
#      implemented" stub standalone, so the project installed, compiled and
#      then exited doing nothing. "Process still alive" would NOT have caught
#      that on its own for a trigger that legitimately binds nothing (cron), so
#      the port-bound kinds assert the listener.
#
# The last row is the maximal scaffold — same trigger set `run.sh` builds, but
# under npm and with the BUILD exit code asserted, which is how the
# `--examples` Nodes.ts extensionless-import type error stayed invisible.
ROWS=(
  "cron|cron|cron|1|4404|"
  "sse|sse|sse|1|4409|"
  "http-sse|http,sse|http|1|4410|"
  "http-pubsub|http,pubsub|http|1|4411|"
  "websocket|websocket|websocket|1|4412|"
  "mcp|mcp|mcp|2|4413|"
  "webhook|webhook|webhook|2|4414|"
  "all-examples|http,sse,websocket,webhook,mcp,worker,cron,grpc,pubsub|http|1|4415|--examples"
  # #864 — pubsub/worker as PRIMARY: the only rows that exercise the
  # `triggers/{pubsub,worker}/template/package.json` base-manifest source
  # (every other row above reads a trigger's OWN package.json). Needed to
  # catch manifest fields that disagree between the two sources (license did).
  # worker: boots clean with zero infra when no --queue-provider is given (the
  # scaffold leaves `this.adapter` unset → resolves to the in-memory adapter).
  "worker|worker|worker|1|4416|"
  # pubsub: the default provider is NATS, which needs a live broker to fully
  # serve — no broker is guaranteed here, so this row only asserts
  # create+build (manifest hygiene + typecheck), not boot.
  "pubsub|pubsub|pubsub|0|4417|"
)

if [ -z "${SMOKE_SKIP_BUILD:-}" ]; then
  log "building the monorepo (SMOKE_SKIP_BUILD=1 to skip)…"
  (cd "$ROOT" && bun run build) >/tmp/blok-combos-build.log 2>&1 || {
    log "build failed — tail of /tmp/blok-combos-build.log:"; tail -60 /tmp/blok-combos-build.log; exit 1;
  }
fi
[ -f "$CLI" ] || { log "blokctl dist not found at $CLI (run a build first)"; exit 1; }

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/blok-combos.XXXXXX")"
FAILED=()
PASSED=()

for row in "${ROWS[@]}"; do
  IFS='|' read -r name triggers primary boot port extra <<<"$row"
  if [ -n "${SMOKE_COMBOS:-}" ] && [[ ",${SMOKE_COMBOS}," != *",${name},"* ]]; then
    log "SKIP $name (not in SMOKE_COMBOS)"; continue
  fi

  proj="blok-combo-$name"
  dir="$WORKDIR/$proj"
  logf="$WORKDIR/$name.log"
  log "── $name ($triggers) ────────────────────────────────"

  # 1. create — runs the package manager's install as its last step, so this
  #    exit code covers both the generator (ENOENT) and npm's resolver
  #    (EOVERRIDE / ERESOLVE).
  if ! (cd "$WORKDIR" && bun "$CLI" create project \
        --name "$proj" --local "$ROOT" --triggers "$triggers" ${extra:+$extra} \
        --package-manager npm --non-interactive </dev/null) >"$logf" 2>&1; then
    log "FAIL $name: create (npm install) — tail:"; tail -20 "$logf"; FAILED+=("$name:create"); continue
  fi

  # 1b. manifest hygiene — the base package.json is copied from the PRIMARY
  #     trigger's published package, so a cron/websocket/mcp primary used to
  #     drag `files`, `publishConfig` and `private: false` into the user's app:
  #     `npm publish` in a scaffold would have gone PUBLIC (#747). Only a real
  #     `create` shows this, and only for the kinds that are ever primary.
  #
  #     #751 — same root cause, harmless-but-wrong leftovers: `main`/`types`
  #     dangled at the trigger PACKAGE's own entry (`dist/index.js`) instead of
  #     the generated project's real entry (`dist/triggers/<kind>/index.js`),
  #     and `description` was still the trigger's own blurb ("Cron/scheduled
  #     trigger for Blok workflows...").
  #
  #     #864 — `license` must NOT leak either: it disagreed depending on which
  #     trigger happened to be primary (Apache-2.0 for most, MIT for the
  #     pubsub/worker `template/package.json`), which is why pubsub/worker are
  #     exercised as PRIMARY below (the "pubsub" and "worker" rows) instead of
  #     only ever appearing as a secondary trigger.
  if ! node -e '
    const pkg = require(process.argv[1] + "/package.json");
    const primary = process.argv[2];
    const proj = process.argv[3];
    const leaked = ["files", "publishConfig", "repository", "homepage", "bugs"].filter((k) => k in pkg);
    if (leaked.length) { console.error("publish-only keys leaked from the trigger package: " + leaked.join(", ")); process.exit(1); }
    if ("license" in pkg) { console.error("license leaked from the trigger package: " + JSON.stringify(pkg.license)); process.exit(1); }
    if (pkg.private !== true) { console.error("generated app is not private: private=" + JSON.stringify(pkg.private)); process.exit(1); }
    const wantMain = "dist/triggers/" + primary + "/index.js";
    if (pkg.main && pkg.main !== wantMain) { console.error("main dangles at the trigger package entry: " + pkg.main + " (want " + wantMain + ")"); process.exit(1); }
    const wantTypes = "dist/triggers/" + primary + "/index.d.ts";
    if (pkg.types && pkg.types !== wantTypes) { console.error("types dangles at the trigger package entry: " + pkg.types + " (want " + wantTypes + ")"); process.exit(1); }
    if (!pkg.description || !pkg.description.startsWith(proj)) { console.error("description still inherited from the trigger package: " + JSON.stringify(pkg.description)); process.exit(1); }
  ' "$dir" "$primary" "$proj" >"$logf.pkg" 2>&1; then
    log "FAIL $name: package.json —"; cat "$logf.pkg"; FAILED+=("$name:manifest"); continue
  fi

  # 2. build — `tsc` exits non-zero on a type error even though it still
  #    emits dist/. A generated project must typecheck with its OWN tsc.
  if ! (cd "$dir" && npm run build) >"$logf.build" 2>&1; then
    log "FAIL $name: npm run build — tail:"; tail -25 "$logf.build"; FAILED+=("$name:build"); continue
  fi

  if [ "$boot" = "0" ]; then
    log "PASS $name (create + build; no standalone entry to boot)"; PASSED+=("$name"); continue
  fi

  # 3. boot the COMPILED entry under plain node and require it to survive.
  entry="$dir/dist/triggers/$primary/index.js"
  if [ ! -f "$entry" ]; then
    log "FAIL $name: no compiled entry at $entry"; FAILED+=("$name:entry"); continue
  fi
  (cd "$dir" && PORT="$port" BLOK_TRACING_DISABLED=1 DISABLE_TRIGGER_RUN=false node "$entry") >"$logf.boot" 2>&1 &
  pid=$!
  sleep 8
  if ! kill -0 "$pid" 2>/dev/null; then
    log "FAIL $name: entry exited during boot — tail:"; tail -25 "$logf.boot"; FAILED+=("$name:boot"); continue
  fi

  # 4. boot=2 — the entry must also be SERVING. A stub entry that logs and
  #    exits fails step 3; a stub that merely idles would not, so assert the
  #    socket. `/health-check` is the one route every port-binding trigger
  #    entry mounts.
  if [ "$boot" = "2" ]; then
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$port/health-check" || true)"
    if [ "$code" != "200" ]; then
      log "FAIL $name: /health-check on port $port returned '$code' (entry never bound) — tail:"
      tail -25 "$logf.boot"; FAILED+=("$name:serve")
      kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
      continue
    fi
  fi

  kill "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null
  log "PASS $name (create + build + boot$([ "$boot" = "2" ] && echo " + serve"))"
  PASSED+=("$name")
done

echo
log "passed: ${PASSED[*]:-(none)}"
if [ ${#FAILED[@]} -gt 0 ]; then
  log "FAILED: ${FAILED[*]}"
  exit 1
fi
log "all combos green"
