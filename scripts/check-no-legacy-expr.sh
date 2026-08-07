#!/usr/bin/env bash
# `js/ctx....` strings and `${ctx....}` interpolation are the runtime WIRE
# FORMAT — what the load-boundary lowering pass (`lowerRefs`) emits, not an
# authoring API (issue #690, ADR 0001). This is the CI gate that keeps them off
# the public authoring surface: docs, templates, examples, editor tooling, and
# the agent-facing repo guides.
#
# Sibling of scripts/check-no-dollar-proxy.sh — same structure, same portable
# word-boundary trick, different pattern and allow-list. They stay separate
# because their allow-lists have nothing in common.
#
# WHAT IS A VIOLATION
#
#   1. `${ctx....}` / `${vars....}` interpolation. There is no position where
#      this is the right authoring form — `tpl` (TS) / `{"$tpl": [...]}` (JSON)
#      replaces it everywhere. Lines that are themselves a `js/` template
#      literal are skipped: a backtick template legitimately contains `${ctx...}`
#      AFTER lowering, and inside a js`...` escape hatch.
#
#   2. A `js/ctx....` string that is a PURE PATH — root plus only `.ident`,
#      `[0]` and `['quoted']` accessors. That is exactly the set with an exact
#      structural equivalent (`{"$ref": {"step", "path"}}` / a typed handle),
#      i.e. exactly what `blokctl migrate refs` can rewrite and what the
#      runtime deprecation warning nags about
#      (`PURE_PATH_EXPR` in core/runner/src/workflow/WorkflowNormalizer.ts).
#      Keeping the gate and the runtime warning on the same definition is what
#      makes "run the codemod" honest advice.
#
# WHAT IS NOT A VIOLATION
#
#   - Non-structural expressions: fallbacks (`|| 'x'`), optional chaining,
#     `.map`/`.reduce`, calls, `process.env`, computed templates. These are the
#     sanctioned ADR 0008 escape hatch — the js`...` tag in TypeScript, and a
#     plain `js/` string in JSON, because there is nothing to lower them to.
#   - Control / trigger-config positions, which `lowerRefs` does not cover, so
#     a structural ref there would be walked into by the Mapper and silently do
#     the wrong thing: branch.when, loop.while, switch.on, switch cases' when,
#     forEach.in, wait.for/until, subworkflow, step idempotencyKey, and trigger
#     concurrencyKey / debounce.key / idempotencyKey. Lines assigning one of
#     those keys are filtered out below.
#
# ponytail: textual gate. Position-aware checking of JSON workflow files is
# possible today (`blokctl migrate refs --dry-run` reports would-change counts)
# and would remove the key-name filter — worth doing if this gate ever produces
# a false positive that matters. It cannot help with .mdx code fences, which is
# most of the surface, so grep carries the load either way.
#
# Run directly: bash scripts/check-no-legacy-expr.sh
# Wired into: bun run check:no-legacy-expr, scripts/ci-local.sh gates(),
# .github/workflows/no-legacy-expr.yml (runs on docs-only PRs too).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Word-boundary note: `\b` is a GNU-grep/PCRE extension, not POSIX ERE — this
# platform's `git grep -E` silently treats it as a no-op MATCH FAILURE rather
# than erroring, which turns a gate into a permanent false green. (Measured on
# this repo: `git grep -E '\$\.(state|request|vars)\b'` → 0 files;
# `git grep -E '\$\.(state|request|vars)([^a-zA-Z0-9_]|$)'` → 19 files.) Every
# boundary below is spelled out as an explicit character class.
PATH_ACCESSOR="(\\.[A-Za-z_\$][A-Za-z0-9_\$]*|\\[[0-9]+\\]|\\['[^']*'\\])"
PURE_PATH="js/ctx\\.(state|vars|request|req|prev|response|error)${PATH_ACCESSOR}*[\"'\`]"
INTERPOLATION="\\\$\\{ *(ctx|vars)\\."
PATTERN="${PURE_PATH}|${INTERPOLATION}"

# Lines that are a `js/` template literal (the escape hatch) legitimately carry
# `${ctx...}` inside the backticks.
SKIP_TEMPLATE='js/`'
# Lines that assign, or explicitly NAME, a control / trigger-config field: a
# path string is the only form those positions accept. Naming the field is the
# bar for prose — a doc that shows a bare path string without saying which
# field it belongs to reads as general authoring guidance, which is the thing
# this gate exists to stop. `expression` is @blokjs/expr's deliberately-raw JS
# input (the documented exception; it must NOT carry a js/ prefix).
#
# `/d/reference/mapper` is the other accepted framing: a line that links the
# internals / wire-format page is explicitly presenting the string AS the wire
# format. It is a deliberate, non-gameable bar — you have to send the reader to
# the page that says "you never write these by hand".
SKIP_CONTROL_KEY='(concurrencyKey|idempotencyKey|debounceKey|subworkflow|expression'\
'|forEach\.in|switch\.on|wait\.(for|until)|loop\.while|branch\.when'\
'|"(key|when|while|on|in|for|until|expression)"|\b(key|when|while|on|in|until):'\
'|/d/reference/mapper)'

