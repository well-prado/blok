# Blok Studio · Redesign Plan (Direction A — Linear-grade Operator)

> Author: Claude (Huashu-Design pass) · 2026-04-29
> Scope: Studio at `apps/studio/`. Bring product depth and visual coherence to trigger.dev v4 quality without changing core architecture (React 19 + TanStack + @xyflow + Tailwind v4).
> Companion docs: `brand-spec.md` (palette + tokens), `run-detail-v2.html` (hi-fi prototype of the run-detail screen).

---

## 1 · Premise

The handoff said "Studio doesn't render anything; you have to make it as good as trigger.dev." After auditing the actual code, that premise is **wrong in a useful way**. Studio already ships:

- Real-time SSE (global + per-run) with exponential-backoff reconnect
- Cmd+K palette with debounced cross-trace search
- Run diff (overview / nodes / outputs)
- Tags, status filters, run comparison, custom dashboard grid
- BlokError §17 rendering (category / severity / retryable / remediation / docUrl)
- @xyflow + dagre auto-layout DAG
- Webhooks UI, CSV/JSON export, micro-animations

What Studio **doesn't** ship versus trigger.dev v4 (verified, not assumed):

| Trigger.dev capability | Blok Studio status |
|---|---|
| Environment as first-class scope on every page | absent |
| Logs page: cross-task text search + advanced filter | partial (per-run only, polling not SSE) |
| Custom dashboards | present |
| Bulk actions (replay/cancel multiple runs) | absent |
| Query language for runs (TRQL / SQL-style) | absent |
| Deployment / version pinning of task code | absent |
| Queues + Waitpoint inspection | absent |
| Real-time alerts (email/Slack/webhook) | webhooks UI only — no alert routing |
| Run metadata that updates as run progresses | absent |
| Bulk action UI surface | absent |

Plus three internal bugs the verification pass already found that block any UI improvement:

1. **gRPC wire-byte metrics never persist** — `RuntimeAdapterNode.run()` mutates a detached object then `RunnerSteps.completeNode()` overwrites with `undefined`. So `request_bytes`/`response_bytes` are never returned by `/__blok/runs/:id`.
2. **NODE_PROGRESS / NODE_PARTIAL_RESULT events arrive over SSE but `useRunDetail` ignores them** — Phase 5 streaming half-wired in UI.
3. **LogViewer polls `/runs/:id/events` every 3 s** — there's no log SSE consumer; logs do not push.

The redesign has to treat these as foundations: fix them in Phase 0 or every later UI improvement is built on sand.

---

## 2 · Design philosophy (Direction A)

**Linear-grade operator.** A workflow runner is the room engineers walk into during incidents and the room product managers walk into when they want to know what happened. The product should be:

1. **Calm.** No surprise color, no marketing chrome, no animations that aren't telling you a state changed.
2. **Dense and legible.** Density is the whole point — but density at 50 cm laptop and 1.5 m incident-room TV.
3. **Keyboard-respectful.** Tab-numbers + Cmd+K already exist. Extend, don't replace.
4. **One brand signature.** Blok green appears in three places only: logo, primary CTA, and the live-data pulse. Everywhere else is neutral + status palette.
5. **Honest empty states.** The "no runs yet" empty state must teach the operator how to make a run, not show a friendly mascot.

What this is *not*: it's not Bloomberg-Terminal density (Direction B), and it's not a beautiful-narrative-of-a-run viewer (Direction C). It's a working operator's tool that doesn't make you embarrassed to demo.

---

## 3 · Information architecture (the actual redesign)

### Today's IA
```
/  (Dashboard)
/runs                  · all runs flat
/runs/:id              · run detail (5 tabs: timeline/graph/logs/events/builder)
/runs/diff?a=&b=
/workflows/:name       · 3 tabs: runs/yaml/metrics
/metrics
/dashboards            · custom widget grid
/webhooks
```

