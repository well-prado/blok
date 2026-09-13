#!/usr/bin/env bash
#
# Scaffold smoke E2E — the "scaffold → boot → curl" verification, codified.
#
# Creates a REAL Blok project with the local `blokctl` (all triggers + every
# detected runtime + --examples), boots it under `blokctl dev`, then drives
# smoke.ts which curls every trigger + every /runtimes/<lang>/hello and asserts
# real responses. Proves the shipped scaffold has no dead triggers, no dead
# runtimes, and no unresolved helper nodes.
#
# Gated per available toolchain/broker: runs against whatever is installed and
# clearly reports what it SKIPPED and why (no silent truncation). Interpreted
# runtimes are skipped with a reason when their toolchain is missing/too old
# (Ruby < 3.1, no Composer/RoadRunner for PHP, etc. — see issue #644).
#
# Usage:
#   bash tests/e2e/scaffold-smoke/run.sh
#
# Env:
#   SMOKE_RUNTIMES=go,python3   limit to these runtimes (default: all detected;
#                               `none` scaffolds with no language sidecar at all)
#   SMOKE_JS_RUNTIME=bun        JavaScript execution target for the scaffold
#                               (node|bun|deno, default: the CLI's own default).
#                               When it differs from the orchestrator host,
#                               `blokctl dev` must bring up the persistent
#                               @blokjs/runtime-worker — asserted below.
#   SMOKE_TRIGGERS=http,grpc    limit to these triggers (default: all applicable)
#   SMOKE_SKIP_BUILD=1          skip `bun run build` (assume dist is current)
#   SMOKE_KEEP=1                keep the scaffolded project dir for inspection
#   SMOKE_HTTP_PORT=4100        HTTP trigger port (default 4000) — when :4000 is taken locally
#   BLOK_SMOKE_REQUIRE_ALL=1    fail unless every applicable check passes (CI)
#   NATS_SERVERS=host:port      NATS for the pubsub trigger (default localhost:4222)
#   SMOKE_PUBLISHED_VERSION=x.y.z  post-publish mode: scaffold with the PUBLISHED
#                               blokctl@<version> from npm (no --local, no
#                               monorepo build) — the release gate.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
CLI="$ROOT/packages/cli/dist/index.js"
PUBLISHED="${SMOKE_PUBLISHED_VERSION:-}"

# All blokctl invocations route through here so local-dist vs published-npm
# is decided in exactly one place.
run_cli() {
  if [ -n "$PUBLISHED" ]; then bunx --yes "blokctl@$PUBLISHED" "$@"; else bun "$CLI" "$@"; fi
}
# `exec` variant for the dev boot — replaces the subshell so the process-group
# kill in cleanup() reaches the whole trigger/sidecar tree.
exec_dev() {
  if [ -n "$PUBLISHED" ]; then exec bunx --yes "blokctl@$PUBLISHED" dev; else exec bun "$CLI" dev; fi
}
NATS_SERVERS="${NATS_SERVERS:-localhost:4222}"
HTTP_PORT="${SMOKE_HTTP_PORT:-4000}"
STRIPE_WEBHOOK_SECRET="${STRIPE_WEBHOOK_SECRET:-whsec_test}"
WORKDIR=""
DEV_PID=""

# brew-installed toolchains (go/rust/java) aren't always on the default PATH.
[ -x /opt/homebrew/bin/brew ] && eval "$(/opt/homebrew/bin/brew shellenv)" 2>/dev/null || true

# Share one cargo target dir across scaffolds: each scaffold vendors the Rust
# SDK into a fresh dir, so without this every run cold-compiles the whole dep
# tree (~minutes). Also the cache key for CI. Override with CARGO_TARGET_DIR.
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/blok-smoke/cargo-target}"

log() { echo "[smoke] $*"; }

cleanup() {
  if [ -n "$DEV_PID" ]; then
    # kill the whole process group so trigger + runtime sidecars die too
    kill -- "-$DEV_PID" 2>/dev/null || kill "$DEV_PID" 2>/dev/null || true
  fi
  pkill -f "src/triggers/.*/index.ts" 2>/dev/null || true
  pkill -f "cmd/server" 2>/dev/null || true          # go sidecar
  if [ -n "$WORKDIR" ] && [ -z "${SMOKE_KEEP:-}" ]; then rm -rf "$WORKDIR"; fi
}
trap cleanup EXIT

