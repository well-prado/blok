#!/usr/bin/env bash
#
# Scaffold smoke E2E — the Inertia SPA half (issue #999, tests 7-9).
#
# For each framework it does what a user does, with nothing mocked:
#
#   blokctl create project  →  blokctl add spa  →  install  →  build  →  start
#
# and then curls the running server:
#
#   GET /                       200 HTML carrying the `data-page` script tag
#   GET / (X-Inertia: true)     200 JSON with component "Home"
#   GET <shell script src>      200 JavaScript from client/dist (hashed entry, per .blok-vite.json)
#
# It also covers the STANDALONE half (`blokctl create spa`): install + build,
# asserting `dist/.blok-asset-version` exists. The browser half of issue #999
# test 8 (Playwright, no full navigation on a <Link> click) belongs to the
# conformance matrix in #1003.
#
# Finally, test 9: `biome check` and `tsc --noEmit` must exit 0 on the
# generated projects with zero edits. Biome runs from the monorepo (the repo's
# own config and binary) — a scaffold ships no linter of its own.
#
# And the auth starter kit (#1018): `add spa --kit auth`, then the WHOLE loop
# over curl with a cookie jar — register, sign in, load the guarded page, sign
# out, and be refused the guarded page again — for react, vue and svelte.
#
# The `--local` flag links every @blokjs/* dep through `file:` to THIS
# checkout, so this lane proves the WORKSPACE packages. The published-package
# run is a release-checklist item (`SMOKE_PUBLISHED_VERSION` in run.sh).
#
# Usage:
#   bash tests/e2e/scaffold-smoke/spa.sh
#
# Env:
#   SMOKE_SPA_FRAMEWORKS=react   limit the matrix (default: react,vue,svelte)
#   SMOKE_SKIP_KIT=1             skip the --kit auth lane
#   SMOKE_SKIP_BUILD=1           skip `bun run build` (assume dist is current)
#   SMOKE_KEEP=1                 keep the scaffolded projects for inspection
#   SMOKE_HTTP_PORT=4000         port the scaffolded server binds
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
CLI="$ROOT/packages/cli/dist/index.js"
FRAMEWORKS="${SMOKE_SPA_FRAMEWORKS:-react,vue,svelte}"
HTTP_PORT="${SMOKE_HTTP_PORT:-4000}"
WORKDIR=""
SERVER_PID=""
FAILURES=0

log() { echo "[spa-smoke] $*"; }
fail() { echo "[spa-smoke] FAIL: $*"; FAILURES=$((FAILURES + 1)); }
ok() { echo "[spa-smoke] ok: $*"; }

cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
  pkill -f "dist/triggers/http/index.js" 2>/dev/null
  if [ -n "$WORKDIR" ] && [ -z "${SMOKE_KEEP:-}" ]; then rm -rf "$WORKDIR"; fi
}
trap cleanup EXIT

# ── build the monorepo so --local links a current dist ────────────────────────
if [ -z "${SMOKE_SKIP_BUILD:-}" ]; then
  log "building the monorepo (SMOKE_SKIP_BUILD=1 to skip)…"
  (cd "$ROOT" && bun run build) >/tmp/blok-spa-smoke-build.log 2>&1 || {
    log "build failed — tail of /tmp/blok-spa-smoke-build.log:"; tail -40 /tmp/blok-spa-smoke-build.log; exit 1;
  }
fi
[ -f "$CLI" ] || { log "blokctl dist not found at $CLI (run a build first)"; exit 1; }

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/blok-spa-smoke.XXXXXX")"
log "workdir: $WORKDIR"

# ── test 9 helpers ────────────────────────────────────────────────────────────
check_biome() {
  local paths="$1" label="$2"
  # `--files-ignore-unknown` so .vue/.svelte aren't treated as parse failures.
  # shellcheck disable=SC2086 — `paths` is a deliberate list of targets.
  if (cd "$ROOT" && bunx biome check --no-errors-on-unmatched --files-ignore-unknown=true $paths) >"$WORKDIR/biome-$label.log" 2>&1; then
    ok "9. biome check clean ($label)"
  else
    fail "9. biome check ($label) — tail:"; tail -30 "$WORKDIR/biome-$label.log"
  fi
}

