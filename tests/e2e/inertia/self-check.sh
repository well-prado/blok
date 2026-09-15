#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
E2E_PROXY_SELF_TEST=1 bun "$ROOT/tests/e2e/inertia/break-proxy.ts"

run_case() {
	local flag="$1" grep="$2"
	local output
	output="$(mktemp)"
	if env "$flag=1" "$ROOT/tests/e2e/inertia/run.sh" --framework react --mode in-project --host node --grep "$grep" >"$output" 2>&1; then
		cat "$output"
		rm -f "$output"
		echo "self-check failed: $flag did not fail $grep" >&2
		return 1
	fi
	# A setup/build error is not breaker evidence. Playwright must have selected
	# this numbered test and reported a failed assertion.
	if ! grep -Fq "$grep" "$output" || ! grep -Eq '[1-9][0-9]* failed' "$output"; then
		cat "$output"
		rm -f "$output"
		echo "self-check failed: $flag stopped before $grep failed in Playwright" >&2
		return 1
	fi
	rm -f "$output"
	echo "self-check passed: $flag fails $grep"
}

run_case E2E_BREAK_VARY "01 —"
run_case E2E_BREAK_303 "07 —"
run_case E2E_BREAK_ESCAPE "20 —"
