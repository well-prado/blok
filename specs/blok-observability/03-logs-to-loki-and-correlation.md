# OBS-03 — Logs → Loki & correlation

> **Status:** PROPOSED · **Phase:** mixed (1 wire-what-exists + 2 build-new) · **Effort:** 6 eng-days · **Depends on:** OBS-02 (trace_id must exist before T4 activates the Tempo→Loki cross-link)

## TL;DR

Blok emits JSON-structured log lines but no log shipper exists to carry them to Loki; the production compose file actively silences stdout entirely (`CONSOLE_LOG_ACTIVE: "false"`). This epic adds a Grafana Alloy sidecar/DaemonSet, re-enables structured stdout in production, enriches every log line with `run_id` and (when OBS-02 is live) `trace_id` / `span_id`, promotes those fields to Loki stream labels, moves Loki storage off `/tmp`, and consolidates the two extant logger classes into one. The end result: every workflow error is queryable in Loki by run, workflow name, level, and trace — with a one-click jump from Grafana Tempo to the matching log stream.

---

## Problem / current state

### File:line evidence table

| File | Line(s) | What is there today |
|---|---|---|
| `infra/docker-compose.production.yml` | 23 | `CONSOLE_LOG_ACTIVE: "false"` — silences ALL stdout/stderr from DefaultLogger and StructuredLogger, so production containers emit zero log lines |
| `infra/docker-compose.production.yml` | 73–77 | Logging driver is the default `json-file` with a 50 MB rolling cap; no Loki driver or Alloy sidecar configured |
| `infra/metrics/docker-compose.yml` | 126–145 | `blok-http:` service with Loki log driver is commented out; no other shipper |
| `triggers/http/infra/docker-compose.yml` | 33–37 | Loki log driver block commented out; dev container emits to stdout but is never shipped to Loki |
| `infra/metrics/loki-config.yaml` | 7–10 | `path_prefix: /tmp/loki`, `chunks_directory: /tmp/loki/chunks` — ephemeral tmpfs, data lost on pod/container restart |
| `infra/metrics/datasources.yml` | 30–35 | `tracesToLogsV2` is wired in Grafana pointing at Loki with `filterByTraceID: true` and `filterBySpanID: true` — the cross-link is provisioned but will never fire because logs never reach Loki and `trace_id` is absent from the log lines anyway |
| `infra/helm/blok/values.yaml` | 1–222 | No Alloy / promtail DaemonSet, no log shipper sidecar, no `CONSOLE_LOG_ACTIVE` env var override |
| `infra/helm/blok/templates/deployment.yaml` | 82–105 | `envFrom` pulls from a ConfigMap with no `CONSOLE_LOG_ACTIVE` key; no log-shipper container in the pod spec |
| `core/runner/src/DefaultLogger.ts` | 56–80 | Guards `if (process.env.CONSOLE_LOG_ACTIVE === "false") return` in every method: `log`, `logLevel`, `error` — the first gate that kills all output in prod |
| `core/runner/src/DefaultLogger.ts` | 90–104 | `injectMetadata()` emits: `level`, `app`, `env`, `message`, `workflow_name`, `workflow_path`, `request_id`. No `run_id`, no `trace_id`, no `span_id`. |
| `core/runner/src/monitoring/StructuredLogger.ts` | 78–264 | Full-featured structured logger: JSON output, OTel `trace_id` / `span_id` injection (lines 244–252), `BLOK_LOG_LEVEL` env support, child-logger API, custom transport — but **never instantiated by any trigger at boot** |
| `core/runner/src/monitoring/StructuredLogger.ts` | 228 | Also gates on `process.env.CONSOLE_LOG_ACTIVE === "false"` — same kill switch |
| `core/runner/src/TriggerBase.ts` | 1701 | `ctx.logger` is set to `new DefaultLogger(...)` — the richer StructuredLogger is not used anywhere in the trigger path |
| `core/runner/src/TriggerBase.ts` | 930 | `ctx.logger = new TracingLogger(ctx.logger, run.id, tracker)` — `run.id` is passed to TracingLogger (for Studio's log_entries table) but NOT forwarded to the underlying DefaultLogger's JSON output |
| `core/runner/src/tracing/TracingLogger.ts` | 9–75 | Wraps an inner logger + forwards to Studio; the `runId` field (line 11) is held privately and only used to call `tracker.addLog({runId, ...})`. It is never serialised into the JSON line emitted by the inner DefaultLogger. |
| `core/runner/src/integrations/APMIntegration.ts` | 190 | `bootstrapTracing` is called here inside an APM integration — not from any trigger `listen()` |

### Summary of breakage

1. **Zero logs reach Loki.** No log driver, no Alloy, no promtail. The shipped infrastructure stubs (commented Docker log driver blocks) are vestigial.
2. **Production stdout is actively disabled.** `CONSOLE_LOG_ACTIVE: "false"` in the production compose means the container is completely dark to any future shipper that might be added. Operators deploying this stack today have no application logs at all.
3. **No correlation key on log lines.** `DefaultLogger.injectMetadata` emits `request_id` (a UUID assigned by `TriggerBase.createContext` before the run starts) but not `run_id` (assigned by `tracker.startRun` after the context is created). The Studio internal path — `TracingLogger → tracker.addLog` — does hold `run_id`, but that write goes to the SQLite/Postgres log_entries table, not to stdout.
4. **StructuredLogger is dead code in triggers.** It is exported from `@blokjs/runner`, tested in `core/runner/src/monitoring/__tests__/StructuredLogger.test.ts`, and even has OTel `trace_id`/`span_id` auto-injection. But `TriggerBase.createContext` (line 1701) creates a `DefaultLogger` unconditionally, and no trigger's `listen()` ever instantiates `StructuredLogger`.
5. **Loki storage is ephemeral.** `/tmp/loki` in `loki-config.yaml` guarantees data loss on pod restart in any containerised deployment.
6. **Tempo→Loki cross-link is provisioned but dead.** `infra/metrics/datasources.yml` line 30–35 has the correct `tracesToLogsV2` config. It will work the moment logs reach Loki **and** carry `trace_id` — both currently absent.

---

## Goal & acceptance criteria

- **AC1.** A production deployment (`docker compose --profile monitoring up`) ships every stdout log line to Loki within 5 seconds of emission, verifiable by querying `{service="blok-http"}` in Grafana.
- **AC2.** Every log line contains `run_id` matching `WorkflowRun.id` in the Blok Studio run list. Loki query `{run_id="<uuid>"}` returns all lines for that run.
- **AC3.** Every log line contains `workflow_name` matching the workflow. Loki query `{workflow_name="my-workflow", level="error"}` returns error lines for that workflow across all replicas.
- **AC4.** When OBS-02 is active, every log line for a traced run contains `trace_id` and `span_id`. Clicking "Logs" on a Tempo trace in Grafana jumps to the matching Loki stream without manual label entry (the existing `tracesToLogsV2` datasource config is sufficient once the fields are present).
- **AC5.** `CONSOLE_LOG_ACTIVE: "false"` is removed from `infra/docker-compose.production.yml`. The default behavior is that logs are emitted; operators who want silence may explicitly set `BLOK_LOGS_DISABLED=true`.
- **AC6.** Loki storage in `loki-config.yaml` uses a named Docker volume (not `/tmp`), matching the pattern of the other services in the production compose.
- **AC7.** The Helm chart has a `logging.alloy.enabled` value that, when `true`, adds a Grafana Alloy sidecar container to the blok pod that ships logs from the pod's shared log volume (or `stdio` collector) to the configured Loki endpoint.
- **AC8.** There is exactly one logger class used by triggers (`StructuredLogger` adopted in `TriggerBase`); `DefaultLogger` is kept as a thin compatibility shim or removed. No regression in Studio per-run log entries.
- **AC9.** `BLOK_LOG_LEVEL` env var is respected by the trigger logger (already wired in StructuredLogger; currently ignored by DefaultLogger).
- **AC10.** A unit test asserts that a log line emitted during a workflow run (after `tracker.startRun`) carries `run_id`.

---

## Design / proposed changes

### T1 — Re-enable stdout and consolidate to StructuredLogger

**Root cause:** Two loggers, wrong one in use. `TriggerBase.createContext` always creates a `DefaultLogger`. `StructuredLogger` has every feature needed (OTel injection, level gating, custom transport, child loggers) but is never wired.

**Change: `core/runner/src/TriggerBase.ts` line 1701**

Current:
```ts
logger: logger || new DefaultLogger(configuration.name, blueprintPath, requestId),
```

Proposed:
```ts
import { StructuredLogger } from "./monitoring/StructuredLogger";

logger: logger || new StructuredLogger({
  service: process.env.APP_NAME || "blok",
  environment: process.env.NODE_ENV || "development",
  defaultFields: {
    workflow_name: configuration.name,
    workflow_path: blueprintPath ?? "",
    request_id: requestId,
  },
}).child({}),   // returns a StructuredLogger that satisfies LoggerContext
```

**Problem:** `StructuredLogger` does not implement `LoggerContext` from `@blokjs/shared` (which exposes `log`, `logLevel`, `error`, `getLogs`, `getLogsAsText`, `getLogsAsBase64`). Two options:
- Option A: Add an adapter shim that wraps `StructuredLogger` and satisfies `LoggerContext`. Keeps the two classes decoupled.
- Option B: Merge `DefaultLogger` into `StructuredLogger` by implementing the `LoggerContext` interface directly on `StructuredLogger`.

**Chosen approach: Option A** — adapter shim `core/runner/src/logging/StructuredLoggerAdapter.ts`. It wraps a `StructuredLogger` instance, delegates the `LoggerContext` surface to it (mapping `log` → `info`, `logLevel` → level-aware dispatch, `error` → `error`), and stores emitted lines for `getLogs()` / `getLogsAsText()` / `getLogsAsBase64()`. This leaves `StructuredLogger` as a clean standalone class (already tested) while satisfying the internal interface.

`DefaultLogger` is retained but deprecated — it becomes a thin wrapper that instantiates `StructuredLoggerAdapter` internally (so any code that still calls `new DefaultLogger()` gets structured output automatically). This is the zero-breaking-change migration path.

**New env var:** `BLOK_LOGS_DISABLED=true` — replaces `CONSOLE_LOG_ACTIVE=false`. Both are honored for back-compat; `BLOK_LOGS_DISABLED` is the forward-looking name. `StructuredLoggerAdapter` checks both. Kill-switch: set `BLOK_LOGS_DISABLED=true`.

### T2 — Inject `run_id` onto every log line after `tracker.startRun`

**Root cause:** `run.id` is available at TriggerBase line 910 (`traceRunId = run.id`) but is only passed to `TracingLogger` for the Studio path. The underlying logger never sees it.

**Change: `core/runner/src/TriggerBase.ts` ~line 930**

Currently:
```ts
ctx.logger = new TracingLogger(ctx.logger, run.id, tracker);
```

After T1, `ctx.logger` is a `StructuredLoggerAdapter` wrapping a `StructuredLogger`. The fix is to call `.child({ run_id: run.id })` on the underlying `StructuredLogger` before wrapping in `TracingLogger`:

```ts
// After T1: ctx.logger is a StructuredLoggerAdapter.
// Rebind to a child with run_id in the default fields.
if (ctx.logger instanceof StructuredLoggerAdapter) {
  ctx.logger = ctx.logger.withField("run_id", run.id);
}
// Then wrap for Studio forwarding as before:
ctx.logger = new TracingLogger(ctx.logger, run.id, tracker);
```

`StructuredLoggerAdapter.withField(key, value)` returns a new adapter whose underlying `StructuredLogger` is a child with the additional field. All subsequent log calls through `ctx.logger` emit the `run_id` field. `TracingLogger` still wraps it to forward to Studio — no regression.

**Result:** log line shape after T1 + T2:
```json
{
  "timestamp": "2026-06-23T10:00:00.000Z",
  "level": "info",
  "service": "blok",
  "env": "production",
  "message": "Node executed",
  "workflow_name": "payment-process",
  "workflow_path": "/payments/process",
  "request_id": "<uuid-assigned-at-createContext>",
  "run_id": "<uuid-assigned-by-tracker.startRun>",
  "trace_id": "<otel-trace-id-if-obs02-active>",
  "span_id": "<otel-span-id-if-obs02-active>"
}
```

`trace_id` / `span_id` are injected automatically by `StructuredLogger.write` (lines 244–252) when an active OTel span exists — free once OBS-02 wires the OTLP provider.

### T3 — Fix `CONSOLE_LOG_ACTIVE` in production compose + move Loki storage off `/tmp`

**Change A: `infra/docker-compose.production.yml` line 23**

Remove:
```yaml
CONSOLE_LOG_ACTIVE: "false"
```

Add (in the monitoring profiles section or as a replacement):
```yaml
# Logs are emitted to stdout by default; Alloy/Loki docker-driver picks them up.
# Set BLOK_LOGS_DISABLED=true only if you explicitly want silence.
```

This is a **breaking default change** for any operator relying on the current no-logs behavior. Release note required: "Production deployments now emit structured JSON logs to stdout by default. To restore the previous silent behavior, set `BLOK_LOGS_DISABLED=true`."

**Change B: `infra/metrics/loki-config.yaml` lines 7–10**

Current:
```yaml
common:
  instance_addr: 127.0.0.1
  path_prefix: /tmp/loki
  storage:
    filesystem:
      chunks_directory: /tmp/loki/chunks
      rules_directory: /tmp/loki/rules
```

Proposed (durable storage, matching the production pattern):
```yaml
common:
  instance_addr: 127.0.0.1
  path_prefix: /loki
  storage:
    filesystem:
      chunks_directory: /loki/chunks
      rules_directory: /loki/rules
```

The `loki-data` named volume is already declared in `infra/docker-compose.production.yml` line 236 and mounted at `/loki` for the `loki` service (it mounts the config file but the data path must match). Update the loki service volume mount in `infra/docker-compose.production.yml`:

```yaml
loki:
  volumes:
    - ./metrics/loki-config.yaml:/etc/loki/config.yaml:ro
    - loki-data:/loki     # add this; was missing
```

**Change C: `infra/metrics/docker-compose.yml`** — uncomment and update the `blok-http:` logging block (lines 126–145) to use the Docker Loki log driver instead of Alloy for the dev compose:

```yaml
blok-http:
  logging:
    driver: loki
    options:
      loki-url: "http://localhost:3100/loki/api/v1/push"
      loki-retries: "5"
      loki-batch-size: "400"
      loki-pipeline-stages: |
        - json:
            expressions:
              level: level
              workflow_name: workflow_name
              run_id: run_id
        - labels:
            level:
            workflow_name:
            run_id:
```

### T4 — Add Grafana Alloy sidecar to Helm chart + Alloy config

No log shipper exists anywhere in the Helm chart. The Helm deployment pod spec (`infra/helm/blok/templates/deployment.yaml`) has no sidecar container and no log collection volume.

**New file: `infra/helm/blok/templates/alloy-config.yaml`** (ConfigMap)

```yaml
{{- if .Values.logging.alloy.enabled }}
apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ include "blok.fullname" . }}-alloy-config
  labels:
    {{- include "blok.labels" . | nindent 4 }}
data:
  config.alloy: |
    loki.source.file "blok_stdout" {
      targets = [
        {__path__ = "/var/log/blok/*.log", job = "blok"},
      ]
      forward_to = [loki.process.extract_labels.receiver]
    }

    loki.process "extract_labels" {
      stage.json {
        expressions = {
          level        = "level",
          workflow_name = "workflow_name",
          run_id       = "run_id",
          trace_id     = "trace_id",
        }
      }
      stage.labels {
        values = {
          level         = "",
          workflow_name = "",
          run_id        = "",
        }
      }
      forward_to = [loki.write.default.receiver]
    }

    loki.write "default" {
      endpoint {
        url = env("LOKI_ENDPOINT")
      }
    }
{{- end }}
```

**Edit: `infra/helm/blok/templates/deployment.yaml`** — add Alloy sidecar container and shared log volume when `logging.alloy.enabled: true`:

```yaml
{{- if .Values.logging.alloy.enabled }}
- name: alloy
  image: {{ .Values.logging.alloy.image | default "grafana/alloy:latest" }}
  args:
    - run
    - /etc/alloy/config.alloy
  env:
    - name: LOKI_ENDPOINT
      value: {{ .Values.logging.alloy.lokiEndpoint | required "logging.alloy.lokiEndpoint is required when logging.alloy.enabled=true" | quote }}
  volumeMounts:
    - name: alloy-config
      mountPath: /etc/alloy
    - name: blok-logs
      mountPath: /var/log/blok
{{- end }}
```

**Edit: `infra/helm/blok/values.yaml`** — add logging section:

```yaml
## Logging
logging:
  alloy:
    # -- Enable Grafana Alloy log-shipping sidecar
    enabled: false
    # -- Alloy container image
    image: grafana/alloy:v1.9.0
    # -- Loki push endpoint (required when enabled)
    lokiEndpoint: ""
```

Also update `TriggerBase`'s stdout path (`StructuredLoggerAdapter`) to write log lines to `/var/log/blok/blok.log` when `BLOK_LOG_FILE` is set (optional transport), so Alloy can tail the file. Default: emit to stdout only (Docker log driver or pod log aggregation handles collection in most environments).

**New env var:** `BLOK_LOG_FILE` — if set, `StructuredLoggerAdapter` additionally writes JSON lines to that path (file transport). Default: unset. Kill-switch: leave unset.

### T5 — Pipeline stages for Loki label promotion

Loki `pipeline_stages` in the Alloy config (T4) promote `workflow_name`, `level`, and `run_id` to stream labels. `trace_id` is kept as a structured metadata field (not a label) to avoid high-cardinality label explosion. The Loki config in `infra/metrics/loki-config.yaml` needs no changes for this — label promotion happens in the Alloy pipeline stage or Docker log driver options.

For the Docker Compose path (dev/production), add label promotion in the `loki` Docker driver options (T3-C above). For the Helm/Alloy path, the `loki.process "extract_labels"` stage in T4 handles it.

### T6 — Loki datasource: enable structured metadata for `trace_id`

**Edit: `infra/metrics/datasources.yml`**

The existing `tracesToLogsV2` config (lines 30–35) is already correct. When `trace_id` and `span_id` are present in log lines as **structured metadata** (not stream labels), Grafana Loki requires the field to be surfaced via `derivedFields` for the cross-link to activate. Add to the Loki datasource:

```yaml
  - name: Loki
    type: loki
    access: proxy
    url: http://loki:3100
    jsonData:
      timeout: 60
      maxLines: 1000
      derivedFields:
        - datasourceUid: tempo
          matcherRegex: '"trace_id":"([a-f0-9]{32})"'
          name: TraceID
          url: "$${__value.raw}"
```

This activates the "Open in Tempo" button on Loki log lines, complementing the existing Tempo→Loki direction already provisioned.

---

## Tasks (SDD breakdown)

**T1. Adopt StructuredLogger in TriggerBase via adapter shim**

- **Files:** `core/runner/src/logging/StructuredLoggerAdapter.ts` (new), `core/runner/src/TriggerBase.ts` (line 1701), `core/runner/src/DefaultLogger.ts` (deprecate to thin shim), `core/runner/src/index.ts` (export adapter)
- **Change:** Create `StructuredLoggerAdapter` implementing `LoggerContext`. Wire it in `TriggerBase.createContext`. Deprecate `DefaultLogger` to a wrapper that instantiates the adapter internally. Honor both `BLOK_LOGS_DISABLED=true` and legacy `CONSOLE_LOG_ACTIVE=false`.
- **Acceptance:** Boot the HTTP trigger; `curl localhost:4000/health` emits a JSON line with `level`, `service`, `workflow_name`, `timestamp` to stdout. `getLogs()` on the logger returns the buffered lines (for Studio back-compat).
- **Effort:** 1 eng-day

**T2. Inject `run_id` onto log lines after `tracker.startRun`**

- **Files:** `core/runner/src/TriggerBase.ts` (~line 930), `core/runner/src/logging/StructuredLoggerAdapter.ts` (add `withField` method)
- **Change:** After `run = tracker.startRun(...)`, call `ctx.logger = ctx.logger.withField("run_id", run.id)` before the `TracingLogger` wrap. `TracingLogger` wraps the updated adapter as before. Studio log_entries path is unchanged (TracingLogger still forwards to tracker).
- **Acceptance:** Unit test asserts that a log line emitted AFTER `tracker.startRun` carries `run_id`. A log line emitted BEFORE (e.g. during workflow load) does not carry `run_id` (expected — the run has not started yet).
- **Effort:** 0.5 eng-days

**T3. Remove `CONSOLE_LOG_ACTIVE: "false"` from production compose; fix Loki storage**

- **Files:** `infra/docker-compose.production.yml` (line 23), `infra/metrics/loki-config.yaml` (lines 7–10), `infra/docker-compose.production.yml` (loki service volume mount)
- **Change A:** Delete the `CONSOLE_LOG_ACTIVE: "false"` line. Add a comment directing operators to `BLOK_LOGS_DISABLED=true`.
- **Change B:** Replace `/tmp/loki` with `/loki` in `loki-config.yaml`. Add `loki-data:/loki` volume mount to the loki service in production compose.
- **Change C:** Uncomment and update the Loki log-driver block in `infra/metrics/docker-compose.yml` for the `blok-http` container with JSON pipeline stages promoting `level`, `workflow_name`, `run_id` as stream labels.
- **Acceptance:** `docker compose -f infra/docker-compose.production.yml --profile monitoring up -d && curl localhost:4000/health && sleep 10 && curl 'http://localhost:3100/loki/api/v1/query?query={job="blok"}'` returns log entries. Loki data survives `docker compose restart loki`.
- **Effort:** 0.5 eng-days

**T4. Add Grafana Alloy sidecar to Helm chart**

- **Files:** `infra/helm/blok/values.yaml`, `infra/helm/blok/templates/deployment.yaml`, `infra/helm/blok/templates/alloy-config.yaml` (new)
- **Change:** Add `logging.alloy` values block. Add conditional Alloy sidecar container and ConfigMap template. Add `blok-logs` emptyDir volume shared between blok and alloy containers. Alloy config reads from shared log dir, runs JSON pipeline stages, writes to `LOKI_ENDPOINT`.
- **Acceptance:** `helm template blok ./infra/helm/blok --set logging.alloy.enabled=true,logging.alloy.lokiEndpoint=http://loki:3100/loki/api/v1/push | grep -A5 "alloy"` shows the sidecar container. `helm lint` passes.
- **Effort:** 1.5 eng-days

**T5. Add `BLOK_LOG_FILE` file transport to StructuredLoggerAdapter**

- **Files:** `core/runner/src/logging/StructuredLoggerAdapter.ts`
- **Change:** In the constructor, if `process.env.BLOK_LOG_FILE` is set, open an append-only write stream to that path and tee each log line to it alongside stdout. Handle write errors gracefully (log to stderr, keep stdout transport alive).
- **Acceptance:** Set `BLOK_LOG_FILE=/tmp/blok.log`, boot the trigger, run a workflow, verify `/tmp/blok.log` contains JSON lines with `run_id`.
- **Effort:** 0.5 eng-days

**T6. Update Loki datasource config for `trace_id` derived field + Tempo cross-link**

- **Files:** `infra/metrics/datasources.yml`
- **Change:** Add `derivedFields` entry under the Loki datasource pointing at the Tempo datasource UID, matching `trace_id` from the JSON log body. The existing `tracesToLogsV2` block on the Tempo datasource (lines 30–35) is already correct and requires no changes.
- **Acceptance:** In Grafana, open a Loki log line that contains `trace_id`; the "Open in Tempo" button appears and navigates to the correct trace. Open a Tempo trace; clicking "Logs" opens the matching Loki stream filtered by `trace_id`.
- **Effort:** 0.5 eng-days

**T7. Unit + integration test coverage**

- **Files:** `core/runner/src/logging/__tests__/StructuredLoggerAdapter.test.ts` (new), `core/runner/src/__tests__/unit/TriggerBase.logging.test.ts` (new or extend existing)
- **Change:** Tests listed in the Tests section below.
- **Effort:** 1.5 eng-days

---

## Tests

### Unit tests

**`core/runner/src/logging/__tests__/StructuredLoggerAdapter.test.ts`**

- Adapter satisfies the `LoggerContext` interface (`log`, `logLevel`, `error`, `getLogs`, `getLogsAsText`, `getLogsAsBase64`).
- `log("hello")` emits a JSON line with `level: "info"` and `message: "hello"`.
- `error("boom", "at line 1")` emits `level: "error"` and `stack: "at line 1"`.
- `withField("run_id", "abc")` returns a new adapter; subsequent calls emit `run_id: "abc"`.
- `BLOK_LOGS_DISABLED=true` suppresses all output.
- `CONSOLE_LOG_ACTIVE=false` (legacy) also suppresses output.
- `BLOK_LOG_LEVEL=warn` suppresses `info` calls.
- `getLogs()` returns all buffered lines including ones emitted before `run_id` was set.

**`core/runner/src/__tests__/unit/TriggerBase.logging.test.ts`**

- A log line emitted via `ctx.logger.log(...)` BEFORE `tracker.startRun` does NOT contain `run_id`.
- A log line emitted via `ctx.logger.log(...)` AFTER the `TracingLogger` wrap DOES contain `run_id`.
- `ctx.logger.getLogs()` still returns all lines (Studio back-compat).
- `DefaultLogger` (legacy path) emits the same JSON structure as the adapter (regression guard).

### Integration / smoke tests

**End-to-end smoke test (compose)**

```bash
# 1. Boot with monitoring profile
docker compose -f infra/docker-compose.production.yml --profile monitoring up -d

# 2. Trigger a workflow run
curl -X POST http://localhost:4000/api/your-workflow -d '{}' -H 'Content-Type: application/json'

# 3. Wait for Loki scrape
sleep 10

# 4. Query Loki — must return >= 1 line
curl -s 'http://localhost:3100/loki/api/v1/query?query={workflow_name="your-workflow"}' | jq '.data.result | length'
# Expected: >= 1

# 5. Query by run_id (grab from the run list first)
RUN_ID=$(curl -s http://localhost:4000/__blok/runs | jq -r '.runs[0].id')
curl -s "http://localhost:3100/loki/api/v1/query?query={run_id=\"$RUN_ID\"}" | jq '.data.result | length'
# Expected: >= 1
```

**OBS-02 trace cross-link test (after OBS-02 is live)**

```bash
# Boot with OTEL_EXPORTER_OTLP_ENDPOINT set, run a workflow.
# In Grafana Tempo, find the trace. Click "Logs". Verify Loki query
# fires with trace_id and returns matching log lines.
```

**Helm lint**

```bash
helm lint infra/helm/blok
helm template blok infra/helm/blok --set logging.alloy.enabled=true,logging.alloy.lokiEndpoint=http://loki:3100/loki/api/v1/push | kubectl apply --dry-run=client -f -
```

---

## Back-compat, kill-switches & defaults

| Env var | Default | Effect |
|---|---|---|
| `BLOK_LOGS_DISABLED` | unset (logs emitted) | Set to `true` to suppress all stdout log output. Replaces `CONSOLE_LOG_ACTIVE=false`. |
| `CONSOLE_LOG_ACTIVE` | unset (logs emitted) | Legacy. `=false` still suppresses output for back-compat. Deprecated — remove in v0.8. |
| `BLOK_LOG_LEVEL` | `"info"` | Minimum log level. Already honored by `StructuredLogger`. T1 wires it to the trigger logger path. Values: `debug` / `info` / `warn` / `error` / `fatal`. |
| `BLOK_LOG_FILE` | unset | If set to a file path, `StructuredLoggerAdapter` additionally writes JSON lines to that file (for Alloy file tailing). |
| `APP_NAME` | `"blok"` | Emitted as the `service` field in every log line. Already set in production compose (line 22). |

**Breaking default change (release-note required):**

Removing `CONSOLE_LOG_ACTIVE: "false"` from `infra/docker-compose.production.yml` means production containers that previously emitted nothing to stdout will now emit structured JSON. Any log aggregation pipeline that was ingesting the `json-file` driver output silently (expecting no Blok lines) will now see them. Operators must opt in to silence explicitly with `BLOK_LOGS_DISABLED=true`.

**No regression to Studio per-run log entries:** `TracingLogger` still wraps the adapter and forwards to `tracker.addLog(...)`. The `log_entries` table path is unchanged. The only difference is that the inner logger now also writes to stdout.

---

## Risks & open questions

1. **High-cardinality `run_id` Loki labels.** Every run gets a unique UUID. If promoted to a Loki stream label, this creates one stream per run — Loki's cardinality guidance says to avoid this. The design in T3/T4 promotes `workflow_name`, `level`, and `run_id` as labels. `run_id` as a label is intentional for quick per-run query but must be weighed against the Loki cardinality limit (default 10k active streams per tenant). For Paga.eu's expected volume (~thousands of runs/day), this is safe. Monitor `loki_ingester_memory_chunks` and switch `run_id` from a label to structured metadata if cardinality spikes.

2. **Docker Loki log driver requirement.** The Loki Docker log driver plugin (`grafana/loki-docker-driver`) must be installed on the Docker host separately (`docker plugin install grafana/loki-docker-driver:latest --alias loki --grant-all-permissions`). T3 must document this prerequisite; it cannot be installed via compose itself.

3. **`withField` and `TracingLogger` interleaving.** After T2, `ctx.logger` is a `TracingLogger` wrapping a `StructuredLoggerAdapter`. If node code calls `ctx.logger.withField(...)` expecting to get a new adapter, it will get a type error because `TracingLogger` does not expose `withField`. This is the right behavior (nodes should not re-bind loggers), but it must be documented. The `withField` method lives on the adapter only, used internally by `TriggerBase`.

4. **OBS-02 dependency for `trace_id`.** AC4 and T6 are maximally useful only after OBS-02 ships the OTLP provider. T6 can be deployed independently — the derived field config is safe when `trace_id` is absent (the regex simply won't match). T1–T5 are fully independent of OBS-02.

5. **Alloy vs. promtail.** The spec chooses Grafana Alloy (successor to promtail, actively maintained, supports OpenTelemetry). If the operator's Kubernetes cluster already runs a Fluent Bit DaemonSet or another shipper, the Helm sidecar is redundant. The `logging.alloy.enabled: false` default means zero-impact for those environments.

---

## Out of scope / follow-ups

- **Alert rules in Loki / Grafana** for `level="error"` log lines or error rate per workflow — belongs in OBS-05 (alerting epic).
- **Log retention policies** (Loki `limits_config.retention_period`) — infra operator concern, not a framework change.
- **Switching `run_id` from label to Loki structured metadata** if cardinality becomes a concern at scale. Loki 2.9+ supports structured metadata as a first-class concept without label promotion.
- **Worker trigger log shipping.** The `WorkerTrigger` inherits the same `TriggerBase` path and will benefit from T1/T2 automatically. However, workers run as separate processes; log collection there depends on the container runtime log driver (compose) or DaemonSet (Kubernetes), not the Alloy sidecar (which is blok-pod-local). Wiring the worker compose service to the Loki driver is a follow-up.
- **`blokctl trace` (Studio) log viewer.** The per-run `log_entries` table path already works and is out of scope. This epic is exclusively about the external Loki export path.
- **Structured log sampling** (emit only `error` + `warn` to Loki in high-volume scenarios). Can be implemented as a `BLOK_LOKI_MIN_LEVEL` env on the Alloy pipeline stage. Deferred.