# The authoring surface. Everything else in the repo (engine, tests, corpus,
# specs, CHANGELOG) legitimately contains the wire format.
INCLUDE_PATHS=(
	"docs"
	"documentation"
	"templates"
	"examples"
	"packages/vscode-extension"
	"packages/lsp-server"
	"packages/syntax"
	"packages/intellij-plugin"
	"packages/neovim-plugin"
	"README.md"
	"CLAUDE.md"
	"AGENTS.md"
)
# NOT covered yet: .claude/skills/blok-framework.md. It is the single largest
# remaining source of `js/ctx....` teaching (~50 sites) and the most damaging
# one, since it is read by AI agents — but it is a 1376-line v1-era document
# (`set_var`, `BlokService`, `"node":` steps, `ctx.vars['step-name']`), so
# purging the expressions without rewriting the rest would leave it
# self-inconsistent. Issue #690's scope list does not include it. Rewrite it
# against the current authoring surface, then add it here.

ALLOWED_FILES=(
	# The internals / wire-format page. Its whole subject is these strings, and
	# it carries the "not an authoring API" banner.
	"docs/d/reference/mapper.mdx"
	# @blokjs/expr's `expression` input is verbatim JS by design (and must NOT
	# carry a js/ prefix — that double-evaluates). The documented exception.
	"docs/d/reference/helpers/expr.mdx"
	# Dated release notes. A past entry truthfully describing what shipped at
	# that version is not an authoring surface.
	"docs/changelog.mdx"
	# The VS Code diagnostics suite. Its fixtures must contain the legacy shapes
	# as INPUT to prove the validator still accepts workflows in the wild.
	"packages/vscode-extension/src/__tests__/WorkflowDiagnostics.test.ts"
)
ALLOWED_DIRS=(
	# Before/after migration guides — intentionally full of the legacy shapes.
	"docs/c/migration-guides"
	# Dated design records: plans, roadmaps, specs and implementation write-ups
	# for the contributor tab. A historical account of how the engine got here,
	# not authoring guidance. (The four primitive how-tos under docs/c/devtools
	# ARE authoring pages and are NOT excluded — they are listed individually
	# as inclusions by virtue of not appearing here.)
	"docs/c/devtools/additional-triggers-plan.mdx"
	"docs/c/devtools/workflow-primitives-roadmap.mdx"
	"docs/c/devtools/workflow-primitives-implementation.mdx"
	"docs/c/devtools/post-v04-roadmap.mdx"
	"docs/c/devtools/wait-inside-primitives-design.mdx"
	"docs/c/devtools/parallel-foreach-wait-spec.mdx"
	# v1-shape showcase workflows (`steps[] + nodes{}` with @blokjs/if-else
	# `conditions`). Structural refs are IMPOSSIBLE for their nested steps:
	# WorkflowNormalizer only lowers node configs whose key matches a TOP-LEVEL
	# step (the `nodes` carry-over loop copies the rest verbatim), so a `{$ref}`
	# inside a conditions arm is walked into by the Mapper instead of resolved.
	# Migrating them means either an engine change (out of scope, ADR 0001 keeps
	# the engine byte-identical) or a v1→v2 conversion that changes normalized
	# semantics. Tracked for a founder decision; examples/v05-primitives and
	# examples/ts-workflows are the current, clean example sets.
	"examples/workflows"
	"examples/integrations"
)

pathspec=()
for p in "${INCLUDE_PATHS[@]}"; do
	pathspec+=("$p")
done
for f in "${ALLOWED_FILES[@]}"; do
	pathspec+=(":(exclude)$f")
done
for d in "${ALLOWED_DIRS[@]}"; do
	pathspec+=(":(exclude)$d" ":(exclude)$d/**")
done

hits="$(git grep --untracked -n -E "$PATTERN" -- "${pathspec[@]}" |
	grep -vF "$SKIP_TEMPLATE" |
	grep -vE "$SKIP_CONTROL_KEY" || true)"

if [ -n "$hits" ]; then
	echo "$hits"
	echo
	echo "✗ Found legacy mapper expression strings on the public authoring surface."
	echo "  \`js/ctx....\` and \`\${ctx....}\` are the runtime wire format, not an authoring API."
	echo "  Use typed handles (TS) or structural {\"\$ref\": {\"step\", \"path\"}} / {\"\$tpl\": [...]} (JSON)."
	echo "  See docs/c/migration-guides/legacy-expression-strings.mdx — \`blokctl migrate refs\` does most of it."
	exit 1
fi

echo "✓ No legacy mapper expression strings on the authoring surface."
