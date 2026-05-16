# SSE workflow templates

Two workflows that demonstrate the SSE trigger's pub/sub pattern.
Both are scaffolded into new projects whenever `--triggers sse` is
selected.

## Files

| File | Trigger | Purpose |
|---|---|---|
| [`stream-demo.ts`](stream-demo.ts) | `sse` — `GET /sse/demo` | Subscribes the open stream to the in-process bus channel `sse-demo` and pumps events out as SSE frames. |
| [`publish-demo.ts`](publish-demo.ts) | `http` — `POST /v07-sse-publish` | Publishes one event to the `sse-demo` channel via `@blokjs/sse-publish`. Only registered when the project also has an HTTP trigger. |

## Test the pair end-to-end

When the scaffold includes BOTH `http` and `sse`, `blokctl dev` runs a
single Node process — the HTTP entry mounts SSE on the shared Hono app
via `SSETrigger(httpTrigger.getApp(), httpTrigger)`. Same process →
same in-process bus → events flow from publisher to subscribers in real
time.

```bash
# Terminal 1 — open an SSE stream
curl -N http://localhost:4000/sse/demo
# data:
# retry: 3000
#
# (waiting…)

# Terminal 2 — publish three events
curl -X POST http://localhost:4000/v07-sse-publish \
    -H 'Content-Type: application/json' \
    -d '{"event":"counter","data":{"n":1}}'
curl -X POST http://localhost:4000/v07-sse-publish \
    -H 'Content-Type: application/json' \
    -d '{"event":"counter","data":{"n":2}}'
curl -X POST http://localhost:4000/v07-sse-publish \
    -H 'Content-Type: application/json' \
    -d '{"event":"counter","data":{"n":3}}'

# Terminal 1 receives:
# event: counter
# data: {"n":1}
# id: 1
#
# event: counter
# data: {"n":2}
# id: 2
#
# event: counter
# data: {"n":3}
# id: 3
```

## Test the stream alone (SSE-only scaffold)

In `--triggers sse` (without HTTP), the SSE process listens on its own
port (4001 by default). The publisher workflow isn't registered (no
HTTP trigger). You can still verify connectivity:

```bash
curl -N http://localhost:4001/sse/demo
```

To push events from an SSE-only project, write your own publisher —
any trigger kind works (cron, worker, manual), or call the bus
singleton directly via `import { _getSSEBus } from "@blokjs/trigger-sse"`.

## How SSE routes mount on HTTP

SSE is fundamentally HTTP: a `Content-Type: text/event-stream` response
that stays open. Every framework worth mentioning mounts SSE on the
HTTP server — Express, Fastify, FastAPI, Rails, Spring Boot, Phoenix,
ASP.NET. Blok follows the same pattern.

`SSETrigger`'s constructor takes the existing Hono app + HttpTrigger
handle:

```ts
constructor(app: Hono, httpTrigger?: HttpTriggerLike)
```

In multi-trigger scaffolds, the HTTP entry constructs SSE this way and
SSE registers routes via `httpTrigger.addPreCatchAllHook(...)`. Routes
land BEFORE Hono's legacy workflow catch-all (`/:workflow{.+}`), so
`/sse/<path>` upgrade requests reach the SSE handler instead of being
dispatched as a workflow name.

In SSE-only scaffolds, the generated `SSEServer.ts` builds its own
Hono app + calls `serve()` directly. Same trigger code, different
hosting surface.

## Cross-process bus backplane (advanced)

The default SSE bus is in-process — `@blokjs/sse-publish` only fans
out to subscribers on the SAME Node process. That's fine for the
default scaffold layout (HTTP+SSE share one process). For
horizontally-scaled deployments where clients connect to different
replicas, swap in a Redis Streams or NATS JetStream backplane.
Tracked as a v0.7 follow-up in [BACKLOG.md](../../../../../BACKLOG.md).

## Helper nodes available

`@blokjs/helpers` exports three SSE-aware helpers, all spread into the
shared Nodes record when `--triggers sse` is selected:

| Node | Purpose |
|---|---|
| `@blokjs/sse-subscribe` | Subscribe the current SSE stream to channels on the bus. Returns an iterator handle. |
| `@blokjs/sse-stream` | Pump events from a subscribed iterator out to the client as SSE frames. |
| `@blokjs/sse-publish` | Publish one event to a bus channel — works from ANY workflow kind (HTTP, Worker, Cron, WS). |

## LLM training pattern

This template reads top-to-bottom as a canonical SSE pattern. A coding-
assistant LLM seeing this directory should learn:

- The `trigger.sse` config shape (`path`, `heartbeatInterval`,
  `retryInterval`, `maxConnections`, `channels`)
- The `@blokjs/sse-subscribe` → `@blokjs/sse-stream` step pair as the
  stream-side primitive
- `@blokjs/sse-publish` as the publisher-side primitive (usable from
  any trigger kind)
- `$.state.<id>` (unquoted, TS proxy) for piping `sse-subscribe`'s
  output into `sse-stream`. Quoted strings like `"$.state.sub"`
  don't work — the Mapper only recognizes `js/ctx....` strings or
  the `$` proxy.
- Why the publisher is decoupled from the subscriber (one HTTP POST
  can fan out to N connected SSE clients via the bus)
