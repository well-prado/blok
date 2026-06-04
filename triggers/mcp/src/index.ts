/**
 * @blokjs/trigger-mcp
 *
 * Model Context Protocol (MCP) trigger for Blok workflows. Exposes workflows as
 * MCP tools + resources to external clients (Cursor, Claude Code, …) over SSE
 * (legacy 2-endpoint) and Streamable-HTTP transports, multiplexed on the shared
 * Hono port alongside HTTP / WS / SSE / Webhook routes — same registry, same
 * runner, same Studio tracing.
 *
 * A workflow opts in with `trigger.mcp` and declares its tool input via the
 * workflow's `input` Zod schema:
 *
 * ```ts
 * import { workflow, $ } from "@blokjs/helper";
 * import { z } from "zod";
 *
 * export default workflow({
 *   name: "search_code",
 *   version: "1.0.0",
 *   input: z.object({ query: z.string() }),
 *   trigger: { mcp: { path: "/mcp", serverName: "tetrix-platform",
 *                     tool: { description: "Search the indexed codebase" } } },
 *   steps: [ { id: "s", use: "@tetrix/meili-search", inputs: { query: $.req.body.query } } ],
 * });
 * ```
 *
 * Mounting (in an app's HTTP entry, mirroring SSE/Webhook):
 *
 * ```ts
 * const mcp = new McpTrigger(httpTrigger.getApp(), httpTrigger);
 * mcp.setNodeMap({ nodes, workflows });
 * await mcp.listen();
 * ```
 */

import McpTrigger, { _getActiveMcpTrigger, _setActiveMcpTrigger, parseUserContext } from "./McpTrigger";

export default McpTrigger;
export { McpTrigger, _getActiveMcpTrigger, _setActiveMcpTrigger, parseUserContext };
export type { McpTriggerConfig, McpUserContext } from "./McpTrigger";
export type { McpTriggerOpts } from "@blokjs/helper";