### Proposed IA
```
/                                           · operator landing
  ├ env switcher (top-left, persistent)
  ├ live-feed (last 10 status flips, brand-pulsed)
  └ stats grid (24h success%, p50/p95 dur, error budget)

/runs                                       · all runs in env
  ├ left rail: status filter, tag filter, environment filter, advanced filter (TRQL-lite)
  ├ table: bulk-select via checkbox column → top-bar bulk actions toolbar
  └ row: status · workflow · trigger-type chip · started · duration · trigger-source

/runs/:id                                   · run detail (REDESIGN — see §4)

/logs                                       · cross-run logs page (NEW)
  ├ live tail toggle (consumes global SSE log multiplex)
  ├ text search (server-backed)
  ├ filter by: env, workflow, run-id, level, time
  └ "open run" click-through

/queues                                     · NEW — what's waiting to run
  ├ active queue depth per trigger
  ├ scheduled / cron next-fire times
  └ waitpoint tokens (manual unblock)

/deployments                                · NEW — workflow versions
  ├ list of registered workflow versions per env
  ├ which runs were on which version
  └ rollback (UI to set "active version" per env)

/workflows/:name                            · keep, refactor tabs to: definition / runs / metrics / triggers
/metrics                                    · keep, redesign tile layout
/dashboards                                 · keep, polish empty state + widget gallery
/webhooks → /alerts                         · rename + extend to email/slack channels
```

The pivot: **environments as a first-class concept** propagated to every page. Today nothing knows about envs; this is trigger.dev v4's biggest architectural win and the cheapest one to copy because the runner can return env from the run record at zero migration cost.

---

## 4 · The run-detail page (the center of gravity)

This is the screen operators stare at during incidents. Worth the most design budget.

### Today's layout
- 5 horizontal tabs (Timeline / Graph / Logs / Events / Builder) on a full-width body
- One column at a time
- NodeDetail opens as a right-side drawer when you click a node

