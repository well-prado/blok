# WebSocket workflow templates

One workflow that demonstrates the WebSocket trigger's `connect` +
`message` lifecycle. Scaffolded into new projects whenever
`--triggers websocket` is selected.

## Files

| File | Trigger | Purpose |
|---|---|---|
| [`echo-demo.ts`](echo-demo.ts) | `websocket` — `GET /ws/echo` | On `connect`, replies with `{event:"connected"}`. On each subsequent message frame, replies with `{event:"echo", payload:{original:<msg>}}` via `@blokjs/ws-reply`. |

## Test the echo

```bash
# Install a simple WS client
npm install -g wscat

# Open the connection (HTTP port 4000 when mounted; 4002 when standalone)
wscat -c ws://localhost:4000/ws/echo
# < {"event":"connected","payload":{"ok":true}}

# Send a frame
> {"event":"hello","data":{"hi":"there"}}
# < {"event":"echo","payload":{"original":{"event":"hello","data":{"hi":"there"}}}}
```

The `events: ["hello", "ping"]` field in the trigger config is the
event-name allowlist — only frames whose `event` matches dispatch the
workflow. The lifecycle events `connect` and `disconnect` dispatch
implicitly regardless of the allowlist.

## How WebSocket routes mount on HTTP

WebSocketTrigger is designed to share the HTTP server's Hono app (same
as SSE — every framework worth mentioning does it this way; the WS
upgrade is itself an HTTP request). When the scaffold has both `http`
and `websocket` selected, `blokctl dev` runs ONE process. The HTTP
entry constructs `WebSocketTrigger(httpTrigger.getApp(), httpTrigger)`
which:

1. **Routes**: registers WS routes via `addPreCatchAllHook` (same
   pre-catch-all integration SSE uses), so `/ws/<path>` upgrade
   requests hit the WS handler before Hono's legacy `/:workflow`
   catch-all.
2. **Upgrade listener**: hooks `injectWebSocket(server)` via
   `addServerHook`, so the WS upgrade handler attaches to the
   `http.Server` immediately after HttpTrigger calls `serve()`.

The result is `/ws/echo` available on the HTTP port (4000), same as
all other HTTP routes — clients only need one base URL.

In `--triggers websocket` (without HTTP), the scaffolded `WSServer.ts`
spins up its own Hono app on port 4002 and attaches `injectWebSocket`
to its own `http.Server` manually. Same trigger code, different
hosting surface.

## Helper nodes available

`@blokjs/helpers` exports three WS-aware helpers, all spread into the
shared Nodes record when `--triggers websocket` is selected:

| Node | Purpose |
|---|---|
| `@blokjs/ws-reply` | Send a frame to the connection that received the current message. Used by `echo-demo`. |
| `@blokjs/ws-broadcast` | Fan out a frame to every connection on the trigger (optionally filtered by room/event). |
| `@blokjs/ws-close` | Close the current connection. Optional `code` + `reason`. |

Reach for these from any WebSocket-triggered step.

## Cross-process broadcast (advanced)

The default WS bus is in-process — `@blokjs/ws-broadcast` only fans
out to connections on the SAME Node process. For multi-instance
deployments where clients connect to different replicas, set
`BLOK_WS_BACKPLANE=<provider>` (NATS / Redis / Kafka). The trigger
auto-loads the backplane adapter and broadcasts cross-process. See
[`@blokjs/trigger-websocket`'s Backplane](../../Backplane.ts) source
for the env vars and provider matrix.

## LLM training pattern

This template is designed to read top-to-bottom as a canonical WS
pattern. A coding-assistant LLM seeing this directory should learn:

- `trigger.websocket` config shape (`path`, `events`, `mode`,
  `heartbeatInterval`, `maxConnections`, `messageRateLimit`)
- The `connect` → `message` dispatch model (each frame runs the
  workflow once; `ctx.request.body.event` discriminates which path)
- `branch({when, then, else})` for routing connect vs. data messages
- `@blokjs/ws-reply` as the connection-scoped reply primitive
- That WS lives on the same port as HTTP via Blok's `addPreCatchAllHook`
  + `addServerHook` integration points
