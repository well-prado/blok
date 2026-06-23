# OBS-04 — Trace store durability & real-time Studio completeness

> **Status:** PROPOSED · **Phase:** mixed (1 wire-what-exists + 2 build-new) · **Effort:** 7.5 eng-days · **Depends on:** none (standalone); complements OBS-01..OBS-03 and OBS-05..OBS-06

---

## TL;DR

Three gaps prevent Blok from being a trustworthy observability plane in production. First, the default trace store is in-memory: raw containers that omit `BLOK_TRACE_STORE` lose every run record on restart or pod eviction, and multi-replica deployments fragment traces across pods with no cross-pod visibility. Second, Blok Studio's per-run SSE stream subscribes to only 9 of the framework's 20+ event types — `RUN_CRASHED`, `RUN_TIMED_OUT`, `RUN_CANCELLED`, `NODE_CACHED`, `NODE_ATTEMPT_FAILED`, `RUN_THROTTLED`, `RUN_DELAYED`, `RUN_EXPIRED`, `RUN_DEBOUNCED`, and `RUN_QUEUED` are all emitted server-side but never delivered to the browser — and the stream never closes on these terminal states, leaving Studio clients polling indefinitely after a crash or cancellation. Third, the global SSE stream (`/__blok/stream`) is single-pod: in a k8s deployment with N replicas, a Studio client only sees runs on the pod it happens to hit. This epic fixes the first two gaps and specifies the third as a well-scoped follow-on.

---

## Problem / current state

### A3 — Memory default causes silent trace loss

| File | Line(s) | What's there today |
|---|---|---|
| `core/runner/src/tracing/createStore.ts` | 38 | `const type = opts?.type \|\| (process.env.BLOK_TRACE_STORE as StoreType) \|\| "memory"` — hard-coded "memory" fallback |
| `scripts/dev-full.ts` | 591 | `BLOK_TRACE_STORE: process.env.BLOK_TRACE_STORE \|\| "sqlite"` — dev-full overrides to sqlite, but this only runs via `blokctl dev` |
| `infra/docker-compose.production.yml` | 39-44 | `BLOK_TRACE_STORE` is present only as a **comment** — the actual `environment:` block never sets it, so a raw `docker compose up` gets memory |
| `infra/helm/blok/templates/configmap.yaml` | 8 | Iterates `Values.env` — no `BLOK_TRACE_STORE` in `values.yaml` and no postgres dependency declared anywhere in the chart |
| `infra/docker-compose.production.yml` | 40-43 | Comment acknowledges the idempotency cache and durable scheduler share the trace store, so memory-mode silently disables cross-restart dedup and scheduler durability too |

A process launched with a plain `docker run` image, a raw `docker compose up` against the production compose file, or a `helm install` with default values will silently discard all trace data, idempotency cache entries, and durable scheduler rows on restart or pod eviction — with no warning at boot. The idempotency and debounce backends share the same store (`RunTracker` → `createStore`), so a money-moving Pix transaction retried after a pod eviction would execute twice with no duplicate guard.

### A2 — Studio live view misses 10 event types and never closes on terminal failure states

**SSE subscription gap — `apps/studio/src/lib/sse.ts:40-50`:**

```typescript
const EVENT_TYPES = [
    "RUN_STARTED",
    "RUN_COMPLETED",
    "RUN_FAILED",
    "NODE_STARTED",
    "NODE_COMPLETED",
    "NODE_FAILED",
    "NODE_SKIPPED",
    "VARS_UPDATED",
    "LOG_ENTRY",
] as const;
```

This is a static `addEventListener` list. The browser SSE client only registers listeners for these 9 event types; events with any other `event:` field are silently dropped by `EventSource`. The server emits all of the following but Studio never receives them live:

| Missing event | Emitted at | Status it signals |
|---|---|---|
| `RUN_CRASHED` | `RunTracker.ts:468` | terminal — run crashed |
| `RUN_TIMED_OUT` | `RunTracker.ts:552` | terminal — step timeout exhausted |
| `RUN_CANCELLED` | `RunTracker.ts:622` | terminal — operator cancelled |
| `RUN_THROTTLED` | `RunTracker.ts:277` | terminal — concurrency gate denied |
| `RUN_EXPIRED` | `RunTracker.ts:388` | terminal — TTL exceeded |
| `RUN_DEBOUNCED` | `RunTracker.ts:434` | terminal — coalesced |
| `RUN_QUEUED` | `RunTracker.ts:324` | transient → running |
| `RUN_DELAYED` | `RunTracker.ts:358` | transient → running |
| `NODE_CACHED` | `RunTracker.ts:863` | node short-circuited via idempotency cache |
| `NODE_ATTEMPT_FAILED` | `RunTracker.ts:887` | retry attempt failed |

