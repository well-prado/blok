#!/usr/bin/env bash
# Build every SDK artifact `bun run dev` needs.
#
# Skips toolchains that aren't installed locally (Java, .NET, Ruby, PHP
# are common omissions on a fresh machine). Doesn't build Python or
# Ruby — they run from source against the system interpreter.
#
# Usage:
#   bun run sdks:build       # build everything available
#   bash scripts/sdks-build.sh

set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)

# ANSI colors for the section headers; muted so logs stay readable
# when piped to a file.
HDR='\033[97m'
OK='\033[32m'
SKIP='\033[33m'
ERR='\033[31m'
DIM='\033[2m'
RESET='\033[0m'

build_step() {
	local label="$1"
	shift
	echo -e "${HDR}━━━ ${label} ━━━${RESET}"
	if "$@"; then
		echo -e "${OK}✓ ${label} built${RESET}\n"
	else
		echo -e "${ERR}✗ ${label} build failed${RESET}\n"
		return 1
	fi
}

skip() {
	echo -e "${SKIP}⊘ $1 — skipped: $2${RESET}\n"
}

# -----------------------------------------------------------------------------
# Go: cd sdks/go && go build -o bin/blok ./cmd/server
# -----------------------------------------------------------------------------
if command -v go >/dev/null 2>&1; then
	build_step "Go SDK" bash -c "cd '$ROOT/sdks/go' && go build -o bin/blok ./cmd/server" || true
else
	skip "Go SDK" "go not in PATH (https://go.dev/dl/)"
fi

# -----------------------------------------------------------------------------
# Rust: cd sdks/rust && cargo build --features grpc
# -----------------------------------------------------------------------------
if command -v cargo >/dev/null 2>&1; then
	build_step "Rust SDK" bash -c "cd '$ROOT/sdks/rust' && cargo build --features grpc" || true
else
	skip "Rust SDK" "cargo not in PATH (https://rustup.rs)"
fi

# -----------------------------------------------------------------------------
# Java: produces sdks/java/target/blok-java-1.0.0.jar
# -----------------------------------------------------------------------------
JAVA_BIN=""
for cand in /opt/homebrew/opt/openjdk@21/bin/java /usr/lib/jvm/openjdk-21/bin/java java; do
	if "$cand" -version >/dev/null 2>&1; then
		JAVA_BIN="$cand"
		break
	fi
done
if [ -n "$JAVA_BIN" ] && command -v mvn >/dev/null 2>&1; then
	JAVA_HOME_DIR="$(dirname "$(dirname "$JAVA_BIN")")"
	build_step "Java SDK" bash -c "cd '$ROOT/sdks/java' && JAVA_HOME='$JAVA_HOME_DIR' PATH='$JAVA_HOME_DIR/bin:\$PATH' mvn package -DskipTests -q" || true
else
	skip "Java SDK" "java/mvn not found (brew install openjdk@21 maven)"
fi

# -----------------------------------------------------------------------------
# C#: produces sdks/csharp/bin/release/Blok.Core.dll
# -----------------------------------------------------------------------------
if command -v dotnet >/dev/null 2>&1; then
	build_step "C# SDK" bash -c "cd '$ROOT/sdks/csharp' && dotnet publish src/Blok.Core/Blok.Core.csproj -c Release -o bin/release --self-contained false -v quiet" || true
else
	skip "C# SDK" "dotnet not in PATH (https://dot.net)"
fi

# -----------------------------------------------------------------------------
# PHP: composer install for the RoadRunner-backed gRPC service
# -----------------------------------------------------------------------------
if command -v composer >/dev/null 2>&1; then
	build_step "PHP SDK (composer install)" bash -c "cd '$ROOT/sdks/php' && composer install --no-progress --quiet" || true
	# Sanity-check rr is available; the runtime needs it.
	if command -v rr >/dev/null 2>&1 || [ -x /opt/homebrew/bin/rr ]; then
		echo -e "${DIM}  RoadRunner detected — PHP gRPC will run via rr.${RESET}\n"
	else
		echo -e "${SKIP}  RoadRunner (rr) not installed — pass --no-php to dev or 'brew install roadrunner'.${RESET}\n"
	fi
else
	skip "PHP SDK" "composer not in PATH (brew install composer)"
fi

# -----------------------------------------------------------------------------
# Python: nothing to compile — just print install hint if grpcio is missing.
# -----------------------------------------------------------------------------
if command -v python3 >/dev/null 2>&1; then
	if (cd "$ROOT/sdks/python3" && python3 -c "import grpc; from blok.runtime.v1 import runtime_pb2" 2>/dev/null); then
		echo -e "${OK}✓ Python SDK ready (grpcio importable)${RESET}\n"
	else
		echo -e "${SKIP}⊘ Python SDK — grpcio not installed.${RESET}"
		echo -e "${DIM}  cd sdks/python3 && pip install -e '.[grpc]'${RESET}\n"
	fi
else
	skip "Python SDK" "python3 not in PATH"
fi

# -----------------------------------------------------------------------------
# Ruby: nothing to compile — just sanity-check grpc gem.
# -----------------------------------------------------------------------------
RUBY_BIN=""
for cand in /opt/homebrew/opt/ruby@3.3/bin/ruby /opt/homebrew/opt/ruby/bin/ruby ruby; do
	if "$cand" -e "exit 1 unless RUBY_VERSION.split('.').first.to_i >= 3" >/dev/null 2>&1; then
		RUBY_BIN="$cand"
		break
	fi
done
if [ -n "$RUBY_BIN" ]; then
	if "$RUBY_BIN" -e "require 'grpc'" >/dev/null 2>&1; then
		echo -e "${OK}✓ Ruby SDK ready (grpc gem importable via $RUBY_BIN)${RESET}\n"
	else
		echo -e "${SKIP}⊘ Ruby SDK — grpc gem not installed.${RESET}"
		echo -e "${DIM}  $RUBY_BIN -S gem install grpc grpc-tools sinatra puma rackup --user-install${RESET}\n"
	fi
else
	skip "Ruby SDK" "ruby 3.x not found (brew install ruby@3.3)"
fi

echo -e "${HDR}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${HDR}Done. Run ${OK}bun run dev${HDR} to start the stack.${RESET}"
echo -e "${HDR}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
