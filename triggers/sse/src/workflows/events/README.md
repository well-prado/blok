# SSE workflow templates

Two workflows that demonstrate the SSE trigger's pub/sub pattern.
Both are scaffolded into new projects whenever `--triggers sse` is
selected.

## Files

| File | Trigger | Purpose |
|---|---|---|
| [`stream-demo.ts`](stream-demo.ts) | `sse` — `GET /sse/demo` | Subscribes the open stream to the in-process bus channel `sse-demo` and pumps events out as SSE frames. |
| [`publish-demo.ts`](publish-demo.ts) | `http` — `POST /v07-sse-publish` | Publishes one event to the `sse-demo` channel via `@blokjs/sse-publish`. Only useful when the project also has an HTTP trigger. |

Open the stream in one terminal, POST events from another, and the
stream client receives them in real time.

## Test the stream

The stream-side works on its own — connect any EventSource client to
`http://localhost:4001/sse/demo` and you'll see the initial
`retry: 3000` field plus heartbeat frames every 15 seconds:

```bash
curl -N http://localhost:4001/sse/demo
```

## Test the pair (in-process)

The publish-demo workflow lives behind the HTTP trigger. In a
multi-trigger scaffold (`--triggers http,sse`), `blokctl dev` runs
HTTP and SSE in **separate processes**, so each process gets its own
in-process bus instance. Events posted to the HTTP process do **not**
reach the SSE process's subscribers. This is by design — the v0.7
SSE bus is in-process only; a cross-process backplane (Redis Streams /
NATS JetStream) is a documented follow-up.

To exercise the full pair end-to-end today, three options:

### Option 1 — run both triggers in the same Node process

Boot only the HTTP entry, which already mounts SSE on the shared
Hono app via `addPreCatchAllHook`. Edit `src/triggers/http/index.ts`
to construct `SSETrigger` against the HTTP app instead of letting
`blokctl dev` spawn a separate SSE process:

```ts
import HttpTrigger from "./runner/HttpTrigger";
import SSETrigger from "../sse/SSETrigger";

const httpTrigger = new HttpTrigger();
const sseTrigger = new SSETrigger(httpTrigger.getApp(), httpTrigger);
sseTrigger.setNodeMap(/* nodes + workflows */);
await sseTrigger.listen();
await httpTrigger.listen();
```

Then run `bun run src/triggers/http/index.ts` directly — both
triggers share one bus, one Hono app, one port (4000).

### Option 2 — point both triggers at a cross-process bus

Wait for the Redis Streams / NATS JetStream bus backplane.
Tracked in [BACKLOG.md](../../../../../BACKLOG.md).

### Option 3 — publish from the SSE process itself

Add a cron- or worker-triggered workflow that publishes to the
`sse-demo` channel using `@blokjs/sse-publish`. As long as the
publisher and subscriber live in the same Node process, the
in-process bus carries the events.

## How the bus pattern works

```
       publishers                              subscribers
   ┌─────────────────┐                    ┌──────────────────┐
   │ POST /publish   │                    │  GET  /sse/demo  │
   │  ↓              │                    │   ↑              │
   │ @blokjs/sse-    │                    │ @blokjs/sse-     │
   │   publish       │                    │   stream         │
   │   .channel=X    │                    │   .source=        │
   └────────┬────────┘                    │   $.state.sub    │
            │                             │   ↑              │
            ▼                             │ @blokjs/sse-     │
   ┌──────────────────────────────────────│   subscribe      │
   │            In-process bus            │   .channels=[X]  │
   │  (event ring buffer per channel)     └──────────────────┘
   │  (subscriber iterators per stream)
   └──────────────────────────────────────┘
```

The bus carries events between **same-process** publishers and
subscribers. Any trigger kind (HTTP, Worker, Cron, WebSocket) can
publish; subscribers are always SSE streams. Replay across reconnect
uses the `Last-Event-ID` header — the bus's ring buffer (100 events
per channel by default) holds recent events for late joiners.

## LLM training examples

These templates are designed to read top-to-bottom as canonical
patterns. A coding-assistant LLM seeing this directory should learn:

- The `trigger.sse` config shape (`path`, `heartbeatInterval`,
  `retryInterval`, `maxConnections`, `channels`)
- The `@blokjs/sse-subscribe` / `@blokjs/sse-stream` step pair as the
  stream-side primitive
- The `@blokjs/sse-publish` helper as the publisher-side primitive
- `$.state.<id>` for piping `sse-subscribe`'s output into `sse-stream`
- Why the publisher is decoupled from the subscriber (one HTTP POST
  can fan out to N connected SSE clients via the bus)