The type system already knows all 20 event types — `apps/studio/src/types.ts:229-274` declares the full `RunEventType` union and `apps/studio/src/lib/constants.ts:71-104` has labels and color mappings for every missing event. The client-side `useRunDetail.ts` switch statement already handles `NODE_PROGRESS` and `NODE_PARTIAL_RESULT` (which are in `EVENT_TYPES` via a gap in the list at line 50 — actually those two ARE present in the current switch but NOT in `EVENT_TYPES`, so they can never fire from the real server either). This means the Studio UI is built and ready to display these events; it simply never receives them.

**Per-run stream never closes on terminal failure states — `core/runner/src/tracing/TraceRouter.ts:1742-1758`:**

```typescript
// If run already finished, close stream
if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
    res.write('event: stream-end\ndata: {"reason":"run_finished"}\n\n');
    res.end();
    return;
}

// Stream live events
const onEvent = (event: RunEvent) => {
    if (event.runId !== runId) return;
    writeSSE(res, event);

    // Auto-close when run finishes
    if (event.type === "RUN_COMPLETED" || event.type === "RUN_FAILED") {
        res.write('event: stream-end\ndata: {"reason":"run_finished"}\n\n');
        res.end();
    }
};
```

Two problems here:

1. The **initial terminal-state check** (line 1743) tests only `completed | failed | cancelled`. If Studio connects to the stream for a run that already reached `crashed`, `timedOut`, `throttled`, or `expired`, the endpoint does NOT close the stream — it streams live events indefinitely (or until the heartbeat loop is interrupted by client disconnect). The run will never emit another event since it is already terminal, so Studio shows a perpetually "connecting" or "live" indicator.

2. The **live auto-close** (line 1755) fires only on `RUN_COMPLETED` or `RUN_FAILED`. A `RUN_CRASHED` or `RUN_TIMED_OUT` or `RUN_CANCELLED` event is forwarded to the browser (once the subscription gap is fixed), but the stream is never closed — Studio's `useTraceStream` hook never calls `onEnd`, so `queryClient.invalidateQueries` is never called and the run detail panel never refreshes to its final state.

**`useRunDetail.ts` switch statement** (lines 47-185) has no `case` for any of the 10 missing event types. The types exist in `RunEventType`; the switch just falls through to the default (no-op).

**`useGlobalStream.ts`** (lines 66-88): notifications are emitted only for `RUN_COMPLETED` and `RUN_FAILED` — a crashed or timed-out run produces no toast.

### B8 — Multi-replica SSE bus (architectural follow-on)

`TraceRouter.ts:1793-1799`:

```typescript
const onEvent = (event: RunEvent) => {
    if (workflowFilter && !workflowFilter.includes(event.workflowName)) return;
    writeSSE(res, event);
};
t.on("event", onEvent);
```

`RunTracker` is an `EventEmitter` (`core/runner/src/tracing/RunTracker.ts`). Events are emitted in-process only — there is no broker fan-out. In a k8s deployment with 3 replicas, a Studio client connected to pod-0 receives only runs that executed on pod-0. Runs on pod-1 and pod-2 are invisible. The fix requires a cross-process pub/sub bus (Redis pub/sub or NATS core messaging) emitting to all replicas whenever `RunTracker.emitEvent` fires, and each replica's `TraceRouter` subscribing to deliver those events to connected SSE clients. This mirrors the existing `BLOK_CONCURRENCY_BACKEND` / `BLOK_DEBOUNCE_BACKEND` pattern (`createConcurrencyBackend` in `core/runner/src/concurrency/`). Flagged separately because it is the largest architectural lift in this epic; it can and should ship as its own follow-up.

---

## Goal & acceptance criteria

### A3 — Trace store durability

- [ ] `BLOK_TRACE_STORE` defaults to `"sqlite"` (not `"memory"`) in `createStore.ts`. A raw `docker run` or `helm install` without env vars produces a SQLite store.
- [ ] A boot-time warning (via `console.warn`) is emitted whenever `BLOK_TRACE_STORE=memory` (or `InMemoryRunStore`) is in use in a context where `NODE_ENV !== "test"`. The warning explicitly calls out that idempotency cache and durable scheduler are also disabled.
- [ ] `infra/docker-compose.production.yml` ships a `postgres` service (named `blok-postgres`) and the `blok` service has `BLOK_TRACE_STORE: postgres` and `BLOK_TRACE_DATABASE_URL` set explicitly.
- [ ] The Helm chart `values.yaml` gains a `traceStore` section (`backend: sqlite | postgres | memory`, `sqlite.path`, `postgres.url`, `postgres.poolSize`). The `configmap.yaml` template renders `BLOK_TRACE_STORE` and, when postgres, `BLOK_TRACE_DATABASE_URL` from these values. Default remains `sqlite` for single-replica; docs recommend `postgres` for `replicaCount > 1`.
- [ ] `SqliteRunStore` emits a one-time warn log when instantiated with `readOnlyRootFilesystem: true`-equivalent conditions (i.e. the `.blok/` directory cannot be created), rather than throwing an unhandled error.
- [ ] End-to-end check: spin up two `blok` containers sharing one Postgres service, run a workflow on container A, and `GET /__blok/runs` on container B returns the run.

