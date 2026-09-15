# The 45 scenarios, and where each one runs

Every row is one Playwright test in `conformance.spec.ts`. "Cells" says where it
is meaningful: **all** = every cell of the matrix; the rest name the cells that
run it, and the ones that skip print the reason rather than going quiet.

| # | Test name | Cells |
|---|---|---|
| 1 | `01 — initial load varies on X-Inertia, renders Home, and is one navigation` | all |
| 2 | `02 — a Link click is exactly one Inertia XHR and no navigation` | all |
| 3 | `03 — Back restores Home from history with no request` | all |
| 4 | `04 — scroll position on Orders survives a visit to Orders/Show and Back` | all |
| 5 | `05 — an invalid create 303s back, keeps the typed qty and shows errors once` | all |
| 6 | `06 — a valid create 303s to the list, shows the order, and is exactly POST + GET` | all |
| 7 | `07 — router.delete sends DELETE and the server answers 303` | all |
| 8 | `08 — the deferred Python stats prop resolves once, in the follow-up request only` | all |
| 9 | `09 — router.reload({ only }) returns exactly that prop plus errors` | all |
| 10 | `10 — a new asset version makes the next GET a 409 and forces a full reload` | all |
| 11 | `11 — a stale asset version does NOT 409 a POST; it stays a 303` | all |
| 12 | `12 — a guest visiting /secret is redirected to /login, on a full load and on an XHR` | all |
| 13 | `13 — after signing in, /secret renders and props.auth.email comes from inertia.shared` | all |
| 14 | `14 — standalone: CORS preflight passes and X-Inertia-Location is readable cross-origin` | standalone |
| 15 | `15 — SSR: the no-JS HTML already carries the page, and hydration is clean` | ssr |
| 16 | `16 — a prop carrying a closing script tag cannot execute` | all |
| 17 | `17 — the HTML never leaks request headers or cookies` | all |
| 18 | `18 — a full navigation cycle emits no console.error` | all (plus the `afterEach` gate on every other test) |
| 19 | `19 — generated app types typecheck, and a renamed prop breaks the client build` | all |
| 20 | `20 — the boot payload is a JSON script tag, escaped, and boots cleanly` | all |
| 21 | `21 — except narrows a reload, and reset replaces a scroll prop instead of appending` | all |
| 22 | `22 — a merge prop appends a page and replaces a matching id in place` | all |
| 23 | `23 — two InfiniteScrolls on one page keep independent page parameters` | all |
| 24 | `24 — a once prop is omitted when moving between two pages that share it` | all |
| 25 | `25 — an optional prop is absent on load and arrives on an only reload` | all |
| 26 | `26 — deferred groups load in parallel and a rescued prop retries` | all |
| 27 | `27 — flash fires once, shows a toast, and does not come back on Back` | all |
| 28 | `28 — two forms with the same field name keep their errors in separate bags` | all |
| 29 | `29 — withAllErrors renders every message for one field` | all |
| 30 | `30 — Precognition answers 204 for valid input without running the write` | all |
| 31 | `31 — a multipart upload spoofs PUT over POST and reports 100% progress` | all |
| 32 | `32 — an expired CSRF cookie redirects back with the expiry flash, not a modal` | all |
| 33 | `33 — an encrypted history entry keeps the page out of session history` | all |
| 34 | `34 — a thrown step renders the production error page as an Inertia response` | all |
| 35 | `35 — an external redirect leaves the app; a fragment redirect keeps the SPA` | all |
| 36 | `36 — an instant Link renders the next page with the shared auth already there` | all |
| 37 | `37 — prefetch on hover serves the click from cache, and the cache expires` | all |
| 38 | `38 — usePoll issues about four partial requests in two seconds` | all |
| 39 | `39 — WhenVisible fetches its prop only once it scrolls into view` | all |
| 40 | `40 — remembered form state is restored after navigating away and Back` | all |
| 41 | `41 — Head sets the document title, and the shell carries a fallback` | all |
| 42 | `42 — a version change during polling waits for the next user click` | all |
| 43 | `43 — every response carries a DevTools id whose entry names the request type` | all |
| 44 | `44 — the auth starter kit loops register, dashboard, sign out and guard` | the in-project/node cell of each framework (it drives a SECOND project, scaffolded by `blokctl add spa --kit auth`) |
| 45 | `45 — inertia.pages.list reflects the fixture's real pages` | all |

## Where a scenario reads differently from the issue, and why

- **8** — the "did the step run" half is asserted SERVER-side: the Python node
  keeps a call counter in a file and `GET /__e2e/python-calls` reports it, so the
  test proves `stats` resolved exactly once AND only in the deferred follow-up.
  (The issue suggested a run-tracker endpoint; there is none.)
- **10, 42** — "navigation entries length becomes 2" cannot be observed: a full
  page load is a NEW document whose `performance.getEntriesByType("navigation")`
  list restarts at 1. The tests mark the live document and assert the marker is
  gone (reload) or still there (no reload).
- **31** — Inertia spoofs the method in the multipart BODY, not in an
  `X-HTTP-Method-Override` header, and Chromium does not expose a multipart body
  to Playwright. The proof that spoofing reached the server is that
  `PUT /orders/upload` — a route with no POST handler — answered the POST with
  its own redirect and flash.
- **39** — the issue writes `<WhenVisible data="stats">`, which cannot coexist
  with scenario 8's deferred `stats` on the same page (a deferred prop fetches
  itself). The fixture uses an `optional()` prop named `visible`; the behaviour
  under test — the partial leaves only on scroll-into-view — is identical.
- **43** — `deferred` and `poll` are keyed on `X-Inertia-Devtools-Deferred` /
  `-Poll`, which the DevTools BROWSER EXTENSION adds; the stock
  `@inertiajs/core` 3.7.1 never sends them (verified against the bundle), so
  without the extension both arrive as `partial`. The test drives
  `navigate`, `partial`, `prefetch` and `precognition` from the real client, and
  issues the two extension-shaped requests itself against the same live server.
- **44** — the kit is a different scaffold (`--kit auth` owns `/login`,
  `/register`, `/dashboard` and a `Dashboard` component), so it gets its own
  project and its own server rather than being merged into the fixture.
