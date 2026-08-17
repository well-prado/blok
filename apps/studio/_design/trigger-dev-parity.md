# Blok Studio · Trigger.dev Parity Analysis

> Captured: 2026-08-10
> Method: read both codebases through the Tetrix MCP index
> (`github:triggerdotdev/trigger.dev` @ `main`, 4,921 files / 38,899 symbols,
> re-indexed 2026-08-10; `github:well-prado/blok` re-indexed 2026-08-10),
> cross-checked against local `apps/studio` source and `_design/_screenshots/`.
>
> Successor to `design-plan.md` (Direction A · Linear-grade Operator). That plan
> got Studio to a competent operator console. This one measures Studio against
> the app the founder wants to beat, and enumerates what is missing.

## 1 · The scoreboard

| Dimension | Blok Studio | trigger.dev webapp |
|---|---|---|
| Source files (frontend) | 137 (`apps/studio/src`) | ~1,400 (`apps/webapp/app`) |
| Lines (frontend) | 26,408 | ~250k |
| Route files | 13 | 505 (106 in the authed product) |
| Design-system primitives | 14 (`components/shared/`) | 107 (`components/primitives/`) |
| Design-system catalog | none | 51 storybook routes |
| Chart layer | 4 ad-hoc Recharts components | 23-file compound chart system |
| Filter system | 4-button status segmented control | 1,108-line shared filter engine + 9 per-screen filter sets |
| Keyboard system | `CommandPalette` (⌘K) | shortcut registry, provider, OS-aware `ShortcutKey`, global + per-view maps |
| Animation primitives | status pulse | 8 dedicated motion primitives |
| Theme | dark only | light / dark / system + locale + timezone + OS providers |

The headline is not "Studio is bad" — the Direction A pass produced a clean,
coherent console. The headline is **surface area and depth**: trigger.dev has
built a design system, Studio has built screens. Every quality gap below traces
back to that one difference.

## 2 · Screen-by-screen

Legend: ✅ Studio has it at comparable depth · 🟡 Studio has a thinner version ·
❌ Studio has nothing.

| Area | Studio | trigger.dev reference | State |
|---|---|---|---|
| Runs list | `routes/runs/index.tsx`, `RunsTable`, `RunFilters` | `_app…runs._index/route.tsx`, `TaskRunsTable`, `RunFilters`, `useRunsLiveReload`, `ListPagination`, `BulkAction` | 🟡 |
| Run detail / trace | `routes/runs/$runId.tsx`, `TraceGraph`, `TraceTimeline`, `StepRail`, `Inspector`, `ActiveStepPanel`, `BlokErrorFrame` | `runs.$runParam/route.tsx`, `SpanHorizontalTimeline`, `RunTimeline`, `primitives/Timeline`, `TreeView/`, `SpanEvents`, `PacketDisplay`, `Resizable` | 🟡 |
| Logs | `routes/logs.tsx`, `LogViewer` | `logs/LogsTable`, `LogDetailView`, `LogLevel`, 4 filter components, `useAutoScrollToBottom` | 🟡 |
| Metrics / dashboards | `routes/metrics.tsx`, `routes/dashboards.tsx`, `DashboardGrid`, 4 chart components | `dashboards.*` routes, `primitives/charts/` (23 files), `metrics/` (12) | 🟡 |
| Queues | `routes/queues.tsx`, `ConcurrencyTile` | `queues/route.tsx`, `queues_.$queueParam`, `concurrency/route.tsx` | 🟡 |
| Deployments | `routes/deployments.tsx` | `deployments/route.tsx`, `$deploymentParam`, `DeploymentStatus`, `DeploymentError` | 🟡 |
| Schedules | `routes/scheduled.tsx` | `schedules._index` / `.new` / `.edit.$` / `.$scheduleParam`, `ScheduleType`, `EnabledStatus` | 🟡 |
| Webhooks | `routes/webhooks.tsx` | (no direct equivalent — Blok-specific) | ✅ |
| Workflow canvas editor | `components/trace/WorkflowGraph` + 10 node editors | (none — trigger.dev is code-only) | ✅ **Blok's moat** |
| Settings | `routes/settings.tsx` | `settings.general`, `settings.integrations` | 🟡 |
| Environment variables | — | `environment-variables/route.tsx` + `.new` | ❌ |
| API keys | — | `apikeys/route.tsx` | ❌ |
| Test a task/workflow | `RequestBuilder` (inside canvas) | `test/route.tsx`, `test.tasks.$taskParam/` + schema & payload tabs | ❌ |
| Alerts | — | `alerts/route.tsx`, `alerts.new/`, `connect-to-slack` | ❌ |
| Errors (grouped) | `BlokErrorDetail`, `ExplainError` | `errors._index`, `errors.$fingerprint`, `ErrorStatusBadge`, `ErrorStatusMenu` | ❌ |
| Bulk actions | `BulkActionToolbar` | `bulk-actions/`, `$bulkActionParam`, `BulkAction`, `AbortBulkActionDialog` | 🟡 |
| Batches | — | `batches/`, `$batchParam`, `BatchFilters`, `BatchStatus` | ❌ |
| Waitpoints | — | `waitpoints.tokens/`, `$waitpointParam`, `WaitpointDetails` | ❌ |