### A2 — Studio SSE completeness

- [ ] `apps/studio/src/lib/sse.ts` `EVENT_TYPES` includes all 20 event types emitted by `RunTracker` — specifically the 10 currently missing: `RUN_CRASHED`, `RUN_TIMED_OUT`, `RUN_CANCELLED`, `RUN_THROTTLED`, `RUN_EXPIRED`, `RUN_DEBOUNCED`, `RUN_QUEUED`, `RUN_DELAYED`, `NODE_CACHED`, `NODE_ATTEMPT_FAILED`. The SSE connection handler uses the full list, not a hand-curated subset.
- [ ] `core/runner/src/tracing/TraceRouter.ts` per-run stream initial terminal check covers all 7 terminal statuses (`completed | failed | cancelled | crashed | timedOut | throttled | expired | debounced`). Connecting to a stream for an already-terminated run always results in immediate `stream-end` + close.
- [ ] Per-run stream auto-close fires on all terminal run events: `RUN_COMPLETED`, `RUN_FAILED`, `RUN_CRASHED`, `RUN_TIMED_OUT`, `RUN_CANCELLED`, `RUN_THROTTLED`, `RUN_EXPIRED`, `RUN_DEBOUNCED`. The heartbeat loop and listener are cleaned up.
- [ ] `useRunDetail.ts` switch statement handles `RUN_CRASHED` and `RUN_TIMED_OUT` by updating `run.status` to `"crashed"` / `"timedOut"` and setting `run.finishedAt` from `event.timestamp`. `NODE_CACHED` marks the node `status: "cached"`. `NODE_ATTEMPT_FAILED` appends to a `node.attempts[]` list (or increments `node.failedAttempts`). `RUN_CANCELLED` is already handled via the existing `completed/failed` path but needs an explicit `status: "cancelled"` update.
- [ ] `useGlobalStream.ts` emits browser notifications for `RUN_CRASHED` (error toast) and `RUN_TIMED_OUT` (warning toast) in addition to the existing `RUN_COMPLETED` and `RUN_FAILED`.
- [ ] Studio Vitest suite: 6 new tests (one per missing terminal event) assert that connecting to a run stream after the terminal event fires results in `stream-end` being called and `queryClient.invalidateQueries` being triggered.

---

## Design / proposed changes

### A3-D1: Change the default store to sqlite

**File:** `core/runner/src/tracing/createStore.ts:38`

Current:
```typescript
const type = opts?.type || (process.env.BLOK_TRACE_STORE as StoreType) || "memory";
```

New:
```typescript
const isTest = process.env.NODE_ENV === "test" || process.env.VITEST === "true";
const defaultStore: StoreType = isTest ? "memory" : "sqlite";
const type = opts?.type || (process.env.BLOK_TRACE_STORE as StoreType) || defaultStore;
```

Back-compat: existing callers that pass `opts.type` are unaffected. Tests that rely on in-memory speed are unaffected (they run under `NODE_ENV=test`). Any explicit `BLOK_TRACE_STORE=memory` still works. Operators who relied on implicit memory must set `BLOK_TRACE_STORE=memory` explicitly.

**Kill-switch:** `BLOK_TRACE_STORE=memory` (explicit opt-in). `BLOK_TRACE_STORE` is already documented; this is a default change only.

**BREAKING (release-note required):** Containers that relied on the implicit memory default will now try to open `.blok/trace.db`. If the directory is not writable, the process will throw. Mitigation: the sqlite case already calls `fs.mkdirSync(dir, { recursive: true })` (line 89 of `createStore.ts`), so writable-root containers are unaffected. Read-only root filesystems (k8s `readOnlyRootFilesystem: true`, as in `values.yaml:217`) require either a writable volume mount for `.blok/` or `BLOK_TRACE_STORE=postgres`. The Helm chart update in A3-D3 handles this.

### A3-D2: Boot warning when memory store is active outside tests

