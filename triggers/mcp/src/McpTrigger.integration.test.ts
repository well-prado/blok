/**
 * MCP trigger end-to-end integration test.
 *
 * Spins up a real Hono app + `@hono/node-server` with a real McpTrigger, then
 * drives it with the official MCP SDK **client** over BOTH transports:
 *   - SSE (GET /mcp/sse + POST /mcp/messages)
 *   - Streamable-HTTP (POST /mcp)
 *
 * Asserts the client can list tools (with an inputSchema generated from the
 * workflow's Zod `input`) and call a tool that runs through the runner and
 * returns the workflow's `ctx.response.data`.
 */

import type { Server } from "node:http";
import { NodeMap, WorkflowRegistry, defineNode } from "@blokjs/runner";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("@opentelemetry/api", () => ({
	trace: {
		getTracer: () => ({
			startActiveSpan: (_name: string, fn: (span: unknown) => unknown) =>
				fn({
					setAttribute: vi.fn(),
					setStatus: vi.fn(),
					recordException: vi.fn(),
					end: vi.fn(),
				}),
		}),
	},
	metrics: {
		getMeter: () => ({
			createCounter: () => ({ add: vi.fn() }),
			createHistogram: () => ({ record: vi.fn() }),
			createGauge: () => ({ record: vi.fn() }),
			createObservableGauge: () => ({ addCallback: vi.fn() }),
		}),
	},
	SpanStatusCode: { OK: 0, ERROR: 1 },
}));

import McpTriggerClass, { _setActiveMcpTrigger } from "./McpTrigger";

// Unique port per test — avoids same-port sequential-teardown (ECONNRESET /
// TIME_WAIT) races when several real HTTP servers start/stop in a row.
let nextPort = 4913;
let BASE = `http://localhost:${nextPort}`;

/** Inline tool node — echoes the input back so we can assert the round-trip. */
const echoNode = defineNode({
	name: "echo-node",
	description: "test fixture — echo the input",
	input: z.object({ msg: z.string() }),
	output: z.object({ echoed: z.string(), upper: z.string() }),
	async execute(_ctx, input) {
		return { echoed: input.msg, upper: input.msg.toUpperCase() };
	},
});

/** Returns the caller identity from the parsed x-user-context (credential injection). */
const whoamiNode = defineNode({
	name: "whoami-node",
	description: "test fixture — echo the caller identity",
	input: z.object({}).passthrough(),
	output: z.object({ userId: z.string().optional(), email: z.string().optional() }),
	async execute(ctx) {
		const raw = (ctx.request?.headers as Record<string, string> | undefined)?.["x-user-context"];
		if (!raw) return {};
		const d = JSON.parse(Buffer.from(raw, "base64").toString("utf-8")) as { userId?: string; email?: string };
		return { userId: d.userId, email: d.email };
	},
});

/** Resource body provider. */
const agentsNode = defineNode({
	name: "agents-node",
	description: "test fixture — resource body",
	input: z.object({}).passthrough(),
	output: z.object({ agents: z.array(z.string()) }),
	async execute() {
		return { agents: ["codebase", "infra"] };
	},
});

function registerWorkflows(): void {
	const reg = WorkflowRegistry.getInstance();
	reg.register({
		name: "echo_tool",
		source: "/test/echo.ts",
		workflow: {
			name: "echo_tool",
			version: "1.0.0",
			trigger: {
				mcp: {
					path: "/mcp",
					serverName: "test-mcp",
					serverVersion: "1.0.0",
					transports: ["sse", "streamable-http"],
					tool: { description: "Echo the input back" },
				},
			},
			input: z.object({ msg: z.string().describe("Message to echo") }),
			steps: [{ id: "echo", node: "echo-node", type: "module", inputs: { msg: "js/ctx.request.body.msg" } }],
			nodes: { echo: { inputs: { msg: "js/ctx.request.body.msg" } } },
		},
	});
	reg.register({
		name: "whoami",
		source: "/test/whoami.ts",
		workflow: {
			name: "whoami",
			version: "1.0.0",
			trigger: { mcp: { path: "/mcp", serverName: "test-mcp", tool: { description: "Who am I" } } },
			steps: [{ id: "who", node: "whoami-node", type: "module", inputs: {} }],
			nodes: { who: { inputs: {} } },
		},
	});
	reg.register({
		name: "agents_resource",
		source: "/test/agents.ts",
		workflow: {
			name: "agents_resource",
			version: "1.0.0",
			trigger: {
				mcp: {
					path: "/mcp",
					serverName: "test-mcp",
					resource: { uri: "test://agents", name: "Agents", mimeType: "application/json" },
				},
			},
			steps: [{ id: "a", node: "agents-node", type: "module", inputs: {} }],
			nodes: { a: { inputs: {} } },
		},
	});
}

