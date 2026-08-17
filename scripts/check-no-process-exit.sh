#!/usr/bin/env bash
# The CLI has ONE async error boundary — `withErrorBoundary` in
# packages/cli/src/services/commander.js, wrapped around every commander
# `.action()` (issue #899). This is the CI gate that keeps it the only place
# that decides the process's exit status.
#
# WHY IT EXISTS
#
# #888, #890 and #891 were three faces of the same structural gap: with no
# shared boundary, every command grew its own exit strategy — `process.exit(1)`
# inside an exported function, swallow-and-return-0, or an unhandled rejection.
# `process.exit()` in particular tears the process down immediately: it kills
# any host that imported the function (tests, programmatic callers, Studio
# embedding) and drops pending work, most visibly the PostHog `process.on
# ("exit")` flush in services/posthog.ts.
#
# THE RULE
#
#   An exported command function THROWS (or returns a typed failure).
#   Only the boundary sets the exit status, and it sets `process.exitCode`.
#
# THE TWO ALLOWED EXCEPTIONS, both of which must be visible AT THE CALL SITE:
#
#   1. A clack cancel path — `process.exit(0)` inside an `onCancel` handler or
#      after `p.isCancel(...)`. The user asked to abort; there is no error to
#      report and nothing for a boundary to do (#891 called this out as fine).
#      Recognised by `onCancel` / `isCancel` in the preceding lines.
#
#   2. A genuinely-final exit in a LONG-RUNNING command (`dev`, `watch`,
#      `monitor`, Studio): the terminal step of a signal handler or of an
#      interactive TUI's quit key, where the process owns the terminal and has
#      no caller left to return to. Recognised by the literal marker
#      `#899 allow-list` in a comment above the call, which forces whoever adds
#      one to write down why.
#
# `packages/cli/src/index.ts` is excluded outright: it is the entrypoint that
# owns the process, so a final exit there is by definition not a command
# escaping its boundary.
#
# Sibling of scripts/check-no-dollar-proxy.sh and scripts/check-no-legacy-expr.sh
# — same shape (bash + git grep, allow-list, non-zero on hit).
#
# Run directly: bash scripts/check-no-process-exit.sh
# Wired into: bun run check:no-process-exit, scripts/ci-local.sh gates().
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SCOPE="packages/cli/src"
EXCLUDED_FILE="packages/cli/src/index.ts"
# How many lines above the call may carry the justification.
CONTEXT=8

# `-n` for file:line, so each hit can be re-read with its context below.
# Comment lines are dropped: this gate's own prose, and the explanatory comments
# in commander.ts / login/index.ts, legitimately spell the call out.
hits="$(git grep --untracked -n -E 'process\.exit\(' -- "$SCOPE" ":(exclude)$EXCLUDED_FILE" |
	grep -vE '^[^:]+:[0-9]+:[[:space:]]*(//|\*|/\*)' || true)"

violations=""
while IFS= read -r hit; do
	[ -n "$hit" ] || continue
	file="${hit%%:*}"
	rest="${hit#*:}"
	line="${rest%%:*}"
	start=$((line - CONTEXT))
	[ "$start" -lt 1 ] && start=1
	context="$(sed -n "${start},${line}p" "$file")"
	if printf '%s' "$context" | grep -qE 'onCancel|isCancel|#899 allow-list'; then
		continue
	fi
	violations+="$hit"$'\n'
done <<<"$hits"

if [ -n "$violations" ]; then
	printf '%s' "$violations"
	echo
	echo "✗ Found process.exit() in $SCOPE outside the allowed sites."
	echo "  Command functions must THROW — withErrorBoundary (packages/cli/src/services/commander.ts)"
	echo "  prints the message once and sets process.exitCode, which lets the telemetry flush run."
	echo "  If this really is a clack cancel path or a long-running command's final exit,"
	echo "  put the reason in a comment above it containing: #899 allow-list"
	exit 1
fi

echo "✓ No unguarded process.exit() calls in $SCOPE."