**File:** `core/runner/src/tracing/createStore.ts` — add after the `switch` statement, before `return store`:

```typescript
if (type === "memory" && !isTest) {
    console.warn(
        "[blok][trace-store] Running with in-memory trace store — run records, idempotency cache, " +
        "and scheduled dispatches are NOT persisted and will be lost on restart. " +
        "Set BLOK_TRACE_STORE=sqlite (single-process) or BLOK_TRACE_STORE=postgres (multi-replica) " +
        "before deploying to production."
    );
}
```

No kill-switch; it is a one-line warn, not a gate.

### A3-D3: Ship Postgres in production compose and Helm

**File: `infra/docker-compose.production.yml`**

Add a `postgres` service (under the existing services block, before `redis`):

```yaml
postgres:
  image: postgres:16-alpine
  environment:
    POSTGRES_DB: blok
    POSTGRES_USER: blok
    POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-blok_prod}
  volumes:
    - postgres-data:/var/lib/postgresql/data
  healthcheck:
    test: ["CMD-SHELL", "pg_isready -U blok -d blok"]
    interval: 5s
    timeout: 3s
    retries: 10
  deploy:
    resources:
      limits:
        cpus: "1.0"
        memory: 512M
  networks:
    - blok-net
```

In the `blok` service `environment:` block, uncomment and set:

```yaml
BLOK_TRACE_STORE: postgres
BLOK_TRACE_DATABASE_URL: postgres://blok:${POSTGRES_PASSWORD:-blok_prod}@postgres:5432/blok
BLOK_TRACE_PG_SSL: "false"
```

Add `postgres-data:` to the `volumes:` block and add `postgres` to `blok.depends_on`.

**File: `infra/helm/blok/values.yaml`** — add new section after `persistence:`:

```yaml
## Trace store configuration
traceStore:
  # -- Backend: "sqlite" (single-replica default), "postgres" (multi-replica), or "memory" (tests only)
  backend: sqlite
  sqlite:
    # -- SQLite file path (must be writable; mount a volume if readOnlyRootFilesystem: true)
    path: ".blok/trace.db"
  postgres:
    # -- Full PostgreSQL connection string (takes precedence over discrete fields)
    url: ""
    poolSize: 5
    ssl: false
  # -- Enable the optional Postgres sub-chart dependency
  postgresEnabled: false
```

**File: `infra/helm/blok/templates/configmap.yaml`** — render trace store env vars from `.Values.traceStore`:

```yaml
data:
  {{- range $key, $value := .Values.env }}
  {{ $key }}: {{ $value | quote }}
  {{- end }}
  BLOK_TRACE_STORE: {{ .Values.traceStore.backend | quote }}
  {{- if eq .Values.traceStore.backend "sqlite" }}
  BLOK_TRACE_SQLITE_PATH: {{ .Values.traceStore.sqlite.path | quote }}
  {{- end }}
  {{- if eq .Values.traceStore.backend "postgres" }}
  {{- if .Values.traceStore.postgres.url }}
  BLOK_TRACE_DATABASE_URL: {{ .Values.traceStore.postgres.url | quote }}
  {{- end }}
  BLOK_TRACE_PG_POOL_SIZE: {{ .Values.traceStore.postgres.poolSize | quote }}
  BLOK_TRACE_PG_SSL: {{ .Values.traceStore.postgres.ssl | quote }}
  {{- end }}
```

**File: `infra/helm/blok/Chart.yaml`** — add optional dependency:

```yaml
dependencies:
  - name: postgresql
    version: "13.x.x"
    repository: "https://charts.bitnami.com/bitnami"
    condition: traceStore.postgresEnabled
```

Operators who want a managed external Postgres (RDS, Cloud SQL, AlloyDB) set `traceStore.postgresEnabled: false` (default) and provide the URL; operators who want an in-cluster Postgres enable the sub-chart. This is the same pattern used by Bitnami's own application charts.

### A2-D1: Expand EVENT_TYPES to the full set

**File:** `apps/studio/src/lib/sse.ts:40-50`

Current:
```typescript
const EVENT_TYPES = [
    "RUN_STARTED", "RUN_COMPLETED", "RUN_FAILED",
    "NODE_STARTED", "NODE_COMPLETED", "NODE_FAILED", "NODE_SKIPPED",
    "VARS_UPDATED", "LOG_ENTRY",
] as const;
```

New — derive the list from the type to prevent future drift:

