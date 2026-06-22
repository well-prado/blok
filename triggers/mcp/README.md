# @blokjs/trigger-mcp

Model Context Protocol (MCP) trigger for [Blok](https://github.com/well-prado/blok)
workflows. Expose a workflow as an MCP **tool** or **resource** so AI
clients — Claude Code, Cursor, Claude Desktop, or your own agent — can
discover and call it. Serves both transports (Streamable-HTTP + legacy
SSE) on the shared Hono HTTP port.

> **Full reference:** [Blok docs → Triggers → MCP](https://github.com/well-prado/blok/blob/main/docs/d/triggers/mcp.mdx)

## What it does

- Scans the workflow registry for workflows with a `trigger.mcp` block and
  exposes each one to MCP clients.
- Generates each tool's JSON `inputSchema` from the workflow's Zod `input`
  (via `zod-to-json-schema`).
- Runs `tools/call` / `resources/read` through the normal Blok runner — so
  retries, idempotency, middleware, cancellation, and Studio tracing all
  apply.
- Mounts on the HTTP trigger's Hono app (same port, same process). No
  separate listener.

## Authoring a tool

A `trigger.mcp` workflow is a normal v2 workflow. The `input` schema is the
tool contract; the final step's output is the tool result.

```ts
import { workflow } from "@blokjs/helper";
import { z } from "zod";

export default workflow({
  name: "mcp-greeter",
  version: "1.0.0",
  input: z.object({
    name: z.string().min(1).describe("Name of the person to greet"),
    excited: z.boolean().default(false),
  }),
  trigger: {
    mcp: {
      path: "/mcp",
      serverName: "blok-examples",
      tool: { name: "greet", description: "Greet a person by name." },
    },
  },
  steps: [
    {
      id: "greet",
      use: "@blokjs/expr",
      inputs: {
        expression:
          '({ greeting: "Hello, " + (ctx.request.body.name || "there") + (ctx.request.body.excited ? "!" : ".") })',
      },
    },
  ],
});
```

Scaffold a project with this exact example:

```bash
npx blokctl@latest create project --triggers http,mcp --examples
```

## Transports & routes

Both default on; override per workflow with `transports: [...]`.

| Transport | Route(s) | State |
| --- | --- | --- |
| Streamable-HTTP | `ALL <path>` (e.g. `POST /mcp`) | Stateless |
| SSE (legacy) | `GET <path>/sse` + `POST <path>/messages?sessionId=…` | Stateful |

On start the trigger logs each mounted server and route:

```
[blok][mcp] server "blok-examples" at /mcp — 1 tool(s), 0 resource(s), transports=[sse,streamable-http]
[blok][mcp]   GET  /mcp/sse   POST /mcp/messages  (sse)
[blok][mcp]   ALL  /mcp  (streamable-http)
```

## Connecting a client

Give the client the URL `http://localhost:4000/mcp` (Streamable-HTTP) or
`http://localhost:4000/mcp/sse` (SSE).

```bash
# Claude Code
claude mcp add --transport http blok http://localhost:4000/mcp

# Interactive debugging
npx @modelcontextprotocol/inspector   # → connect to http://localhost:4000/mcp
```

```json
// Cursor — .cursor/mcp.json
{ "mcpServers": { "blok": { "url": "http://localhost:4000/mcp" } } }
```

Raw JSON-RPC (send `Accept: application/json, text/event-stream`):

```bash
curl -sS http://localhost:4000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"greet","arguments":{"name":"Ada","excited":true}}}'
```

## Config reference

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `path` | `string` | `"/mcp"` | Base path; workflows sharing a path aggregate into one server. |
| `serverName` | `string` | `"blok-mcp"` | Advertised to clients — set something project-specific. |
| `serverVersion` | `string` | `"1.0.0"` | Advertised server version. |
| `transports` | `("sse" \| "streamable-http")[]` | both | At least one required. |
| `tool` | `{ name?, description? }` | — | Tool mode (default). `name` defaults to the workflow name. |
| `resource` | `{ uri, name?, description?, mimeType? }` | — | Resource mode. `uri` required; `mimeType` defaults to `application/json`. |
| `middleware` | `string[]` | — | Trigger-level middleware chain. |

## Identity is not authorization

An `x-user-context` header (base64 `{ userId, email }`) or `?user_context=`
query param is parsed and exposed at `ctx._mcp.userContext`. This is
**credential injection only** — the trigger does not verify it or scope
access. Enforce authorization yourself via trigger middleware or an auth
proxy in front of the endpoint.

## License

Part of the Blok framework. See the repository root for license details.
