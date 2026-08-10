#!/usr/bin/env bash
# `gofmt` gate for sdks/go (issue #749). Nothing in CI ran gofmt before this,
# so formatting drift accumulated silently on main (a stray blank line in
# grpc_server.go, struct-literal misalignment in grpc_server_test.go and
# worker.go). `gofmt -l` lists files whose formatting differs from canonical
# — it never rewrites in check mode, so this is read-only.
#
# Run directly: bash scripts/check-go-fmt.sh
# Wired into: bun run check:go-fmt, .github/workflows/integration.yml (Go SDK
# format check step, after "Set up Go" — mirrors how the proto breaking-change
# check adds its own toolchain via bufbuild/buf-setup-action).
#
# Tolerant of a missing local Go toolchain (like scripts/sdks-build.sh):
# this is a real gate in CI, where actions/setup-go guarantees gofmt is
# present, but a contributor without Go installed shouldn't be blocked from
# running the other local checks.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v gofmt >/dev/null 2>&1; then
	echo "⊘ gofmt not found — skipping (install Go: https://go.dev/dl/)."
	exit 0
fi

drifted="$(gofmt -l sdks/go)"

if [ -n "$drifted" ]; then
	echo "$drifted"
	echo
	echo "✗ The above sdks/go file(s) are not gofmt-formatted."
	echo "  Run: gofmt -w sdks/go"
	exit 1
fi

echo "✓ sdks/go is gofmt-clean."
