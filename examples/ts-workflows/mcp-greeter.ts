import { workflow } from "@blokjs/helper";
import { z } from "zod";

/**
 * MCP example — exposes this workflow to MCP clients (Cursor, Claude, …) as a
 * tool named "greet".
 *
 * Ships only when the project is scaffolded with the `mcp` trigger. On
 * `blokctl dev` an MCP server mounts on the HTTP port at `/mcp`
 * (SSE: GET /mcp/sse + POST /mcp/messages, and Streamable-HTTP: POST /mcp).
 * Clients see a `greet` tool whose JSON inputSchema is derived from the
 * top-level `input` Zod schema below. `tools/call` arguments arrive on
 * `ctx.request.body`, and the MCP result is the final step's `ctx.response.data`.
 *
 * This is a `runtime.*`-free, in-process example: a single `@blokjs/expr` step
 * builds the greeting object, so no external SDK container is required.
 */
export default workflow({
	name: "mcp-greeter",
	version: "1.0.0",
	description: "MCP tool that greets a person by name.",

	// Becomes the MCP tool's JSON-Schema inputSchema (via zod-to-json-schema).
	input: z.object({
		name: z.string().min(1).describe("Name of the person to greet"),
		excited: z.boolean().default(false).describe("End the greeting with '!' instead of '.'"),
	}),

	output: z.object({
		greeting: z.string(),
	}),

	trigger: {
		mcp: {
			path: "/mcp",
			serverName: "blok-examples",
			serverVersion: "1.0.0",
			transports: ["sse", "streamable-http"],
			tool: {
				name: "greet",
				description: "Greet a person by name. Pass { name, excited? }.",
			},
		},
	},

	steps: [
		{
			// `@blokjs/expr` evaluates the plain-JS expression against the live
			// ctx and returns its result as this step's data — which is what the
			// MCP trigger sends back as the tool result (ctx.response.data).
			id: "greet",
			use: "@blokjs/expr",
			inputs: {
				expression:
					'({ greeting: "Hello, " + (ctx.request.body.name || "there") + (ctx.request.body.excited ? "!" : ".") })',
			},
		},
	],
});