```typescript
import type { RunEventType } from "@/types";

// Exhaustive list derived from RunEventType so Studio never silently drops
// a newly-added event type. Update RunEventType in types.ts, not here.
const EVENT_TYPES: readonly RunEventType[] = [
    "RUN_STARTED",
    "RUN_COMPLETED",
    "RUN_FAILED",
    "RUN_CRASHED",
    "RUN_TIMED_OUT",
    "RUN_CANCELLED",
    "RUN_THROTTLED",
    "RUN_DELAYED",
    "RUN_EXPIRED",
    "RUN_DEBOUNCED",
    "RUN_QUEUED",
    "NODE_STARTED",
    "NODE_COMPLETED",
    "NODE_FAILED",
    "NODE_SKIPPED",
    "NODE_CACHED",
    "NODE_ATTEMPT_FAILED",
    "NODE_PROGRESS",
    "NODE_PARTIAL_RESULT",
    "VARS_UPDATED",
    "LOG_ENTRY",
];
```

The type annotation `readonly RunEventType[]` means TypeScript will error if `EVENT_TYPES` references a value not in `RunEventType`, or if `RunEventType` grows a new member that `EVENT_TYPES` doesn't include (add a lint rule or exhaustive-check helper if needed).

### A2-D2: Fix TraceRouter per-run stream close logic

**File:** `core/runner/src/tracing/TraceRouter.ts`

Define a shared terminal-state set (near the top of the file, after imports):

```typescript
// All statuses that a WorkflowRun can never leave — stream must close when reached.
const TERMINAL_RUN_STATUSES: ReadonlySet<WorkflowRunStatus> = new Set([
    "completed", "failed", "cancelled", "crashed", "timedOut",
    "throttled", "expired", "debounced",
]);

// Events that signal a terminal run state (maps 1:1 to TERMINAL_RUN_STATUSES).
const TERMINAL_RUN_EVENTS: ReadonlySet<RunEventType> = new Set([
    "RUN_COMPLETED", "RUN_FAILED", "RUN_CANCELLED", "RUN_CRASHED",
    "RUN_TIMED_OUT", "RUN_THROTTLED", "RUN_EXPIRED", "RUN_DEBOUNCED",
]);
```

Replace line 1743:
```typescript
if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
```
with:
```typescript
if (TERMINAL_RUN_STATUSES.has(run.status)) {
```

Replace lines 1755-1758:
```typescript
if (event.type === "RUN_COMPLETED" || event.type === "RUN_FAILED") {
    res.write('event: stream-end\ndata: {"reason":"run_finished"}\n\n');
    res.end();
}
```
with:
```typescript
if (TERMINAL_RUN_EVENTS.has(event.type)) {
    res.write('event: stream-end\ndata: {"reason":"run_finished"}\n\n');
    t.removeListener("event", onEvent);
    clearInterval(heartbeat);
    res.end();
}
```

Note: the existing `req.on("close")` cleanup is correct and remains unchanged; the explicit cleanup above fires first on server-initiated close (preventing the heartbeat from ticking after the stream ends).

### A2-D3: Handle new events in useRunDetail

**File:** `apps/studio/src/hooks/useRunDetail.ts`

Add new cases to the `handleEvent` switch (after `NODE_PARTIAL_RESULT`, before the closing brace):

```typescript
case "RUN_CRASHED":
case "RUN_TIMED_OUT":
case "RUN_CANCELLED":
case "RUN_THROTTLED":
case "RUN_EXPIRED":
case "RUN_DEBOUNCED": {
    const terminalStatus: Record<string, WorkflowRunStatus> = {
        RUN_CRASHED: "crashed",
        RUN_TIMED_OUT: "timedOut",
        RUN_CANCELLED: "cancelled",
        RUN_THROTTLED: "throttled",
        RUN_EXPIRED: "expired",
        RUN_DEBOUNCED: "debounced",
    };
    updated.run = {
        ...updated.run,
        status: terminalStatus[event.type],
        finishedAt: event.timestamp,
        durationMs: event.timestamp - updated.run.startedAt,
        ...(event.payload ? { error: event.payload as WorkflowRunError } : {}),
    };
    break;
}

case "NODE_CACHED": {
    updated.nodes = updated.nodes.map((n) =>
        n.id === event.nodeId || n.nodeName === event.nodeName
            ? { ...n, status: "cached" as const, finishedAt: event.timestamp }
            : n,
    );
    break;
}

case "NODE_ATTEMPT_FAILED": {
    const attemptPayload = event.payload as Record<string, unknown> | undefined;
    updated.nodes = updated.nodes.map((n) =>
        n.id === event.nodeId || n.nodeName === event.nodeName
            ? {
                ...n,
                failedAttempts: (n.failedAttempts ?? 0) + 1,
                lastAttemptError: attemptPayload,
              }
            : n,
    );
    break;
}
```