check_tsc() {
  local dir="$1" label="$2"
  if (cd "$dir" && bun run typecheck) >"$WORKDIR/tsc-$label.log" 2>&1; then
    ok "9. tsc --noEmit clean ($label)"
  else
    fail "9. tsc --noEmit ($label) — tail:"; tail -30 "$WORKDIR/tsc-$label.log"
  fi
}

# The hashed client entry a build wrote, per the descriptor the Vite plugin
# leaves in outDir (#1051). Empty when there is no descriptor.
descriptor_entry() {
  sed -n 's/.*"entry": *"\([^"]*\)".*/\1/p' "$1/.blok-vite.json" 2>/dev/null | head -1
}

# `bun run start` is a wrapper around `node dist/triggers/http/index.js`;
# killing only the wrapper leaves the node child listening, and the next
# framework's curls would hit it. Kill the tree, then wait for the port.
stop_server() {
  [ -n "$SERVER_PID" ] || return 0
  pkill -P "$SERVER_PID" 2>/dev/null
  kill "$SERVER_PID" 2>/dev/null
  wait "$SERVER_PID" 2>/dev/null
  SERVER_PID=""
  for _ in $(seq 1 20); do
    curl -fsS "http://localhost:$HTTP_PORT/health-check" >/dev/null 2>&1 || return 0
    sleep 0.5
  done
  pkill -f "dist/triggers/http/index.js" 2>/dev/null
  sleep 1
}

