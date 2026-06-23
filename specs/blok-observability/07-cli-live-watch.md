# OBS-07 — `blokctl watch`: terminal live execution view

> **Status:** PROPOSED · **Phase:** 1 (build-new, small) · **Effort:** ~1.5 eng-days · **Depends on:** none (consumes the existing `/__blok/stream` SSE; benefits from OBS-04 A2's wider event coverage)

## TL;DR

Bring back a first-class **terminal** live-watch. Today the step-by-step "watch a workflow execute" view is **browser-only** (Blok Studio via `blokctl trace`); the terminal `blokctl monitor` is an *aggregate* Prometheus dashboard, not a live execution view. `blokctl watch` streams the already-existing `/__blok/stream` SSE and renders run/step lifecycle events live in the terminal — local or against a remote (k8s) deployment. No new server surface; pure CLI consumer.

## Problem / current state

| File | Line(s) | What's there today |
|---|---|---|
| `core/runner/src/tracing/TraceRouter.ts` | 1779–1810 | `GET /stream` — a global SSE event stream (`?workflows=a,b` filter) already exists and emits every run/node lifecycle event. **No CLI consumes it.** |
| `core/runner/src/tracing/TraceRouter.ts` | 1812–1816 | `writeSSE` frame format: `event: <TYPE>\nid: <id>\ndata: <RunEvent JSON>` |
| `core/runner/src/tracing/types.ts` | 655–663 | `RunEvent = { id, type, runId, workflowName, timestamp, nodeName?, nodeId?, payload? }` |
| `packages/cli/src/commands/monitor/monitor-component.tsx` | 451–466 | `blokctl monitor` is an ink TUI that **polls Prometheus every 3s** for aggregates — not a live execution view |
| `packages/cli/src/commands/trace/index.ts` | 7–17 | `blokctl trace` opens **Blok Studio in the browser** — the only step-by-step live view today |

So the "watch it execute, in the terminal" experience that existed in spirit in v1 has no terminal home. The data and the stream are right there; only the consumer is missing.

## Goal & acceptance criteria

- `blokctl watch` connects to `<url>/__blok/stream` and prints a colored line per run/step lifecycle transition, live, until `Ctrl-C`.
- Renders: run started; node completed (with ms); node failed / attempt-failed (with error message + code); node cached; run completed/failed/crashed/timedOut/cancelled/throttled (with ms + error).
- `--workflow a,b` filters to specific workflows (passes through to the server's `?workflows=` filter).
- `--url` targets any deployment (local default `http://localhost:4000`; a remote k8s pod works); `--token` authenticates against the production trace-auth gate.
- `--verbose` additionally shows node-started / skipped / scheduling (delayed/queued/debounced) events; `--no-color` disables ANSI (pipe-friendly).
- Pure, unit-tested core: `formatEvent(event)` (RunEvent → line) and `parseSseBuffer(text)` (SSE wire → events) are deterministic and tested.
- Graceful errors: a clear message when the server is unreachable or returns 503 (production without `--token`).

## Design / proposed changes

New command module `packages/cli/src/commands/watch/`:

- **`format.ts`** — `formatEvent(ev, { color, verbose }): string | null`. Pure map from a `WatchRunEvent` to one colored terminal line (or `null` to skip noisy events — `LOG_ENTRY`, `VARS_UPDATED`, `NODE_PROGRESS`, heartbeats). Reads `payload.durationMs` and `payload.error.{message,code}` (the real shapes emitted by `RunTracker.emitEvent`). Colors via `picocolors`' `createColors(enabled)` so output is deterministic in tests.
- **`sse.ts`** — `parseSseBuffer(buffer): { events, rest }` (pure SSE frame parser; tolerates `:heartbeat` comments, `connected`/`stream-end` control frames, and partial trailing frames) + `connectEventStream(baseUrl, { token, workflows, signal }, handlers)` using streaming `fetch` (`res.body.getReader()`) — no new dependency (Node/undici `fetch` streams the body).
- **`index.ts`** — registers `program.command("watch")` with `--url`, `--token`, `--workflow`, `--verbose`, `--no-color`; wires SSE → `formatEvent` → stdout; installs SIGINT/SIGTERM handlers; falls back to `tokenManager.getToken()` for the token.
- **`packages/cli/src/index.ts`** — add `import "./commands/watch/index.js";` (side-effect registration, matching every other command).

Auth: `--token` → `Authorization: Bearer <token>` header, consumed by the operator's `setTraceAuth` hook. Reuses the existing trace-auth gate; no new auth surface.

## Tasks (SDD breakdown)

**T1. `format.ts` — pure event→line formatter**
- File: `packages/cli/src/commands/watch/format.ts`
- Acceptance: `formatEvent({type:"NODE_FAILED",nodeName:"charge",payload:{error:{message:"insufficient_funds",code:402},durationMs:5}}, {color:false})` contains `✗`, `charge`, `402`, `insufficient_funds`. Skipped types return `null`.
- Effort: 0.5 day

**T2. `sse.ts` — SSE parser + streaming connector**
- File: `packages/cli/src/commands/watch/sse.ts`
- Acceptance: `parseSseBuffer` of a buffer with a `:heartbeat`, a `connected` control frame, one real `NODE_COMPLETED` frame, and a partial trailing frame returns exactly the one event and leaves the partial in `rest`.
- Effort: 0.5 day

**T3. `index.ts` — the command + registration**
- Files: `packages/cli/src/commands/watch/index.ts`, `packages/cli/src/index.ts`
- Acceptance: `blokctl watch --help` lists the command + options; against a running dev server, a workflow run prints live lines; `Ctrl-C` exits cleanly.
- Effort: 0.5 day

**T4. Tests**
- Files: `packages/cli/tests/commands/watch/format.test.ts`, `packages/cli/tests/commands/watch/sse.test.ts`
- Effort: bundled into T1/T2.

## Tests

Unit: `formatEvent` across all rendered event types (+ skipped → null, + `--no-color` determinism); `parseSseBuffer` framing (heartbeats, control frames, partial frames, malformed JSON tolerated). End-to-end (manual): `blokctl dev` in one shell, `blokctl watch` in another, trigger a workflow, confirm live lines incl. a failing step.

## Back-compat, kill-switches & defaults

Purely additive — a new command, new files, no change to existing behavior. Default `--url http://localhost:4000`. No env vars. `--no-color` honored (also respects `NO_COLOR` via picocolors).

## Risks & open questions

- Long-running command: mirror `blokctl monitor`'s daemon pattern (kick off the stream, keep the process alive on the pending socket; exit on SIGINT). Confirm `trackCommandExecution` tolerates a non-resolving execution (monitor already does).
- Reconnect: v1 prints a clear error + exits on disconnect; auto-reconnect-with-backoff is a follow-up (the server already advertises `retry: 3000`).

## Out of scope / follow-ups

- An in-place updating TUI (ink) that redraws active runs with spinners (the richer mock) — a follow-up `--tui` mode; the streaming tail ships first.
- Auto-reconnect with backoff.
- `blokctl trace --tail` as an alias once `watch` is proven.
