/**
 * One MCP-triggered workflow, so the app HAS an MCP server.
 *
 * `McpTrigger.listen()` builds its server groups from workflows carrying
 * `trigger.mcp`; with none it logs "no workflows with trigger.mcp found" and
 * mounts nothing — and the adapter's own read-only page tools (#1019), which
 * ride on every group, are then unreachable. Scenario 45 asks
 * `inertia.pages.list` for this app's pages, so the fixture declares the one
 * workflow that gives those tools somewhere to live.
 */
import { node, step, workflow } from "@blokjs/core";

export default workflow(
	"e2e-mcp-ping",
	{
		version: "1.0.0",
		trigger: { mcp: { path: "/mcp", serverName: "blok-inertia-e2e", tool: { name: "e2e.ping" } } },
	},
	() => {
		step("pong", node("@blokjs/respond"), { body: { ok: true } });
	},
);