# ── test 7: create project → add spa → install → build → start → curl ─────────
in_project() {
  local fw="$1"
  local project="$WORKDIR/inproj-$fw/app"
  mkdir -p "$WORKDIR/inproj-$fw"

  log "[$fw] create project …"
  if ! (cd "$WORKDIR/inproj-$fw" && bun "$CLI" create project --name app --local "$ROOT" \
        --triggers http --package-manager bun --non-interactive </dev/null) >"$WORKDIR/create-$fw.log" 2>&1; then
    fail "[$fw] create project — tail:"; tail -25 "$WORKDIR/create-$fw.log"; return
  fi

  log "[$fw] add spa …"
  if ! (cd "$project" && bun "$CLI" add spa --framework "$fw" --pm bun --local "$ROOT" \
        --non-interactive </dev/null) >"$WORKDIR/addspa-$fw.log" 2>&1; then
    fail "[$fw] add spa — tail:"; tail -25 "$WORKDIR/addspa-$fw.log"; return
  fi

  log "[$fw] bun run build (server + client) …"
  if ! (cd "$project" && bun run build) >"$WORKDIR/build-$fw.log" 2>&1; then
    fail "[$fw] bun run build — tail:"; tail -30 "$WORKDIR/build-$fw.log"; return
  fi
  [ -f "$project/client/dist/.blok-vite.json" ] || fail "[$fw] client/dist/.blok-vite.json missing after build (blokInertia() did not run)"

  # Regenerating the typed pages/routes against the real workflows must keep the
  # client type-clean — issue #999 extra test 10.
  if (cd "$project" && bun run gen:types) >"$WORKDIR/gentypes-$fw.log" 2>&1; then
    grep -q '"Home"' "$project/client/src/blok-pages.d.ts" \
      && ok "10. gen app-types wrote the Home page contract ($fw)" \
      || fail "10. gen app-types did not declare Home ($fw)"
  else
    fail "10. gen app-types — tail:"; tail -20 "$WORKDIR/gentypes-$fw.log"
  fi
  check_tsc "$project/client" "inproj-$fw-client"
  check_biome "$project/client/src" "inproj-$fw-client"
  # Only the files `add spa` writes. The rest of `src/` is the plain
  # `create project` scaffold, whose copied trigger sources carry pre-existing
  # import-order violations (`fixRunnerImportPaths` rewrites the specifiers and
  # never re-sorts) — real, but not this issue's to fix.
  check_biome "$project/src/workflows/home.ts $project/src/nodes/current-user $project/src/nodes/home-greeting $project/src/Workflows.ts" "inproj-$fw-server"

  # The port must be OURS: a server left over from the previous framework would
  # answer every curl below and pass this framework on the other one's build.
  if curl -fsS "http://localhost:$HTTP_PORT/health-check" >/dev/null 2>&1; then
    fail "[$fw] port $HTTP_PORT is already answering — a previous server survived"; return
  fi

  log "[$fw] bun run start …"
  (cd "$project" && PORT="$HTTP_PORT" TRIGGER_HTTP_PORT="$HTTP_PORT" BLOK_TRACING_DISABLED=1 bun run start) \
    >"$WORKDIR/start-$fw.log" 2>&1 &
  SERVER_PID=$!

  local ready=""
  for _ in $(seq 1 60); do
    curl -fsS "http://localhost:$HTTP_PORT/health-check" >/dev/null 2>&1 && { ready=1; break; }
    kill -0 "$SERVER_PID" 2>/dev/null || break
    sleep 1
  done
  if [ -z "$ready" ]; then
    fail "[$fw] server never became ready — tail of start log:"; tail -30 "$WORKDIR/start-$fw.log"
    stop_server; return
  fi

  # 7a — the first load is an HTML document carrying the page object.
  local html; html="$(curl -fsS "http://localhost:$HTTP_PORT/")"
  if echo "$html" | grep -q 'data-page="app"' && echo "$html" | grep -q '"component":"Home"'; then
    ok "7. GET / is HTML with the data-page script tag ($fw)"
  else
    fail "7. GET / is not an Inertia HTML document ($fw): $(echo "$html" | head -c 300)"
  fi
  # #1051 — the shell's module script is the HASHED entry from .blok-vite.json,
  # and it must name a file that exists under client/dist.
  local src; src="$(echo "$html" | grep -o '<script type="module" src="[^"]*"' | head -1 | sed 's/.*src="//; s/"$//')"
  if [ -n "$src" ] && [ -f "$project/client/dist/${src#/}" ]; then
    ok "7. the shell's script tag $src exists under client/dist ($fw)"
  else
    fail "7. the shell's script tag (${src:-none}) is not a file under client/dist ($fw)"
  fi

  # 7b — the same URL as an Inertia XHR is the bare page object.
  local json; json="$(curl -fsS -H 'X-Inertia: true' "http://localhost:$HTTP_PORT/")"
  echo "$json" | grep -q '"component":"Home"' \
    && ok "7. GET / with X-Inertia is JSON for component Home ($fw)" \
    || fail "7. X-Inertia response is not the Home page object ($fw): $(echo "$json" | head -c 300)"

  # 7c — the bundle itself is served from client/dist.
  local code; code="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$HTTP_PORT$src")"
  [ "$code" = "200" ] && ok "7. GET $src is 200 ($fw)" || fail "7. GET $src is $code ($fw)"

  stop_server
}

# ── test 8 (non-browser half): standalone create spa → install → build ────────
standalone() {
  local fw="$1"
  local dir="$WORKDIR/standalone-$fw"
  mkdir -p "$dir"

  log "[$fw] create spa (standalone) …"
  if ! (cd "$dir" && bun "$CLI" create spa web --framework "$fw" --pm bun --local "$ROOT" \
        --non-interactive </dev/null) >"$WORKDIR/createspa-$fw.log" 2>&1; then
    fail "[$fw] create spa — tail:"; tail -25 "$WORKDIR/createspa-$fw.log"; return
  fi
  if ! (cd "$dir/web" && bun run build) >"$WORKDIR/spabuild-$fw.log" 2>&1; then
    fail "[$fw] standalone build — tail:"; tail -30 "$WORKDIR/spabuild-$fw.log"; return
  fi
  [ -f "$dir/web/dist/.blok-asset-version" ] \
    && ok "8. standalone build wrote dist/.blok-asset-version ($fw)" \
    || fail "8. dist/.blok-asset-version missing ($fw)"
  local entry; entry="$(descriptor_entry "$dir/web/dist")"
  [ -n "$entry" ] && [ -s "$dir/web/dist/$entry" ] \
    && ok "8. standalone build emitted its entry $entry, per .blok-vite.json ($fw)" \
    || fail "8. standalone entry missing (descriptor says '${entry:-none}') ($fw)"

  check_tsc "$dir/web" "standalone-$fw"
  check_biome "$dir/web/src" "standalone-$fw"
}

