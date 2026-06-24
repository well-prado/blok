#!/usr/bin/env bash
#
# SPEC-B cross-runtime E2E — build + boot the SDK gRPC servers, drive them
# through the runner's GrpcRuntimeAdapter (spec-b-typed-e2e.ts), tear down.
#
# Proves, over REAL gRPC, for every booted runtime:
#   - ListNodes returns the `typed-greet` node WITH a real JSON Schema
#   - Execute validates the typed input (valid → typed output; invalid →
#     structured NODE_INPUT_VALIDATION error)
#   - a cross-runtime chain threads ctx data through every runtime in order
#
# Boots whatever toolchains are present — all 7 polyglot runtimes:
# Go, Rust, C#, Java, PHP (via RoadRunner `rr`), Ruby (>= 3.1), Python3.
# The harness probes reachability and runs against whatever subset is up.
#
# Usage:  bash tests/e2e/cross-runtime/run-spec-b-e2e.sh
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PIDS=()
cleanup() {
  echo "--- tearing down servers ---"
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
  pkill -f blok-spec-b-go 2>/dev/null || true
  pkill -f "rr serve" 2>/dev/null || true
  pkill -f "bin/serve.php" 2>/dev/null || true
}
trap cleanup EXIT

wait_port() { # host-less localhost port poll, ~20s
  for _ in $(seq 1 40); do nc -z localhost "$1" 2>/dev/null && return 0; sleep 0.5; done
  return 1
}

# --- Go (gRPC 20001) ---
if command -v go >/dev/null; then
  echo "--- building + booting Go ---"
  (cd "$ROOT/sdks/go" && go build -o /tmp/blok-spec-b-go ./cmd/server)
  (cd "$ROOT/sdks/go" && BLOK_TRANSPORT=both GRPC_PORT=20001 PORT=19001 /tmp/blok-spec-b-go) >/tmp/blok-go.log 2>&1 &
  PIDS+=($!); wait_port 20001 && echo "Go gRPC up :20001"
fi

# --- Rust (gRPC 20002) ---
if command -v cargo >/dev/null; then
  echo "--- building + booting Rust ---"
  (cd "$ROOT/sdks/rust" && cargo build --features grpc --bin blok -q)
  (cd "$ROOT/sdks/rust" && ENABLE_GRPC=true GRPC_PORT=20002 PORT=19002 ./target/debug/blok) >/tmp/blok-rust.log 2>&1 &
  PIDS+=($!); wait_port 20002 && echo "Rust gRPC up :20002"
fi

# --- C# (gRPC 20004) ---
if command -v dotnet >/dev/null; then
  echo "--- building + booting C# ---"
  (cd "$ROOT/sdks/csharp" && dotnet build src/Blok.Core/Blok.Core.csproj -v q >/dev/null)
  (cd "$ROOT/sdks/csharp/src/Blok.Core" && BLOK_TRANSPORT=both GRPC_PORT=20004 PORT=19004 ASPNETCORE_URLS=http://localhost:19004 dotnet run --no-build) >/tmp/blok-csharp.log 2>&1 &
  PIDS+=($!); wait_port 20004 && echo "C# gRPC up :20004"
fi

# --- Java (gRPC 20003) ---
JH="$(/usr/libexec/java_home 2>/dev/null || echo "${JAVA_HOME:-}")"
if [ -n "$JH" ] && command -v mvn >/dev/null; then
  echo "--- building + booting Java ---"
  (cd "$ROOT/sdks/java" && JAVA_HOME="$JH" BLOK_TRANSPORT=both GRPC_PORT=20003 PORT=19003 mvn -q compile exec:java -Dexec.mainClass=com.blok.blok.Main) >/tmp/blok-java.log 2>&1 &
  PIDS+=($!); wait_port 20003 && echo "Java gRPC up :20003"
fi

# --- PHP (gRPC 20005, via RoadRunner — no PHP grpc extension needed) ---
if command -v rr >/dev/null && command -v php >/dev/null && [ -f "$ROOT/sdks/php/.rr.yaml" ]; then
  echo "--- booting PHP (RoadRunner) ---"
  (cd "$ROOT/sdks/php" && composer dump-autoload -q 2>/dev/null || true)
  (cd "$ROOT/sdks/php" && GRPC_PORT=20005 rr serve -c .rr.yaml) >/tmp/blok-php.log 2>&1 &
  PIDS+=($!); wait_port 20005 && echo "PHP gRPC up :20005"
fi

# --- Ruby (gRPC 20006) — needs Ruby >= 3.1 + bundled grpc gem ---
RUBY_BIN="$(command -v ruby || true)"
for cand in /opt/homebrew/opt/ruby/bin/ruby /opt/homebrew/opt/ruby@3.4/bin/ruby /opt/homebrew/opt/ruby@3.3/bin/ruby; do
  [ -x "$cand" ] && RUBY_BIN="$cand" && break
done
if [ -n "$RUBY_BIN" ] && "$RUBY_BIN" -e 'exit(RUBY_VERSION >= "3.1" ? 0 : 1)' 2>/dev/null; then
  echo "--- building + booting Ruby ---"
  RB_DIR="$(dirname "$RUBY_BIN")"
  (cd "$ROOT/sdks/ruby" && PATH="$RB_DIR:$PATH" bundle install --quiet 2>/dev/null || true)
  (cd "$ROOT/sdks/ruby" && PATH="$RB_DIR:$PATH" BLOK_TRANSPORT=both GRPC_PORT=20006 PORT=19006 bundle exec ruby bin/serve.rb) >/tmp/blok-ruby.log 2>&1 &
  PIDS+=($!); wait_port 20006 && echo "Ruby gRPC up :20006"
fi

# --- Python3 (gRPC 20007) ---
if command -v python3 >/dev/null && python3 -c "import grpc, pydantic" 2>/dev/null; then
  echo "--- booting Python3 ---"
  (cd "$ROOT/sdks/python3" && BLOK_TRANSPORT=both GRPC_PORT=20007 PORT=19007 PYTHONPATH=. python3 bin/serve.py) >/tmp/blok-python.log 2>&1 &
  PIDS+=($!); wait_port 20007 && echo "Python3 gRPC up :20007"
fi

echo "--- running harness ---"
# This script boots on 2000x (offset from a local dev stack's 1000x); the
# harness defaults to the 1000x convention, so pass the boot ports explicitly.
cd "$ROOT" && GO_GRPC_PORT=20001 RUST_GRPC_PORT=20002 JAVA_GRPC_PORT=20003 \
	CS_GRPC_PORT=20004 PHP_GRPC_PORT=20005 RUBY_GRPC_PORT=20006 PY_GRPC_PORT=20007 \
	bun tests/e2e/cross-runtime/spec-b-typed-e2e.ts