### Proposed layout · 3-pane operator view

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ ←  Cross-Runtime Chain Test  ·  PASS  ·  83 ms              [⏎] replay  ⋯  │
│   run_23f1aa6  ·  prod  ·  v1.2.0  ·  POST /cross-runtime-chain  ·  9/9    │
├──────────────┬──────────────────────────────────────┬────────────────────────┤
│ STEP RAIL    │ ACTIVE STEP                          │ INSPECTOR              │
│  ▶ init      │   java                               │ duration   11.0 ms     │
│    go        │   runtime.java · grpc                │ wire       412 → 84 B  │
│    rust      │   step 4 / 9                         │ cpu        7 ms        │
│  ▶ java   ◀  │                                      │ memory     —           │
│    csharp    │   inputs                             │                        │
│    php       │   { chain: [3 entries], origin: …}   │ retries    0           │
│    ruby      │                                      │ depth      0           │
│    python    │   outputs                            │                        │
│    verify    │   { chain: [4 entries], origin: …}   │ logs (live)            │
│              │                                      │  14:55.041 jvm warm…   │
│  filter      │   logs (4)        [tail mode] [⏵]    │  14:55.052 chain.app…  │
│  level: all  │   ─────────────────────────────────  │                        │
│              │   14:55.041  info  jvm warmup 2ms    │                        │
│              │   14:55.052  info  chain.append ok   │ [⌥1 timeline] [⌥2 ↗]   │
└──────────────┴──────────────────────────────────────┴────────────────────────┘
```

### Why 3-pane

- **Step rail (left, 240 px):** the canonical answer to "where in the run am I?" — a vertical list with status dot, name, duration. Click jumps the active step. `j`/`k` moves up/down. `1`–`9` jumps directly. Always visible regardless of which tab the middle pane is on.
- **Active step (center, fluid):** the step's *content* — header (name, type, transport, position) + collapsible Inputs + Outputs + Logs + Trace position. Replaces today's tab bar with a *what-do-you-want-to-see-about-this-step* expandable layout.
- **Inspector (right, 320 px):** dense numbers — duration, wire bytes (once Phase 0 metrics bug is fixed), cpu, memory, retries, depth — plus live log tail of just that step. This is the screen-reading equivalent of a Bloomberg side panel.

### Tabs become tools, not separators

The 5 tabs from today (timeline / graph / logs / events / builder) become **modes the center pane can adopt**, switched with `⌥1`–`⌥5` instead of clicked tabs. Default mode is "active step" (the new layout above). Pressing `⌥2` swaps the center for a full-width @xyflow graph; `⌥3` for full-width logs across all steps; etc. Pressing `Esc` returns to the active-step mode. This keeps the spatial frame stable.

### BlokError frame — replaces the red brick

Today the error renders as a stack of subcomponents in the inspector. New frame, shown center-pane when active step has an error:

```
┌─ ERROR ──────────────────────────────────────────────────────────────────┐
│  TRANSIENT · DEPENDENCY · retryable in 1.5 s                            │
│                                                                          │
│  ConnectionRefused: gRPC dial tcp 127.0.0.1:10004 → connection refused   │
│                                                                          │
│  Remediation                                                             │
│   The C# SDK isn't responding on its gRPC port. Verify it's running     │
│   (lsof -iTCP:10004) and that BLOK_TRANSPORT=grpc is set on its env.    │
│                                                                          │
│  ↗ docs.blok.io/errors/dependency-grpc-unreachable                      │
│                                                                          │
│  Causes (3)                                          [expand all  ↑]    │
│   ▸ Adapter circuit breaker tripped                                     │
│   ▸ Health check failed 3× consecutive                                  │
│   ▸ Last successful response 14:55:48 (9s ago)                          │
│                                                                          │
│  Context snapshot                                    [json view  ↗]     │
│   adapter.kind: csharp · transport: grpc · port: 10004 · attempt: 1     │
└──────────────────────────────────────────────────────────────────────────┘
```

Every field already exists in `BlokErrorDetail.tsx` — this is a **layout reframing**, not new data. The improvement: error becomes the **page topic** when there is one, not an item in a sidebar. Errors deserve the page.

---

## 5 · Phased roadmap (8 phases · ship-incrementally)

Estimates are eng-days for one focused engineer. Phases 0–2 unlock UI improvements; 3–7 are feature build.

### Phase 0 · Foundations (3 days)

Three runner-side fixes before any UI work.

| # | Fix | File:line | Effort |
|---|---|---|---|
| 0.1 | Persist node metrics through `completeNode` | `core/runner/src/RuntimeAdapterNode.ts:68-77` + `RunnerSteps.ts:105` | 0.5 d |
| 0.2 | Wire NODE_PROGRESS + NODE_PARTIAL_RESULT in `useRunDetail` | `apps/studio/src/hooks/useRunDetail.ts` | 0.5 d |
| 0.3 | Replace `EventLog` polling with SSE log-multiplex consumer | `apps/studio/src/hooks/useEventLog.ts` (new) + `LogViewer.tsx` | 1 d |
| 0.4 | Replace foreign favicon with real Blok mark; ship Newsreader font | `apps/studio/public/favicon.svg` + `index.html` | 0.5 d |
| 0.5 | Migrate brand-spec tokens into `app.css @theme` (no breaking changes) | `apps/studio/src/app.css` | 0.5 d |

### Phase 1 · Run-detail 3-pane redesign (4 days)

The single highest-value screen.

| # | Task | Effort |
|---|---|---|
| 1.1 | New `RunDetailLayout.tsx` shell with 3-pane CSS Grid (240/fluid/320) | 0.5 d |
| 1.2 | `StepRail.tsx` — virtualized vertical list (handles 500-step runs) with status dots, j/k/1–9 nav | 1 d |
| 1.3 | `ActiveStepPanel.tsx` — header + collapsible Inputs/Outputs/Logs/Position, ⌥1–⌥5 mode switch | 1 d |
| 1.4 | `Inspector.tsx` — dense metrics column with live log tail | 0.5 d |
| 1.5 | New error frame (reuses BlokErrorDetail bones, new layout when error is page topic) | 0.5 d |
| 1.6 | Migrate keyboard shortcuts; full a11y pass (focus rings, aria-live, Esc semantics) | 0.5 d |

### Phase 2 · Environment as first-class (3 days)

| # | Task | Effort |
|---|---|---|
| 2.1 | Add `environment` field to `WorkflowRun` type + persist (default `"production"`) | 0.5 d |
| 2.2 | `EnvSwitcher.tsx` in shell header (top-left, next to logo) | 0.5 d |
| 2.3 | `useEnvScope` Zustand slice + thread `?env=` query param into every list endpoint | 1 d |
| 2.4 | Update sidebar / runs / dashboard / metrics to filter by current env | 1 d |

### Phase 3 · Cross-run Logs page (3 days)

| # | Task | Effort |
|---|---|---|
| 3.1 | Backend: `/__blok/logs?env=&q=&level=&workflow=&since=` paginated + SSE multiplex | 1 d |
| 3.2 | `routes/logs.tsx` — virtualized log table + live tail toggle + click-to-jump-run | 1 d |
| 3.3 | Search bar with token chips (level: error, workflow: order-process), debounced 200ms | 1 d |

### Phase 4 · Bulk actions + advanced filter (2 days)

| # | Task | Effort |
|---|---|---|
| 4.1 | RunsTable: re-enable checkbox column for multi-select; floating action toolbar (replay, cancel, delete, tag, export) | 1 d |
| 4.2 | Advanced filter dropdown — status, tags, env, time-range, duration-range, has-error chips | 1 d |

### Phase 5 · Queues + Deployments (4 days)

| # | Task | Effort |
|---|---|---|
| 5.1 | Backend: `/queues` and `/deployments` endpoints (read NATS JetStream + workflow registry) | 1.5 d |
| 5.2 | `routes/queues.tsx` with depth-per-trigger, scheduled-next-fire | 1 d |
| 5.3 | `routes/deployments.tsx` with version list, runs-per-version, rollback CTA | 1.5 d |

### Phase 6 · Empty states + onboarding (1.5 days)

For every primary page, write a real empty state that teaches:

```
No runs yet.