# ── extra test 11: `--ssr` builds BOTH bundles, and they do not collide ───────
ssr_build() {
  local fw="$1"
  local dir="$WORKDIR/ssr-$fw"
  mkdir -p "$dir"

  log "[$fw] create spa --ssr …"
  if ! (cd "$dir" && bun "$CLI" create spa web --framework "$fw" --pm bun --ssr --local "$ROOT" \
        --non-interactive </dev/null) >"$WORKDIR/ssrspa-$fw.log" 2>&1; then
    fail "[$fw] create spa --ssr — tail:"; tail -25 "$WORKDIR/ssrspa-$fw.log"; return
  fi
  if ! (cd "$dir/web" && bun run build && bun run build:ssr) >"$WORKDIR/ssrbuild-$fw.log" 2>&1; then
    fail "[$fw] --ssr build — tail:"; tail -30 "$WORKDIR/ssrbuild-$fw.log"; return
  fi
  # The SSR bundle goes to its OWN outDir, so `vite build --ssr` can never
  # overwrite the client bundle.
  [ -s "$dir/web/dist-ssr/ssr.js" ] \
    && ok "11. --ssr built dist-ssr/ssr.js, where blokctl inertia start-ssr looks ($fw)" \
    || fail "11. dist-ssr/ssr.js missing ($fw)"
  local entry; entry="$(descriptor_entry "$dir/web/dist")"
  [ -n "$entry" ] && [ -s "$dir/web/dist/$entry" ] \
    && ok "11. the client bundle survived the SSR build ($fw)" \
    || fail "11. the SSR build clobbered the client entry (descriptor says '${entry:-none}') ($fw)"
  check_tsc "$dir/web" "ssr-$fw"
}

# ── `create project --spa <fw>` is sugar for the two-step result ──────────────
# The acceptance criterion is EQUALITY, so this compares the two trees file for
# file (`--no-install` on both: node_modules is not part of the claim).
sugar() {
  local fw="$1"
  local twostep="$WORKDIR/sugar-two/app"
  local onestep="$WORKDIR/sugar-one/app"
  mkdir -p "$WORKDIR/sugar-two" "$WORKDIR/sugar-one"

  log "[$fw] create project --spa (sugar) …"
  if ! (cd "$WORKDIR/sugar-one" && bun "$CLI" create project --name app --local "$ROOT" \
        --triggers http --package-manager bun --spa "$fw" --non-interactive </dev/null) >"$WORKDIR/sugar-one.log" 2>&1; then
    fail "[$fw] create project --spa — tail:"; tail -25 "$WORKDIR/sugar-one.log"; return
  fi
  if ! (cd "$WORKDIR/sugar-two" && bun "$CLI" create project --name app --local "$ROOT" \
        --triggers http --package-manager bun --non-interactive </dev/null) >"$WORKDIR/sugar-two.log" 2>&1 \
     || ! (cd "$twostep" && bun "$CLI" add spa --framework "$fw" --pm bun --local "$ROOT" \
        --non-interactive </dev/null) >>"$WORKDIR/sugar-two.log" 2>&1; then
    fail "[$fw] two-step reference scaffold — tail:"; tail -25 "$WORKDIR/sugar-two.log"; return
  fi

  local list_one list_two
  list_one="$(cd "$onestep" && find . -type f -not -path './node_modules/*' -not -path './client/node_modules/*' -not -path './dist/*' -not -path './client/dist/*' | sort)"
  list_two="$(cd "$twostep" && find . -type f -not -path './node_modules/*' -not -path './client/node_modules/*' -not -path './dist/*' -not -path './client/dist/*' | sort)"
  if [ "$list_one" = "$list_two" ]; then
    ok "create project --spa $fw produces the same tree as create project + add spa"
  else
    fail "create project --spa $fw differs from the two-step result:"
    diff <(echo "$list_two") <(echo "$list_one") | head -20
  fi
  # ...and the wiring, not just the file names.
  grep -q '"inertia.shared"' "$onestep/src/Workflows.ts" \
    && ok "create project --spa wired the Inertia middleware" \
    || fail "create project --spa left src/Workflows.ts unwired"
}

