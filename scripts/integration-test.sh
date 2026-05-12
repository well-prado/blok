#!/usr/bin/env bash
# Phase 2 — Docker-compose CI orchestration script.
#
# Brings up the test fixtures (Postgres, Redis, Kafka, RabbitMQ, NATS,
# LocalStack, GCP Pub/Sub emulator), waits for healthchecks, sets the
# BLOK_INTEGRATION_* env vars, runs the full workspace test suite (which
# auto-runs integration tests via the per-test env-var guards), then
# tears down.
#
# Usage:
#   bun run test:integration              # full suite
#   bun run test:integration --skip-down  # leave services up after
#   bun run test:integration --no-up      # assume services already up
#
# Local use: docker compose -f infra/testing/docker-compose.yml up -d
# then `BLOK_INTEGRATION_REDIS_URL=redis://localhost:6380 bun run test`
# runs everything.

set -euo pipefail

COMPOSE_FILE="infra/testing/docker-compose.yml"
SKIP_UP=0
SKIP_DOWN=0

for arg in "$@"; do
  case "$arg" in
    --no-up) SKIP_UP=1 ;;
    --skip-down) SKIP_DOWN=1 ;;
    --help|-h)
      cat <<EOF
Usage: $0 [--no-up] [--skip-down]
  --no-up      Skip docker compose up (assume services already running)
  --skip-down  Skip docker compose down (leave services running)
EOF
      exit 0
      ;;
  esac
done

if [ "$SKIP_UP" = "0" ]; then
  echo "==> Starting test fixtures via $COMPOSE_FILE"
  docker compose -f "$COMPOSE_FILE" up -d

  echo "==> Waiting for healthchecks (up to 120s)..."
  deadline=$(( $(date +%s) + 120 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    unhealthy=$(docker compose -f "$COMPOSE_FILE" ps --format json 2>/dev/null | \
      grep -E '"Health":\s*"(starting|unhealthy)"' | wc -l | tr -d ' ' || echo "0")
    if [ "$unhealthy" = "0" ]; then
      echo "==> All services healthy."
      break
    fi
    sleep 2
  done
  if [ "$unhealthy" != "0" ]; then
    echo "==> Healthcheck timeout — some services not healthy. Continuing anyway." >&2
    docker compose -f "$COMPOSE_FILE" ps
  fi
fi

# Export integration env vars so per-test `describeIf(env, ...)` guards
# activate. Each var maps to a service in the compose file (using the
# host-mapped test ports — 5433, 6380, etc.).
export BLOK_INTEGRATION_POSTGRES_URL="${BLOK_INTEGRATION_POSTGRES_URL:-postgres://blok:blok_test@localhost:5433/blok_test}"
export BLOK_INTEGRATION_REDIS_URL="${BLOK_INTEGRATION_REDIS_URL:-redis://localhost:6380}"
export BLOK_INTEGRATION_NATS_SERVERS="${BLOK_INTEGRATION_NATS_SERVERS:-nats://localhost:4223}"
export BLOK_INTEGRATION_KAFKA_BROKERS="${BLOK_INTEGRATION_KAFKA_BROKERS:-localhost:9094}"
export BLOK_INTEGRATION_RABBITMQ_URL="${BLOK_INTEGRATION_RABBITMQ_URL:-amqp://blok:blok_test@localhost:5673}"
export BLOK_INTEGRATION_SQS_ENDPOINT="${BLOK_INTEGRATION_SQS_ENDPOINT:-http://localhost:4567}"
export BLOK_INTEGRATION_GCP_PUBSUB_ENDPOINT="${BLOK_INTEGRATION_GCP_PUBSUB_ENDPOINT:-localhost:8086}"

# Trap teardown so failed tests still tear services down.
cleanup() {
  status=$?
  if [ "$SKIP_DOWN" = "0" ] && [ "$SKIP_UP" = "0" ]; then
    echo "==> Tearing down test fixtures"
    docker compose -f "$COMPOSE_FILE" down -v >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap cleanup EXIT

echo "==> Running tests with BLOK_INTEGRATION_* env vars set"
bun run test