Trigger one with:

  curl -X POST http://localhost:4000/your-workflow -d '{}'

or via the SDK:

  await blok.run("your-workflow", { input: {…} })
```

Real CLI commands. Real shapes. No mascot. Includes a "copy" button on the snippet, a "view docs" link, and (when applicable) a "use sample workflow" button that posts a known-good payload.

### Phase 7 · Visual polish + motion (1.5 days)

| # | Task | Effort |
|---|---|---|
| 7.1 | Apply 4-step neutral surface ladder across all pages | 0.5 d |
| 7.2 | Status flip animation on SSE state change (cubic-bezier 320 ms) | 0.5 d |
| 7.3 | Live-feed brand pulse on dashboard | 0.5 d |

**Total: ~22 eng-days · 4–5 weeks if it's anyone's only job, 8–10 if shared.**

---

## 6 · Component map (what exists → what's added)

| Today | Status | Tomorrow |
|---|---|---|
| `routes/__root.tsx` | keep | + EnvSwitcher mount |
| `routes/index.tsx` (Dashboard) | refactor | + brand-pulse live feed, real empty state, env-scoped stats |
| `routes/runs.tsx` | refactor | + bulk-action toolbar, advanced filter, env scope |
| `routes/runs.$runId.tsx` | **rebuild** | 3-pane shell, ⌥-mode switching |
| `routes/runs.diff.tsx` | keep | + metrics diff column |
| `routes/workflows.$name.tsx` | small refactor | + triggers tab, version chip on runs |
| `routes/metrics.tsx` | small refactor | + env scope, tile relayout |
| `routes/dashboards.tsx` | keep | + better empty state |
| `routes/webhooks.tsx` | rename → `routes/alerts.tsx` | + email/slack alert channel UI |
| — | **new** | `routes/logs.tsx` |
| — | **new** | `routes/queues.tsx` |
| — | **new** | `routes/deployments.tsx` |
| `components/trace/NodeDetail.tsx` | split | → `Inspector.tsx` (right pane) + `ActiveStepPanel.tsx` (center pane) + `BlokErrorFrame.tsx` (page topic when error) |
| `components/trace/TraceTimeline.tsx` | replace | → `StepRail.tsx` (vertical, virtualized) |
| `components/trace/TraceGraph.tsx` | keep | becomes ⌥2 mode of run-detail center pane |
| `components/trace/LogViewer.tsx` | rewire | consume SSE log multiplex |
| `components/trace/EventLog.tsx` | merge into LogViewer | retire as separate tab |
| `components/runs/RunsTable.tsx` | refactor | bulk select + new column set |
| `components/layout/Sidebar.tsx` | refactor | search-within-workflows, collapsed mark variant |
| `components/layout/StatusBar.tsx` | keep | + env name pill on left |
| — | **new** | `components/shell/EnvSwitcher.tsx`, `components/shell/CommandBar.tsx` (extends Cmd+K with global actions: replay last run, etc.) |
| — | **new** | `components/runs/AdvancedFilter.tsx`, `BulkActionToolbar.tsx` |
| — | **new** | `components/logs/LogsTable.tsx`, `LogSearchBar.tsx`, `LiveTailToggle.tsx` |
| — | **new** | `components/queues/QueueDepthChart.tsx`, `WaitpointList.tsx` |
| — | **new** | `components/deployments/VersionList.tsx`, `RollbackButton.tsx` |

---

## 7 · Keyboard map (the operator's contract)

The keyboard layer is the cheapest way to feel "operator-grade." The full map below is the contract — every shortcut here gets a tooltip, an in-app cheat sheet (`?` to open), and a published table in `apps/studio/CLAUDE.md`.

### Global

| Key | Action |
|---|---|
| `⌘K` | command palette (extends today: + replay last run, + go to env, + jump to deployment) |
| `?` | keyboard cheat sheet overlay |
| `g r` | go to runs |
| `g d` | go to dashboards |
| `g l` | go to logs |
| `g m` | go to metrics |
| `g q` | go to queues |
| `g v` | go to deployments (versions) |
| `e` | open env switcher |

### Run-list

| Key | Action |
|---|---|
| `j / k` | next / prev row |
| `o` or `Enter` | open run |
| `x` | toggle row selection |
| `r` | replay selected (or current) |
| `c` | cancel selected (with confirm) |
| `t` | edit tags |
| `/` | focus search |

### Run-detail

| Key | Action |
|---|---|
| `j / k` | next / prev step (left rail) |
| `1`–`9` | jump to step N |
| `⌥1` | active-step mode (default) |
| `⌥2` | trace graph mode |
| `⌥3` | full-width logs mode |
| `⌥4` | events mode |
| `⌥5` | request-builder / replay mode |
| `Esc` | back to active-step mode |
| `[` / `]` | prev / next run (chronological in same workflow) |
| `r` | replay this run |
| `y` | copy run-id |

---

## 8 · Risks + open questions

1. **Newsreader serif on dashboard headlines is one concession to Direction C.** If you want pure Direction A (no serif at all), strip Newsreader from the spec — the rest holds.
2. **Environment as first-class** requires a small backend migration: the `WorkflowRun` schema gets an `environment` column. Default `"production"` for existing rows is safe; future rows take it from `BLOK_ENV` env var or trigger config. Want me to spec the migration in detail?
3. **TRQL / advanced filter** — trigger.dev's TRQL is a SQL-like ClickHouse query language. We don't have ClickHouse and probably shouldn't introduce it. The proposed "advanced filter chips" (Phase 4.2) is the JSON-friendly equivalent and 95% as useful for typical filter needs. If query-language parity is a hard requirement, that's an additional 5–8 days for a custom mini-DSL on the existing SQLite/Postgres store.
4. **Run-detail 3-pane on smaller screens** (≤ 1280 px) needs to collapse to 2-pane (rail + center, inspector becomes drawer). Spec'd that as a media query in the prototype — confirm OK.
5. **Metrics bug fix (Phase 0.1)** I described the fix shape but didn't apply it during the verification pass. Want me to apply it as a separate commit before any UI work, so we can verify wire-byte numbers actually flow?

---

## 9 · What this plan deliberately doesn't try to do

- **No workflow authoring UI.** Studio stays read-only for trace observability. Authoring lives in code (TS workflows in `triggers/http/src/workflows/`) per `CLAUDE.md` policy.
- **No AI-generated dashboards** like trigger.dev's "describe what you want, AI generates a chart." Cool, not load-bearing, can ship later.
- **No bundled OpenTelemetry exporter UI.** Trigger.dev's whole observability story is OTEL-native; ours is its own protocol. We can make our trace viewer just as good without OTEL parity.
- **No multi-tenant org/project picker.** Blok is single-tenant per deployment today. Don't introduce multi-tenancy chrome until the runtime supports it.

---

## 10 · Next two moves

1. Look at `run-detail-v2.html` (companion file) — the run-detail 3-pane layout in real Blok colors with real run data shape. Feedback on layout, density, hierarchy lands here.
2. After Phase 0 fixes (the three bugs), I'd start Phase 1 (run-detail rebuild) — that's the single screen that earns the most respect per day of work.

If the plan feels right, the next thing I'd build is the `routes/logs.tsx` hi-fi (Phase 3) — that's the screen that doesn't exist today and is the hardest to design well. Run-detail v2 mostly *re-arranges* what's there; logs page is greenfield.