`NodeRun` type (`apps/studio/src/types.ts`) needs two new optional fields:
```typescript
failedAttempts?: number;
lastAttemptError?: unknown;
```

And `NodeRunStatus` should gain `"cached"` as a valid status to match the server-side `NODE_CACHED` event:
```typescript
// apps/studio/src/types.ts — extend NodeRunStatus or add a display alias
```

### A2-D4: Add notifications for terminal failure states in useGlobalStream

**File:** `apps/studio/src/hooks/useGlobalStream.ts` — extend the notification block:

```typescript
} else if (event.type === "RUN_CRASHED") {
    addNotification({
        type: "error",
        title: `${event.workflowName} crashed`,
        message: "Run terminated due to an unhandled exception",
        runId: event.runId,
        workflowName: event.workflowName,
    });
} else if (event.type === "RUN_TIMED_OUT") {
    addNotification({
        type: "warning",
        title: `${event.workflowName} timed out`,
        message: "A step exceeded its maxDuration limit",
        runId: event.runId,
        workflowName: event.workflowName,
    });
} else if (event.type === "RUN_CANCELLED") {
    addNotification({
        type: "info",
        title: `${event.workflowName} cancelled`,
        message: "Run was cancelled by operator",
        runId: event.runId,
        workflowName: event.workflowName,
    });
}
```

---

## Tasks (SDD breakdown)

**T1. Change default trace store from "memory" to "sqlite" (outside test context)**
- File: `core/runner/src/tracing/createStore.ts:38`
- Change: introduce `isTest` guard and `defaultStore = isTest ? "memory" : "sqlite"`; add the boot warning block when `type === "memory" && !isTest`
- AC: `createStore()` with no args returns a `SqliteRunStore` when `NODE_ENV` is unset; returns an `InMemoryRunStore` when `NODE_ENV=test`; emits `console.warn` when `BLOK_TRACE_STORE=memory` and not in test
- Effort: 0.5 eng-days

**T2. Add Postgres service + set BLOK_TRACE_STORE in production docker-compose**
- File: `infra/docker-compose.production.yml`
- Change: add `postgres` service block, add `postgres-data` volume, add `depends_on: postgres`, set `BLOK_TRACE_STORE: postgres` and `BLOK_TRACE_DATABASE_URL` in the `blok` service environment
- AC: `docker compose -f infra/docker-compose.production.yml up -d` spins up a Postgres container; a blok container started alongside it connects and records runs into `blok.workflow_runs`
- Effort: 0.5 eng-days

**T3. Update Helm chart to expose trace store config and optional postgres sub-chart**
- Files: `infra/helm/blok/values.yaml`, `infra/helm/blok/templates/configmap.yaml`, `infra/helm/blok/Chart.yaml`
- Change: add `traceStore` stanza to values; render `BLOK_TRACE_STORE`, `BLOK_TRACE_SQLITE_PATH`, `BLOK_TRACE_DATABASE_URL`, `BLOK_TRACE_PG_POOL_SIZE` from values in configmap template; declare optional `bitnami/postgresql` dependency conditioned on `traceStore.postgresEnabled`
- AC: `helm template . --set traceStore.backend=postgres --set traceStore.postgres.url=postgres://...` renders a ConfigMap with `BLOK_TRACE_STORE: postgres` and the URL; `helm template . --set traceStore.postgresEnabled=true` renders the Postgres sub-chart in the manifest
- Effort: 1.0 eng-day

**T4. Expand SSE EVENT_TYPES to the full RunEventType set**
- File: `apps/studio/src/lib/sse.ts:40-50`
- Change: replace the 9-element hand-curated array with the exhaustive 21-element list typed as `readonly RunEventType[]`
- AC: Studio browser receives `RUN_CRASHED`, `NODE_CACHED`, `NODE_ATTEMPT_FAILED` events on a live run without page refresh; no TypeScript errors; no existing events are dropped
- Effort: 0.5 eng-days

**T5. Fix TraceRouter per-run stream to close on all terminal states**
- File: `core/runner/src/tracing/TraceRouter.ts:1742-1758`
- Change: introduce `TERMINAL_RUN_STATUSES` and `TERMINAL_RUN_EVENTS` sets; replace the status check at line 1743 and the event type check at line 1755 to use the full sets; add `t.removeListener` + `clearInterval(heartbeat)` to the live auto-close path
- AC: `GET /__blok/runs/:id/stream` for a run with status `crashed` or `timedOut` returns `event: stream-end` immediately and closes the connection; a run that transitions to `RUN_CRASHED` mid-stream delivers the event then closes the stream; integration test with a mocked `RunTracker`
- Effort: 0.5 eng-days