port_open() { nc -z "${1%%:*}" "${1##*:}" 2>/dev/null; }

# Functional java launcher — same candidates as the CLI's detectJava():
# the macOS /usr/bin/java stub fails unless a JDK is linked; brew openjdk is
# keg-only, so probe its keg path too.
have_java() {
  java --version >/dev/null 2>&1 || /opt/homebrew/opt/openjdk/bin/java --version >/dev/null 2>&1
}

have_ruby_31() {
  local c
  for c in ruby /opt/homebrew/opt/ruby/bin/ruby /opt/homebrew/opt/ruby@3.4/bin/ruby /opt/homebrew/opt/ruby@3.3/bin/ruby; do
    command -v "$c" >/dev/null 2>&1 && "$c" -e 'exit(RUBY_VERSION >= "3.1" ? 0 : 1)' 2>/dev/null && return 0
  done
  return 1
}

# ── 1. detect runtimes ────────────────────────────────────────────────────────
detect_runtimes() {
  local rts=()
  command -v go >/dev/null 2>&1 && rts+=(go)
  command -v cargo >/dev/null 2>&1 && rts+=(rust)
  { have_java && command -v mvn >/dev/null 2>&1; } && rts+=(java)
  command -v dotnet >/dev/null 2>&1 && rts+=(csharp)
  { command -v php >/dev/null 2>&1 && command -v composer >/dev/null 2>&1 && command -v rr >/dev/null 2>&1; } && rts+=(php)
  have_ruby_31 && rts+=(ruby)
  command -v python3 >/dev/null 2>&1 && rts+=(python3)
  command -v dart >/dev/null 2>&1 && rts+=(dart)
  command -v mix >/dev/null 2>&1 && rts+=(elixir)
  echo "${rts[*]:-}"
}

RUNTIMES="${SMOKE_RUNTIMES:-$(detect_runtimes)}"
RUNTIMES="${RUNTIMES// /,}"
# An EMPTY SMOKE_RUNTIMES still falls through to detection (bash `:-`), so the
# "scaffold with no sidecars" case needs a word, not an empty string.
[ "$RUNTIMES" = "none" ] && RUNTIMES=""

# ── 2. pick triggers (pubsub needs a broker) ──────────────────────────────────
ALL_TRIGGERS="http,sse,websocket,webhook,mcp,worker,cron,grpc"
if port_open "$NATS_SERVERS"; then
  ALL_TRIGGERS="$ALL_TRIGGERS,pubsub"
  log "NATS reachable at $NATS_SERVERS — including the pubsub trigger"
else
  log "NATS NOT reachable at $NATS_SERVERS — SKIPPING the pubsub trigger"
fi
TRIGGERS="${SMOKE_TRIGGERS:-$ALL_TRIGGERS}"

log "triggers: $TRIGGERS"
log "runtimes: ${RUNTIMES:-(none detected — TypeScript/node only)}"

# ── 3. build (so the --local scaffold links current dist) ─────────────────────
if [ -n "$PUBLISHED" ]; then
  log "post-publish mode: scaffolding with published blokctl@$PUBLISHED (no local build)"
  # The smoke DRIVER (smoke.ts) still runs from the repo and imports
  # @blokjs/trigger-grpc — build just that client dep (its workspace link
  # has no dist on a fresh checkout).
  (cd "$ROOT" && bunx nx run @blokjs/trigger-grpc:build) >/tmp/blok-smoke-grpc-build.log 2>&1 || {
    log "driver dep build failed — tail of /tmp/blok-smoke-grpc-build.log:"; tail -20 /tmp/blok-smoke-grpc-build.log; exit 1;
  }
elif [ -z "${SMOKE_SKIP_BUILD:-}" ]; then
  log "building the monorepo (SMOKE_SKIP_BUILD=1 to skip)…"
  (cd "$ROOT" && bun run build) >/tmp/blok-smoke-build.log 2>&1 || {
    log "build failed — tail of /tmp/blok-smoke-build.log:"; tail -60 /tmp/blok-smoke-build.log; exit 1;
  }
fi
[ -n "$PUBLISHED" ] || [ -f "$CLI" ] || { log "blokctl dist not found at $CLI (run a build first)"; exit 1; }

