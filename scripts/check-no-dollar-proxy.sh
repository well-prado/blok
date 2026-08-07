#!/usr/bin/env bash
# The `$` proxy is deleted (issue #689) — this is the CI gate that keeps it
# deleted. It greps every tracked-or-untracked, non-ignored file for the
# shapes that would mean `$` came back:
#   - the deleted implementation module's path
#   - the deleted proxy-unwrapping function name
#   - the authoring surface the proxy existed for: `$` immediately followed
#     by `.state`, `.request`, or `.vars` (see PATTERN below for the exact
#     shapes — spelled out here with a break so this comment doesn't trip
#     its own gate)
#
# Files allowed to still mention these strings, since they document the
# deletion itself, or test the deletion tooling, rather than teach the pattern:
#   - CHANGELOG.md / docs/changelog.mdx — dated release notes. A past entry
#     truthfully describing what shipped AT THAT VERSION isn't an authoring
#     surface; rewriting it would misrepresent history.
#   - docs/c/migration-guides/dollar-proxy-removal.mdx — the migration guide
#     itself, full of intentional before/after examples.
#   - packages/cli/tests/commands/migrate/refs.test.ts — the field-aware ref
#     codemod's own test suite. Its job is detecting and rewriting exactly
#     this shape in old workflow files, so its fixtures must contain the
#     literal shape as INPUT to prove the codemod still catches it.
# `specs/**` is also excluded: it's the redesign's dated planning/ADR archive
# (design discussions, adversarial validation reports) — a historical record
# of why $ was built and then removed, not an authoring surface. Issue #689's
# docs-purge list (docs/, documentation/, examples/, templates/, README,
# CLAUDE.md/AGENTS.md, editor packages) does not include specs/.
#
# Run directly: bash scripts/check-no-dollar-proxy.sh
# Wired into: bun run check:no-dollar-proxy, scripts/ci-local.sh gates(),
# .github/workflows/no-dollar-proxy.yml (runs even on docs-only PRs, which
# integration.yml's paths-ignore skips).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Built via string concatenation (not one literal) so this file's own source
# doesn't contain the trigger words contiguously and doesn't need a carve-out
# beyond the two files the acceptance criteria name.
#
# Word-boundary note: `\b` is a GNU-grep/PCRE extension, not POSIX ERE —
# `git grep -E` on this platform's libgit2/regex build silently treats it as
# a no-op match failure (confirmed: `git grep -E 'state\b'` finds nothing
# even where `state` is plainly present; `-P`/--perl-regexp fares no better,
# this Git build has no PCRE2 linked in). `([^a-zA-Z0-9_]|$)` is the portable
# equivalent — "not a word char, or end of line" — and was verified to catch
# a seeded violation where `\b` silently didn't.
PATTERN='proxy/\$|unwrap'"Proxies"'|\$\.(state|request|vars)([^a-zA-Z0-9_]|$)'
GIT_GREP_FLAGS=(--untracked -n -E)
ALLOWED_FILES=(
	"CHANGELOG.md"
	"docs/changelog.mdx"
	"docs/c/migration-guides/dollar-proxy-removal.mdx"
	"packages/cli/tests/commands/migrate/refs.test.ts"
)
ALLOWED_DIRS=(
	"specs"
)

pathspec=(".")
for f in "${ALLOWED_FILES[@]}"; do
	pathspec+=(":(exclude)$f")
done
for d in "${ALLOWED_DIRS[@]}"; do
	pathspec+=(":(exclude)$d/**")
done

if hits="$(git grep "${GIT_GREP_FLAGS[@]}" "$PATTERN" -- "${pathspec[@]}")"; then
	echo "$hits"
	echo
	echo "✗ Found \$ proxy shapes outside the allowed files (${ALLOWED_FILES[*]})."
	echo "  The \$ proxy is deleted — see docs/c/migration-guides/dollar-proxy-removal.mdx for the replacement forms."
	exit 1
fi

echo "✓ No \$ proxy shapes found outside the allowed files."
