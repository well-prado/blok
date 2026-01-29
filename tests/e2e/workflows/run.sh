#!/usr/bin/env bash
#
# Workflow E2E Test Runner
#
# Starts infrastructure (PostgreSQL), builds the project, launches the Blok
# server, runs the E2E workflow tests, then cleans up.
#
# Usage:
#   ./run.sh              # Full run: infra + server + tests + cleanup
#   ./run.sh --test-only  # Tests only (server must already be running)
#   ./run.sh --no-cleanup # Keep infrastructure running after tests
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
TRIGGER_DIR="$ROOT_DIR/triggers/http"
BLOK_URL="${BLOK_URL:-http://localhost:4000}"
SERVER_PID=""
TEST_ONLY=false
NO_CLEANUP=false

# Parse arguments
for arg in "$@"; do
  case $arg in
    --test-only)  TEST_ONLY=true ;;
    --no-cleanup) NO_CLEANUP=true ;;
  esac
done

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${CYAN}[e2e]${NC} $1"; }
ok()   { echo -e "${GREEN}[e2e]${NC} $1"; }
warn() { echo -e "${YELLOW}[e2e]${NC} $1"; }
err()  { echo -e "${RED}[e2e]${NC} $1"; }

# ---------------------------------------------------------------------------
# Cleanup handler
# ---------------------------------------------------------------------------

cleanup() {
  if [ "$NO_CLEANUP" = true ]; then
    warn "Skipping cleanup (--no-cleanup)"
    return
  fi

  log "Cleaning up..."

  # Stop the Blok server if we started it
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    log "Stopping Blok server (PID $SERVER_PID)..."
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi

  # Stop PostgreSQL
  if [ "$TEST_ONLY" = false ]; then
    log "Stopping PostgreSQL..."
    docker compose -f "$SCRIPT_DIR/docker-compose.yml" down -v 2>/dev/null || true
  fi

  ok "Cleanup complete."
}

trap cleanup EXIT

# ---------------------------------------------------------------------------
# Wait for a service to become healthy
# ---------------------------------------------------------------------------

wait_for_service() {
  local name="$1"
  local url="$2"
  local max_attempts="${3:-30}"
  local attempt=0

  log "Waiting for $name at $url..."
  while [ $attempt -lt $max_attempts ]; do
    if curl -sf "$url" > /dev/null 2>&1; then
      ok "$name is ready."
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 1
  done

  err "$name did not become ready after ${max_attempts}s"
  return 1
}

# ---------------------------------------------------------------------------
# Main flow
# ---------------------------------------------------------------------------

echo ""
echo "=========================================================="
echo "   Blok Workflow E2E Test Runner"
echo "=========================================================="
echo ""

if [ "$TEST_ONLY" = true ]; then
  log "Running in --test-only mode (expecting server at $BLOK_URL)"
else
  # Step 1: Start PostgreSQL
  log "Starting PostgreSQL (dvdrental)..."

  # Check if port 5432 is already in use
  if lsof -i :5432 -sTCP:LISTEN > /dev/null 2>&1; then
    warn "Port 5432 is already in use. Assuming PostgreSQL is running."
  else
    docker compose -f "$SCRIPT_DIR/docker-compose.yml" up -d --wait 2>&1 | while read -r line; do echo "  $line"; done
    ok "PostgreSQL container started."
  fi

  # Step 2: Build the project
  log "Building the project..."
  cd "$ROOT_DIR"
  pnpm build 2>&1 | tail -5
  ok "Build complete."

  # Step 3: Start the Blok server
  log "Starting Blok server..."

  # Check if server is already running
  if curl -sf "$BLOK_URL/health-check" > /dev/null 2>&1; then
    warn "Blok server already running at $BLOK_URL. Using existing server."
  else
    cd "$TRIGGER_DIR"

    # Create a .env for the test if it doesn't exist
    export PROJECT_NAME=trigger-http-server
    export PROJECT_VERSION=0.0.1
    export PORT=4000
    export WORKFLOWS_PATH="$TRIGGER_DIR/workflows"
    export NODES_PATH="$TRIGGER_DIR/src"
    export CONSOLE_LOG_ACTIVE=false
    export APP_NAME=nanoservice-http
    export DISABLE_TRIGGER_RUN=false

    node dist/index.js > /tmp/blok-e2e-server.log 2>&1 &
    SERVER_PID=$!
    log "Server starting (PID $SERVER_PID)..."

    # Wait for it
    if ! wait_for_service "Blok server" "$BLOK_URL/health-check" 20; then
      err "Server failed to start. Last 20 lines of log:"
      tail -20 /tmp/blok-e2e-server.log || true
      exit 1
    fi
  fi
fi

# Step 4: Run the tests
log "Running E2E workflow tests..."
echo ""

cd "$SCRIPT_DIR"
TEST_EXIT_CODE=0
npx tsx workflow-e2e.test.ts || TEST_EXIT_CODE=$?

exit $TEST_EXIT_CODE