# ── 4. scaffold (local dist, or published npm in post-publish mode) ───────────
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/blok-smoke.XXXXXX")"
PROJECT="$WORKDIR/smoke"
RUNTIME_ARG=()
[ -n "$RUNTIMES" ] && RUNTIME_ARG=(--runtimes "$RUNTIMES")
JS_RUNTIME="${SMOKE_JS_RUNTIME:-}"
JS_ARG=()
[ -n "$JS_RUNTIME" ] && JS_ARG=(--runtime "$JS_RUNTIME")
LOCAL_ARG=(--local "$ROOT")
[ -n "$PUBLISHED" ] && LOCAL_ARG=()
log "scaffolding at $PROJECT …"
# ${arr[@]+…} — bash-3.2 (macOS) treats an EMPTY array expansion as unbound
# under `set -u`; the + idiom expands to nothing instead of dying.
if ! (cd "$WORKDIR" && run_cli create project \
      --name smoke ${LOCAL_ARG[@]+"${LOCAL_ARG[@]}"} \
      --triggers "$TRIGGERS" ${RUNTIME_ARG[@]+"${RUNTIME_ARG[@]}"} ${JS_ARG[@]+"${JS_ARG[@]}"} \
      --examples --package-manager bun --non-interactive </dev/null) >"$WORKDIR/scaffold.log" 2>&1; then
  log "scaffold failed — tail of scaffold.log:"; tail -20 "$WORKDIR/scaffold.log"; exit 1
fi
# `create` skips a sidecar it cannot set up (toolchain floor, SDK build
# failure) with exit 0. Surface those lines here so a REQUIRE_ALL failure on
# "<kind> sidecar scaffolded" is diagnosable from the CI log alone.
grep -E -A6 'Skipping|Warning: Failed to setup|Required:|Found:|^\s+x ' "$WORKDIR/scaffold.log" | sed 's/^/[smoke][scaffold] /' || true
# Belt for CLIs that swallow scaffold failures with exit 0 (pre-1.3.1 create
# did exactly that): no project dir = failed scaffold, whatever the exit code.
if [ ! -d "$PROJECT" ]; then
  log "scaffold exited 0 but produced no project — tail of scaffold.log:"; tail -20 "$WORKDIR/scaffold.log"; exit 1
fi

# ── 4b. the generated project's own commands, under its selected engine ──────
# ADR 0016 / #942: "each generated project installs, type-checks, builds, tests
# and starts using its selected runtime". Booting it (step 5) covers `start`;
# these are the other three, run exactly as a user would run them. Skipped only
# when the smoke did not select a target at all.
if [ -n "$JS_RUNTIME" ]; then
  for SCRIPT in typecheck build test; do
    log "project: bun run $SCRIPT (runtime=$JS_RUNTIME) …"
    if ! (cd "$PROJECT" && bun run "$SCRIPT") >"$WORKDIR/$SCRIPT.log" 2>&1; then
      log "\`bun run $SCRIPT\` failed in the generated project — tail of $SCRIPT.log:"
      tail -40 "$WORKDIR/$SCRIPT.log"
      exit 1
    fi
  done
  # The `test` script must actually run the SELECTED engine's runner, not
  # whatever happened to be on PATH — a green log from the wrong engine proves
  # nothing about portability.
  case "$JS_RUNTIME" in
    node) EXPECT_RUNNER="node --test tests" ;;
    bun)  EXPECT_RUNNER="bun test" ;;
    deno) EXPECT_RUNNER="deno test" ;;
  esac
  if ! grep -q -- "$EXPECT_RUNNER" "$PROJECT/package.json"; then
    log "generated test script does not use \`$EXPECT_RUNNER\`:"
    grep -n '"test"' "$PROJECT/package.json" || true
    exit 1
  fi
  # Deployment metadata: the worker must be a supervised program pinned to the
  # selected engine (ADR 0016 §3).
  if ! grep -q "program:javascript_worker" "$PROJECT/supervisord.conf"; then
    log "supervisord.conf has no javascript_worker program"; exit 1
  fi
  if ! grep -q "command=.*$JS_RUNTIME" "$PROJECT/supervisord.conf"; then
    log "javascript_worker program does not launch $JS_RUNTIME:"; grep -A4 "program:javascript_worker" "$PROJECT/supervisord.conf"; exit 1
  fi
  log "project commands + deployment metadata OK for $JS_RUNTIME"