**T6. Handle terminal run events in useRunDetail.ts switch**
- Files: `apps/studio/src/hooks/useRunDetail.ts`, `apps/studio/src/types.ts`
- Change: add `case` arms for `RUN_CRASHED`, `RUN_TIMED_OUT`, `RUN_CANCELLED`, `RUN_THROTTLED`, `RUN_EXPIRED`, `RUN_DEBOUNCED`, `NODE_CACHED`, `NODE_ATTEMPT_FAILED`; add `failedAttempts?: number`, `lastAttemptError?: unknown` to `NodeRun`; add `"cached"` to the node status display mapping in `constants.ts`
- AC: crash a live run in Studio — the run status badge changes to "crashed" within the SSE delivery delay without a page refresh; cancel a run — badge changes to "cancelled"; a retrying node shows a failed-attempt counter incrementing in real time
- Effort: 1.0 eng-day

**T7. Add notifications for RUN_CRASHED, RUN_TIMED_OUT, RUN_CANCELLED in useGlobalStream**
- File: `apps/studio/src/hooks/useGlobalStream.ts`
- Change: extend the `if/else if` notification block with three new branches for the missing terminal states
- AC: trigger a workflow that crashes — a red toast appears in the Studio notification panel within SSE delivery time
- Effort: 0.5 eng-days

**T8. Vitest unit tests for TraceRouter stream-close correctness**
- File: `core/runner/src/__tests__/unit/tracing/TraceRouter.stream.test.ts` (new file)
- Tests: (a) connecting to a stream for a run with status `crashed` sends `stream-end` immediately; (b) connecting to a run with status `timedOut` same; (c) a live `RUN_CRASHED` event triggers `stream-end` then closes; (d) a live `RUN_CANCELLED` event triggers `stream-end`; (e) `RUN_QUEUED` event does NOT trigger `stream-end` (non-terminal); (f) the heartbeat `clearInterval` is called when stream closes via terminal event
- Effort: 1.0 eng-day

**T9. Vitest unit tests for useRunDetail event handlers**
- File: `apps/studio/src/__tests__/hooks/useRunDetail.test.tsx` (extend or create)
- Tests: (a) `RUN_CRASHED` sets `run.status === "crashed"` and `run.finishedAt`; (b) `RUN_TIMED_OUT` sets `run.status === "timedOut"`; (c) `NODE_CACHED` sets `node.status === "cached"`; (d) `NODE_ATTEMPT_FAILED` increments `node.failedAttempts`; (e) `stream-end` from `connectRunStream` triggers `queryClient.invalidateQueries` for the run and list keys
- Effort: 1.5 eng-days

---

## Tests

### Unit

| File | What it asserts |
|---|---|
| `core/runner/src/__tests__/unit/tracing/createStore.test.ts` | `createStore()` returns `SqliteRunStore` when `NODE_ENV` unset; `InMemoryRunStore` when `NODE_ENV=test`; `console.warn` called when `type === "memory"` outside test |
| `core/runner/src/__tests__/unit/tracing/TraceRouter.stream.test.ts` | Stream closes immediately for `crashed`/`timedOut`/`throttled`/`expired`/`debounced` initial statuses; live `RUN_CRASHED`/`RUN_TIMED_OUT`/`RUN_CANCELLED` events trigger close; `RUN_QUEUED` does not; heartbeat cleared on close |
| `apps/studio/src/__tests__/hooks/useRunDetail.test.tsx` | All new `case` arms in the switch set the correct `run.status` / `node.*` fields; `stream-end` event triggers `invalidateQueries` |

### Integration

- **Postgres store round-trip**: start `PostgresRunStore` against a real Postgres container (CI service); call `startRun`, `completeRun`, `getRun` — assert all fields round-trip; assert idempotency cache `setEntry`/`getEntry` work. Existing `infra/testing/docker-compose.yml` already runs Postgres.
- **Default store smoke test**: run `bun run test:integration` in a subprocess with `NODE_ENV=` unset — assert the process does not throw and `createStore()` produces a `SqliteRunStore` instance (check the constructor name).
- **SSE completeness E2E**: boot `HttpTrigger` with a test workflow that throws unconditionally; connect an `EventSource` to the run's stream; trigger the workflow; assert `stream-end` is received within 2s and the final run status is `crashed`.

---

## Back-compat, kill-switches & defaults

