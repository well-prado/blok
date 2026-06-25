#!/usr/bin/env bash
# Local mirror of the GitHub Actions CI lanes, so a change can be validated
# fully on your machine instead of burning Actions minutes on every push.
# Each lane runs the SAME commands as the matching .github/workflows/ job, in
# the same order, with the same env — so a green run here means a green run there.
#
# Lanes:
#   integration    → .github/workflows/integration.yml
#                    lint:check → proto:check → nx build → real-broker test suite
#                    (Docker: brings up postgres/redis/nats/kafka/rabbitmq/
#                     localstack/gcp-pubsub via infra/testing/docker-compose.yml)
#   cross-runtime  → .github/workflows/cross-runtime.yml
#                    builds + drives the 7 SDK gRPC runtimes end-to-end
#                    (HEAVY: builds 7 Docker images — Go/Rust/Java/C#/PHP/Ruby/Python3)
#   fast           → no Docker: lint:check → proto:check → nx build → `bun run test`
#                    (integration suites self-skip with no BLOK_INTEGRATION_* env)
#   all            → integration + cross-runtime
#
# Usage:
#   bun run ci                 # integration lane (default)
#   bun run ci:fast            # quick, no Docker
#   bun run ci:cross-runtime   # polyglot gRPC lane
#   bun run ci:all             # everything
set -euo pipefail

LANE="${1:-integration}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }

gates() {
  step "Lint (Biome)"; bun run lint:check
  step "Proto drift check"; bun run proto:check
  step "Build all workspace packages (nx, cached)"; bunx nx run-many -t build
}

run_fast() {
  gates
  step "Unit/test suite (integration suites self-skip without BLOK_INTEGRATION_* env)"
  bun run test
}

run_integration() {
  gates
  step "Integration tests — Docker fixtures up, real-broker suites, teardown"
  # integration-test.sh brings up infra/testing/docker-compose.yml, waits for
  # healthchecks, exports BLOK_INTEGRATION_* (the same vars integration.yml sets),
  # runs `bun run test`, and tears the fixtures down on exit.
  bash scripts/integration-test.sh
}

run_cross_runtime() {
  local CR="tests/e2e/cross-runtime"
  step "Build @blokjs/runner (the harness imports GrpcRuntimeAdapter)"; bunx nx build @blokjs/runner
  step "Prepare user-node build contexts"; bun "$CR/prepare-usernodes.ts"
  step "Build + start the 7 SDK gRPC runtimes (docker compose --build)"
  docker compose -f "$CR/docker-compose.yml" up -d --build
  # Always tear the runtimes down, even if the harness fails.
  trap 'docker compose -f "'"$CR"'/docker-compose.yml" down -v >/dev/null 2>&1 || true' EXIT
  step "Cross-runtime gRPC harness (all 7 required, user nodes asserted)"
  BLOK_E2E_REQUIRE_ALL=1 BLOK_E2E_USERNODES=1 bun "$CR/spec-b-typed-e2e.ts"
}

case "$LANE" in
  fast)                 run_fast ;;
  integration)          run_integration ;;
  cross-runtime|cross)  run_cross_runtime ;;
  all)                  run_integration; run_cross_runtime ;;
  *) echo "unknown lane: '$LANE' (use: fast | integration | cross-runtime | all)" >&2; exit 2 ;;
esac

printf '\n\033[1;32m✅ CI lane '"'"'%s'"'"' passed locally.\033[0m\n' "$LANE"