fi

# ── 5. boot `blokctl dev` (own process group so cleanup kills the tree) ───────
DEV_LOG="$WORKDIR/dev.log"
if [ "$HTTP_PORT" != "4000" ]; then
  sed -i.bak -E "s/^(PORT|TRIGGER_HTTP_PORT)=4000$/\1=$HTTP_PORT/" "$PROJECT/.env.local" && rm -f "$PROJECT/.env.local.bak"
fi
log "booting blokctl dev …"
( cd "$PROJECT" && \
  BLOK_TRACING_DISABLED=1 \
  NATS_SERVERS="$NATS_SERVERS" BLOK_PUBSUB_ADAPTER=nats \
  BLOK_WORKER_ADAPTER=in-memory \
  STRIPE_WEBHOOK_SECRET="$STRIPE_WEBHOOK_SECRET" LINEAR_WEBHOOK_SECRET="$STRIPE_WEBHOOK_SECRET" \
  exec_dev ) >"$DEV_LOG" 2>&1 &
DEV_PID=$!

# ── 6. wait for the HTTP trigger, then let sidecars warm up ───────────────────
log "waiting for http://localhost:$HTTP_PORT/health-check …"
READY=""
for _ in $(seq 1 120); do
  if curl -fsS "http://localhost:$HTTP_PORT/health-check" >/dev/null 2>&1; then READY=1; break; fi
  # bail early if the dev process died
  kill -0 "$DEV_PID" 2>/dev/null || { log "blokctl dev exited early — tail of dev.log:"; tail -30 "$DEV_LOG"; exit 1; }
  sleep 1
done
[ -n "$READY" ] || { log "HTTP trigger never became ready — tail of dev.log:"; tail -30 "$DEV_LOG"; exit 1; }
log "HTTP trigger up. Giving runtime sidecars a moment to register…"
sleep 3

# ── 6b. the JavaScript execution worker (ADR 0016) ───────────────────────────
# `blokctl dev` hosts the triggers under Bun, so any target other than `bun`
# must have brought up a persistent @blokjs/runtime-worker on its gRPC port.
# A skip here is a real failure: it means runtime.<js> steps would 503.
if [ -n "$JS_RUNTIME" ] && [ "$JS_RUNTIME" != "bun" ]; then
  case "$JS_RUNTIME" in
    node) JS_PORT=10012 ;;
    deno) JS_PORT=10014 ;;
    *)    JS_PORT="" ;;
  esac
  if [ -n "$JS_PORT" ]; then
    JS_READY=""
    for _ in $(seq 1 60); do port_open "localhost:$JS_PORT" && { JS_READY=1; break; }; sleep 1; done
    if [ -n "$JS_READY" ]; then
      log "JavaScript worker ($JS_RUNTIME) listening on gRPC :$JS_PORT"
    else
      log "JavaScript worker ($JS_RUNTIME) never came up on :$JS_PORT — tail of dev.log:"
      grep -iE "worker|javascript" "$DEV_LOG" | tail -20
      exit 1
    fi
  fi
fi

# ── 7. drive the assertions ───────────────────────────────────────────────────
log "running smoke.ts …"
SMOKE_PROJECT_DIR="$PROJECT" SMOKE_DEV_LOG="$DEV_LOG" SMOKE_TRIGGERS="$TRIGGERS" SMOKE_RUNTIMES="$RUNTIMES" STRIPE_WEBHOOK_SECRET="$STRIPE_WEBHOOK_SECRET" \
  SMOKE_BASE_URL="${SMOKE_BASE_URL:-http://localhost:$HTTP_PORT}" \
  bun "$ROOT/tests/e2e/scaffold-smoke/smoke.ts"
CODE=$?

# A failed check without the boot log is undiagnosable in CI — dump it.
if [ "$CODE" -ne 0 ]; then
  log "smoke failed — tail of dev.log:"; tail -n 150 "$DEV_LOG"
fi

[ -n "${SMOKE_KEEP:-}" ] && log "kept scaffold at $PROJECT (dev.log alongside)"
exit $CODE