Deliberately **out of scope** (SaaS-shaped, per founder call): org/team, roles,
SSO, billing, billing limits/alerts, usage, invites, private connections. Also
out of scope for now: the AI-native surfaces trigger.dev shipped on `main`
(Agents, Playground, Prompts, Models + compare, Sessions, TRQL query editor,
dashboard-builder agent) — noted here because that is where Blok could
leapfrog rather than copy.

## 3 · The cross-cutting quality gaps

These are the real reasons Studio "isn't as good", independent of any screen.

1. **No design system.** 14 ad-hoc components vs 107 primitives. Every new
   Studio screen re-invents spacing, states and affordances. trigger.dev's 51
   storybook routes are both the catalog and the regression surface.
2. **No filter engine.** Studio ships one segmented status control.
   trigger.dev's `SharedFilters.tsx` is a combobox-driven, keyboard-navigable,
   URL-synced filter system with applied-filter chips, relative time presets
   (1m→30d) and custom absolute ranges — reused across 9 screens.
3. **No table system.** `primitives/Table.tsx` is 651 lines: variants, sticky
   headers, sort, row hover/focus, row-action popovers, cell truncation with
   copy, blank rows. Studio's `RunsTable` is a plain table.
4. **No keyboard contract.** Studio has ⌘K. trigger.dev has a shortcut
   registry, an OS-aware `ShortcutKey` renderer that prints the binding on the
   button itself, global + per-view maps, and a shortcuts help surface.
5. **No motion language.** trigger.dev ships `AnimatingArrow`, `AnimatedNumber`,
   `AnimatedCallout`, `PulsingDot`, `LoadingBarDivider`, `Spinner`,
   `TriggerRotatingLogo`, `AgentDotMatrix`. Studio has a status pulse.
6. **No chart layer.** trigger.dev's `primitives/charts/` has zoom-to-select,
   cross-chart sync, shared date-range context, loading and blank states.
7. **Thin empty states.** One generic `EmptyState` vs `BlankStatePanels` +
   `SetupCommands` + `StepNumber` — panels that teach the next action.
8. **Flat navigation.** One static sidebar vs sectioned menu + favorites +
   user-reorderable nav + environment selector + notification panel.
9. **Dark-only.** No light theme, no system sync, no timezone/locale providers.

## 4 · What Studio must not lose

The visual workflow editor (`components/trace/WorkflowGraph.tsx` + the branch /
switch / forEach / tryCatch / wait / subworkflow / trigger editors) has no
trigger.dev counterpart. Parity work must not regress it — and the design
system should be built to serve it, not around it.

## 5 · Board

Tracked on GitHub Project **BLOK Studio Improvement Design**: 16 epics, each
with task issues naming the trigger.dev reference file to study.