describe("McpTrigger — integration (real MCP SDK client over SSE + Streamable-HTTP)", () => {
	let app: Hono;
	let trigger: InstanceType<typeof McpTriggerClass>;
	let httpServer: Server | null = null;

	beforeEach(async () => {
		WorkflowRegistry.resetInstance();
		_setActiveMcpTrigger(null);
		app = new Hono();

		const nodes = new NodeMap();
		nodes.addNode("echo-node", echoNode);
		nodes.addNode("whoami-node", whoamiNode);
		nodes.addNode("agents-node", agentsNode);
		registerWorkflows();

		trigger = new McpTriggerClass(app);
		trigger.setNodeMap({ nodes });
		await trigger.listen();

		const port = nextPort++;
		BASE = `http://localhost:${port}`;
		await new Promise<void>((resolve) => {
			httpServer = serve({ fetch: app.fetch, port }, () => resolve()) as Server;
		});
	});

	afterEach(
		() =>
			new Promise<void>((resolve) => {
				if (trigger) void trigger.stop();
				if (httpServer) {
					httpServer.close(() => {
						httpServer = null;
						WorkflowRegistry.resetInstance();
						_setActiveMcpTrigger(null);
						resolve();
					});
				} else {
					WorkflowRegistry.resetInstance();
					_setActiveMcpTrigger(null);
					resolve();
				}
			}),
	);

	it("lists + calls a tool over Streamable-HTTP", async () => {
		const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
		const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`));
		await client.connect(transport);

		const tools = await client.listTools();
		expect(tools.tools.map((t) => t.name)).toContain("echo_tool");
		const echo = tools.tools.find((t) => t.name === "echo_tool");
		expect(echo?.description).toBe("Echo the input back");
		// inputSchema generated from the workflow's Zod input
		expect(echo?.inputSchema?.type).toBe("object");
		expect(Object.keys((echo?.inputSchema?.properties ?? {}) as object)).toContain("msg");

		const result = (await client.callTool({ name: "echo_tool", arguments: { msg: "hello" } })) as {
			content: Array<{ type: string; text: string }>;
			isError?: boolean;
		};
		expect(result.isError).toBeFalsy();
		const payload = JSON.parse(result.content[0].text) as { echoed: string; upper: string };
		expect(payload).toEqual({ echoed: "hello", upper: "HELLO" });

		await client.close();
	}, 20_000);

	it("lists + calls a tool over SSE (GET /mcp/sse + POST /mcp/messages)", async () => {
		const client = new Client({ name: "test-client-sse", version: "1.0.0" }, { capabilities: {} });
		const transport = new SSEClientTransport(new URL(`${BASE}/mcp/sse`));
		await client.connect(transport);

		const tools = await client.listTools();
		expect(tools.tools.map((t) => t.name)).toContain("echo_tool");

		const result = (await client.callTool({ name: "echo_tool", arguments: { msg: "world" } })) as {
			content: Array<{ type: string; text: string }>;
			isError?: boolean;
		};
		expect(result.isError).toBeFalsy();
		const payload = JSON.parse(result.content[0].text) as { echoed: string; upper: string };
		expect(payload).toEqual({ echoed: "world", upper: "WORLD" });

		await client.close();
	}, 20_000);

	it("returns an MCP tool error (not a transport crash) for an unknown tool", async () => {
		const client = new Client({ name: "test-client-err", version: "1.0.0" }, { capabilities: {} });
		const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`));
		await client.connect(transport);

		const result = (await client.callTool({ name: "does_not_exist", arguments: {} })) as {
			content: Array<{ type: string; text: string }>;
			isError?: boolean;
		};
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/unknown tool/i);

		await client.close();
	}, 20_000);

	it("lists + reads an MCP resource", async () => {
		const client = new Client({ name: "test-client-res", version: "1.0.0" }, { capabilities: {} });
		const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`));
		await client.connect(transport);

		const resources = await client.listResources();
		expect(resources.resources.map((r) => r.uri)).toContain("test://agents");

		const read = await client.readResource({ uri: "test://agents" });
		const payload = JSON.parse(read.contents[0].text as string) as { agents: string[] };
		expect(payload.agents).toEqual(["codebase", "infra"]);

		await client.close();
	}, 20_000);

	it("parses x-user-context and passes it to the workflow ctx", async () => {
		const userCtx = Buffer.from(JSON.stringify({ userId: "u-1", email: "dev@tetrix.io" }), "utf-8").toString("base64");
		const client = new Client({ name: "test-client-ctx", version: "1.0.0" }, { capabilities: {} });
		const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
			requestInit: { headers: { "x-user-context": userCtx } },
		});
		await client.connect(transport);

		const result = (await client.callTool({ name: "whoami", arguments: {} })) as {
			content: Array<{ type: string; text: string }>;
		};
		const payload = JSON.parse(result.content[0].text) as { userId?: string; email?: string };
		expect(payload).toEqual({ userId: "u-1", email: "dev@tetrix.io" });

		await client.close();
	}, 20_000);
});