| Env var | Old default | New default | Kill-switch / opt-out |
|---|---|---|---|
| `BLOK_TRACE_STORE` | `"memory"` (implicit) | `"sqlite"` (implicit, outside test) | Set `BLOK_TRACE_STORE=memory` explicitly |
| `BLOK_TRACE_SQLITE_PATH` | `.blok/trace.db` | `.blok/trace.db` (unchanged) | Change to any writable path |
| `BLOK_TRACE_DATABASE_URL` | (none) | (none — set explicitly for postgres) | N/A |

**BREAKING default change (release-note required for v0.7.0):**

> Starting in this version, the trace store defaults to **SQLite** (`.blok/trace.db`) when `BLOK_TRACE_STORE` is not set, replacing the previous in-memory default. This affects containers that relied on the implicit memory behavior. If you want the previous behavior, set `BLOK_TRACE_STORE=memory` explicitly. Containers with `readOnlyRootFilesystem: true` must either mount a writable volume at `.blok/` or set `BLOK_TRACE_STORE=postgres` with a connection URL. Tests run under `NODE_ENV=test` are unaffected — they continue to use in-memory automatically.

The SSE changes (A2) are purely additive: new event subscriptions cannot break existing clients, and the stream-close changes only make the stream terminate sooner (which is correct behavior — clients that expected an infinite stream after a crash were in a broken state already).

---

## Risks & open questions

1. **SQLite on read-only root filesystems (Helm default):** `values.yaml:217` sets `readOnlyRootFilesystem: true`. With the new default, a default `helm install` will attempt to open `.blok/trace.db` and fail unless the operator mounts a writable volume. The Helm chart must document this prominently in `NOTES.txt` and should emit a warning when `traceStore.backend == "sqlite"` and `securityContext.readOnlyRootFilesystem == true` (a Helm `fail` or `required` guard). Alternatively, set `traceStore.backend: memory` as the Helm default and only flip to sqlite/postgres when the operator opts in — accepting that the default Helm install is ephemeral but at least doesn't crash. Decision needed.

2. **SQLite is still per-replica:** the default-to-sqlite change only fixes single-process deployments. Multi-replica setups still need Postgres. The production compose and Helm chart ship Postgres, but a bare `docker run` without compose gets per-container SQLite. Document this limitation clearly; it is correct behavior for single-process and wrong for N-replica.

3. **`RUN_QUEUED` and `RUN_DELAYED` are transient, not terminal:** these statuses transition to `running` when the scheduler fires. Studio's switch should update `run.status` to `"queued"` or `"delayed"` but NOT treat them as final — `stream-end` must NOT fire on these events. The `TERMINAL_RUN_EVENTS` set must explicitly exclude them (they are excluded in the design above; verify in tests).

4. **`NODE_CACHED` node status:** the Studio `NodeRunStatus` type is `"pending" | "running" | "completed" | "failed" | "skipped"` (`types.ts:217`). Adding `"cached"` requires a display-layer update (color/label in `constants.ts` — already has `NODE_CACHED: "Node Cached"` and color at line 95, so the display layer is ready; only the type union needs widening).

5. **Postgres connection string in Helm as plaintext:** the design renders `BLOK_TRACE_DATABASE_URL` from `values.yaml` into a ConfigMap, which is not secret. Operators should use `secrets.keys` (existing `secret.yaml` template) instead. Add a note: "prefer `secrets.keys.BLOK_TRACE_DATABASE_URL` over `traceStore.postgres.url` in production."

---

## Out of scope / follow-ups

- **B8 — Multi-replica SSE bus:** cross-process pub/sub fan-out for `/__blok/stream` and `/__blok/runs/:id/stream` (Redis pub/sub or NATS core messaging). Flagged here, specced separately. This is the correct follow-on once A3 ships Postgres (both require a shared broker, and Postgres + Redis are already present in the production compose). Estimated 3-5 additional eng-days for the pub/sub wiring.
- **SQLite WAL mode for concurrent readers:** `SqliteRunStore` should enable WAL (`PRAGMA journal_mode=WAL`) to allow concurrent reads alongside the trace writer. Not blocking for this epic but reduces latency spikes in Studio when many requests hit `/__blok/runs` simultaneously.
- **`wait.for()` step primitive:** mentioned in `core/runner/CLAUDE.md` as a ~2-3 day follow-on that composes the existing durable scheduler + idempotency cache. Out of scope for OBS-04 but shares infrastructure shipped here.
- **`useGlobalStream` notifications for `RUN_THROTTLED`, `RUN_DELAYED`, `RUN_EXPIRED`, `RUN_DEBOUNCED`:** lower-priority informational toasts; deferred to avoid notification fatigue until Studio has a notification-filter panel.
- **Postgres connection pooling under load:** the default `poolSize: 5` is conservative for a fintech platform under burst traffic. Right-size in a dedicated capacity-planning task once the store is in production.