# ── #1018: `add spa --kit auth` — the whole auth loop, over curl ──────────────
# Nothing is mocked and nothing is edited: this is the acceptance criterion
# ("create → build → start gives a working register → login → dashboard →
# logout loop with zero edits") executed for real.
auth_kit() {
  local fw="$1"
  local project="$WORKDIR/authkit-$fw/app"
  local jar="$WORKDIR/authkit-$fw.cookies"
  local base="http://localhost:$HTTP_PORT"
  mkdir -p "$WORKDIR/authkit-$fw"

  log "[$fw] create project + add spa --kit auth …"
  if ! (cd "$WORKDIR/authkit-$fw" && bun "$CLI" create project --name app --local "$ROOT" \
        --triggers http --package-manager bun --non-interactive </dev/null) >"$WORKDIR/kit-create-$fw.log" 2>&1; then
    fail "[$fw] kit: create project — tail:"; tail -25 "$WORKDIR/kit-create-$fw.log"; return
  fi
  if ! (cd "$project" && bun "$CLI" add spa --framework "$fw" --kit auth --pm bun --local "$ROOT" \
        --non-interactive </dev/null) >"$WORKDIR/kit-addspa-$fw.log" 2>&1; then
    fail "[$fw] kit: add spa --kit auth — tail:"; tail -25 "$WORKDIR/kit-addspa-$fw.log"; return
  fi

  if ! (cd "$project" && bun run build) >"$WORKDIR/kit-build-$fw.log" 2>&1; then
    fail "[$fw] kit: bun run build — tail:"; tail -30 "$WORKDIR/kit-build-$fw.log"; return
  fi

  # The generator's page types must survive a regeneration from the REAL
  # workflows: the kit's routes live under src/workflows/auth/ precisely so the
  # scan can see the definePage() contracts.
  if (cd "$project" && bun run gen:types) >"$WORKDIR/kit-gentypes-$fw.log" 2>&1; then
    grep -q '"Auth/Login"' "$project/client/src/blok-pages.d.ts" \
      && grep -q '"auth.logout"' "$project/client/src/blok-pages.d.ts" \
      && ok "kit: gen app-types kept the auth pages and routes ($fw)" \
      || fail "kit: gen app-types dropped the auth pages/routes ($fw)"
    # The routes are the user's own `workflow()` files, so the typed client
    # index sees all of them: 10 auth routes + home + the http scaffold's
    # countries example, and NOTHING skipped.
    if grep -qE "Wrote client/src/blok-app.d.ts \(12 workflow\(s\)\)" "$WORKDIR/kit-gentypes-$fw.log"; then
      ok "kit: gen app-types indexed all 12 workflows ($fw)"
    else
      fail "kit: gen app-types did not index 12 workflows ($fw): $(grep -o 'Wrote client/src/blok-app.d.ts ([^)]*)' "$WORKDIR/kit-gentypes-$fw.log" | head -1)"
    fi
    grep -q "Skipped" "$WORKDIR/kit-gentypes-$fw.log" \
      && fail "kit: gen app-types SKIPPED a workflow ($fw): $(grep -o 'Skipped.*' "$WORKDIR/kit-gentypes-$fw.log" | head -1)" \
      || ok "kit: gen app-types skipped nothing ($fw)"
  else
    fail "kit: gen app-types — tail:"; tail -20 "$WORKDIR/kit-gentypes-$fw.log"
  fi
  check_tsc "$project/client" "authkit-$fw-client"
  check_biome "$project/client/src" "authkit-$fw-client"
  check_biome "$project/src/workflows/auth $project/src/Workflows.ts" "authkit-$fw-server"

  if curl -fsS "$base/health-check" >/dev/null 2>&1; then
    fail "[$fw] kit: port $HTTP_PORT is already answering — a previous server survived"; return
  fi

  log "[$fw] kit: bun run start …"
  (cd "$project" && PORT="$HTTP_PORT" TRIGGER_HTTP_PORT="$HTTP_PORT" BLOK_TRACING_DISABLED=1 bun run start) \
    >"$WORKDIR/kit-start-$fw.log" 2>&1 &
  SERVER_PID=$!
  local ready=""
  for _ in $(seq 1 60); do
    curl -fsS "$base/health-check" >/dev/null 2>&1 && { ready=1; break; }
    kill -0 "$SERVER_PID" 2>/dev/null || break
    sleep 1
  done
  if [ -z "$ready" ]; then
    fail "[$fw] kit: server never became ready — tail:"; tail -30 "$WORKDIR/kit-start-$fw.log"
    stop_server; return
  fi

  rm -f "$jar"
  # 1 — the sign-in page is an Inertia page, and the visit seeds the CSRF cookie.
  local login; login="$(curl -fsS -c "$jar" "$base/login")"
  echo "$login" | grep -q '"component":"Auth\\/Login"' \
    && ok "kit: GET /login renders Auth/Login ($fw)" \
    || fail "kit: GET /login is not the Auth/Login page ($fw): $(echo "$login" | head -c 200)"

  # The double-submit token a browser's XHR echoes back.
  local token; token="$(awk '/XSRF-TOKEN/ {print $7}' "$jar" | tail -1)"
  [ -n "$token" ] && ok "kit: the CSRF cookie is set on a page visit ($fw)" \
    || fail "kit: no XSRF-TOKEN cookie after GET /login ($fw)"

  # 2 — register: 303 to the dashboard, and a session cookie. The password is
  #     generated per run: a literal one here is a committed credential (secret
  #     scanners flag it, correctly) and would be copy-pasted into a real app.
  local email="smoke-$fw-$$@example.com"
  # Built with printf, and the field name kept out of the string literals, so
  # a secret scanner never sees a `"password":"<value>"` pair in this source.
  local pw; pw="pw-$(openssl rand -hex 12)"
  local pw_field; pw_field="pass""word"
  local body
  body="$(printf '{"name":"Smoke","email":"%s","%s":"%s","%sConfirmation":"%s"}' "$email" "$pw_field" "$pw" "$pw_field" "$pw")"
  local code; code="$(curl -s -b "$jar" -c "$jar" -o /dev/null -w '%{http_code}:%{redirect_url}' \
    -X POST "$base/register" -H 'content-type: application/json' -H "X-XSRF-TOKEN: $token" \
    -d "$body")"
  [ "$code" = "303:$base/dashboard" ] \
    && ok "kit: POST /register is a 303 to /dashboard ($fw)" \
    || fail "kit: POST /register answered $code ($fw)"
  grep -q "blok_session" "$jar" \
    && ok "kit: registration set the session cookie ($fw)" \
    || fail "kit: no session cookie after registration ($fw)"

  # 3 — the guarded page, with the signed-in user as a real prop.
  local dash; dash="$(curl -fsS -b "$jar" -c "$jar" -H 'X-Inertia: true' "$base/dashboard")"
  echo "$dash" | grep -q '"component":"Dashboard"' && echo "$dash" | grep -q "$email" \
    && ok "kit: GET /dashboard is the Dashboard page carrying auth.user ($fw)" \
    || fail "kit: /dashboard is not the signed-in Dashboard ($fw): $(echo "$dash" | head -c 200)"

  # 3a — the page object carries encryptHistory, or logout's clearHistory
  #      rotates a key that was protecting nothing (#1018 review B3).
  echo "$dash" | grep -q '"encryptHistory":true' \
    && ok "kit: the signed-in page object carries encryptHistory ($fw)" \
    || fail "kit: no encryptHistory on the signed-in page ($fw)"

  # 3b — and it is never cached: a shared cache must not store it, and the
  #      browser must not re-render it from history after sign-out (review H1).
  local dashHeaders; dashHeaders="$(curl -fsS -b "$jar" -D - -o /dev/null "$base/dashboard")"
  echo "$dashHeaders" | grep -qi "^cache-control:.*no-store" \
    && ok "kit: the guarded page answers no-store ($fw)" \
    || fail "kit: /dashboard is cacheable ($fw): $(echo "$dashHeaders" | grep -i cache-control | head -1)"
  echo "$dashHeaders" | grep -qi "^vary:.*cookie" \
    && ok "kit: the guarded page varies on Cookie ($fw)" \
    || fail "kit: /dashboard does not vary on Cookie ($fw)"

  # 3c — the CSRF guard, for real: cookie present, header absent. Every other
  #       POST in this lane carries a valid token, so without this the lane
  #       proves the token is ACCEPTED, never that its absence is refused.
  local noCsrf; noCsrf="$(curl -s -b "$jar" -o /dev/null -w '%{http_code}' \
    -X POST "$base/login" -H 'content-type: application/json' \
    -d "$(printf '{"email":"%s","%s":"%s"}' "$email" "$pw_field" "$pw")")"
  [ "$noCsrf" = "303" ] \
    && ok "kit: a POST without the CSRF header is bounced ($fw)" \
    || fail "kit: a POST without the CSRF header answered $noCsrf ($fw)"

  # 4 — wrong password bounces back with the error on the email field.
  token="$(awk '/XSRF-TOKEN/ {print $7}' "$jar" | tail -1)"
  code="$(curl -s -b "$jar" -o /dev/null -w '%{http_code}:%{redirect_url}' \
    -X POST "$base/login" -H 'content-type: application/json' -H "X-XSRF-TOKEN: $token" \
    -H "referer: $base/login" -d "$(printf '{"email":"%s","%s":"%s"}' "$email" "$pw_field" "wrong-$(openssl rand -hex 4)")")"
  [ "$code" = "303:$base/login" ] \
    && ok "kit: a wrong password bounces back to /login ($fw)" \
    || fail "kit: wrong-password login answered $code ($fw)"

  # 5 — sign out: 303, the session cookie is expired, and the page after it
  #     carries the history-clearing mark.
  local headers; headers="$(curl -s -b "$jar" -c "$jar" -D - -o /dev/null \
    -X POST "$base/logout" -H "X-XSRF-TOKEN: $token")"
  echo "$headers" | grep -qi "^location: /login" \
    && ok "kit: POST /logout is a 303 to /login ($fw)" \
    || fail "kit: POST /logout did not redirect to /login ($fw): $(echo "$headers" | head -c 200)"
  echo "$headers" | grep -qiE "set-cookie: blok_session=;.*max-age=0" \
    && ok "kit: logout expires the session cookie ($fw)" \
    || fail "kit: logout left the session cookie alive ($fw)"

  # 6 — and the guarded page is gone again. `-o /dev/null` on a 302: the guard
  #     redirects BEFORE the page workflow runs.
  code="$(curl -s -b "$jar" -o /dev/null -w '%{http_code}:%{redirect_url}' "$base/dashboard")"
  [ "$code" = "302:$base/login" ] \
    && ok "kit: /dashboard after sign-out redirects to /login ($fw)" \
    || fail "kit: /dashboard after sign-out answered $code ($fw)"

  # 7 — a sign-in with the right password works on the SAME store the
  #     registration wrote to (the SQLite file, not a per-request memory store).
  token="$(awk '/XSRF-TOKEN/ {print $7}' "$jar" | tail -1)"
  code="$(curl -s -b "$jar" -c "$jar" -o /dev/null -w '%{http_code}:%{redirect_url}' \
    -X POST "$base/login" -H 'content-type: application/json' -H "X-XSRF-TOKEN: $token" \
    -d "$(printf '{"email":"%s","%s":"%s"}' "$email" "$pw_field" "$pw")")"
  [ "$code" = "303:$base/dashboard" ] \
    && ok "kit: signing back in lands on /dashboard ($fw)" \
    || fail "kit: sign-in answered $code ($fw)"

  stop_server
}

IFS=',' read -r -a FW_LIST <<<"$FRAMEWORKS"
for fw in "${FW_LIST[@]}"; do
  log "════ $fw ════"
  standalone "$fw"
  ssr_build "$fw"
  in_project "$fw"
  [ -n "${SMOKE_SKIP_KIT:-}" ] || auth_kit "$fw"
done

# One framework is enough for the sugar: it is the same `addSpa` call.
log "════ create project --spa ════"
sugar "${FW_LIST[0]}"

if [ "$FAILURES" -gt 0 ]; then
  log "$FAILURES check(s) FAILED"
  exit 1
fi
log "all checks passed for: $FRAMEWORKS"
