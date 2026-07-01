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

vi.mock("@opentelemetry/api", () => {
	const noop = { setAttribute: () => {}, setStatus: () => {}, recordException: () => {}, end: () => {} };
	return {
		trace: {
			getTracer: () => ({
				startActiveSpan: (...a: unknown[]) => {
					const fn = a.find((x) => typeof x === "function") as ((s: typeof noop) => unknown) | undefined;
					return fn?.(noop);
				},
				startSpan: () => noop,
			}),
			getActiveSpan: () => undefined,
			setSpan: (c: unknown) => c,
		},
		metrics: {
			getMeter: () => ({
				createCounter: () => ({ add: () => {} }),
				createHistogram: () => ({ record: () => {} }),
				createGauge: () => ({ record: () => {} }),
				createObservableGauge: () => ({ addCallback: () => {} }),
			}),
		},
		context: { active: () => ({}), with: (_c: unknown, fn: () => unknown) => fn() },
		propagation: { extract: (c: unknown) => c, inject: () => {} },
		SpanKind: { INTERNAL: 0, SERVER: 1, CLIENT: 2, PRODUCER: 3, CONSUMER: 4 },
		SpanStatusCode: { OK: 0, ERROR: 1 },
		isSpanContextValid: () => false,
	};
});

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

/**
 * Returns a payload that violates its workflow's declared `output` Zod (the
 * workflow demands `count: number`; this returns a string). The node's OWN
 * output schema is loose so the violation survives to the trigger's
 * workflow-output check rather than being caught node-side.
 */
const badShapeNode = defineNode({
	name: "bad-shape-node",
	description: "test fixture — returns a payload that violates the declared workflow.output",
	input: z.object({}).passthrough(),
	output: z.object({}).passthrough(),
	async execute() {
		return { count: "not-a-number" };
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
	// Echo whose declared `output` the result SATISFIES — exercises the
	// validation PASS branch (`return parsed.data`) when the flag is ON.
	reg.register({
		name: "validated_echo",
		source: "/test/validated-echo.ts",
		workflow: {
			name: "validated_echo",
			version: "1.0.0",
			trigger: { mcp: { path: "/mcp", serverName: "test-mcp", tool: { description: "Echo with a validated output" } } },
			input: z.object({ msg: z.string() }),
			output: z.object({ echoed: z.string(), upper: z.string() }),
			steps: [{ id: "echo", node: "echo-node", type: "module", inputs: { msg: "js/ctx.request.body.msg" } }],
			nodes: { echo: { inputs: { msg: "js/ctx.request.body.msg" } } },
		},
	});
	// Output VIOLATES the declared `output` — drives the validation-error path
	// over the SSE transport (Streamable-HTTP is covered in the sibling file).
	reg.register({
		name: "bad_output_tool",
		source: "/test/bad-output.ts",
		workflow: {
			name: "bad_output_tool",
			version: "1.0.0",
			trigger: { mcp: { path: "/mcp", serverName: "test-mcp", tool: { description: "Returns a bad count" } } },
			input: z.object({}).passthrough(),
			output: z.object({ count: z.number() }),
			steps: [{ id: "count", node: "bad-shape-node", type: "module", inputs: {} }],
			nodes: { count: { inputs: {} } },
		},
	});
}

describe("McpTrigger — integration (real MCP SDK client over SSE + Streamable-HTTP)", () => {
	let app: Hono;
	let trigger: InstanceType<typeof McpTriggerClass>;
	let httpServer: Server | null = null;
	const priorFlag = process.env.BLOK_VALIDATE_WORKFLOW_OUTPUT;

	beforeEach(async () => {
		WorkflowRegistry.resetInstance();
		_setActiveMcpTrigger(null);
		app = new Hono();

		const nodes = new NodeMap();
		nodes.addNode("echo-node", echoNode);
		nodes.addNode("whoami-node", whoamiNode);
		nodes.addNode("agents-node", agentsNode);
		nodes.addNode("bad-shape-node", badShapeNode);
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
				// Restore the validation flag so it never leaks across tests. `delete`
				// (not `= undefined`) — assigning undefined stores the literal string.
				// biome-ignore lint/performance/noDelete: env-var cleanup needs real deletion
				if (priorFlag === undefined) delete process.env.BLOK_VALIDATE_WORKFLOW_OUTPUT;
				else process.env.BLOK_VALIDATE_WORKFLOW_OUTPUT = priorFlag;
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

	it("flag ON: output that SATISFIES workflow.output passes through (validated data returned)", async () => {
		process.env.BLOK_VALIDATE_WORKFLOW_OUTPUT = "1";
		const client = new Client({ name: "test-client-valid", version: "1.0.0" }, { capabilities: {} });
		const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`));
		await client.connect(transport);

		// echo → { echoed, upper } exactly matches the declared output Zod, so the
		// call succeeds and the caller sees the validated payload (not an isError).
		const result = (await client.callTool({ name: "validated_echo", arguments: { msg: "ok" } })) as {
			content: Array<{ type: string; text: string }>;
			isError?: boolean;
		};
		expect(result.isError).toBeFalsy();
		const payload = JSON.parse(result.content[0].text) as { echoed: string; upper: string };
		expect(payload).toEqual({ echoed: "ok", upper: "OK" });

		await client.close();
	}, 20_000);

	it("flag ON over SSE: output violating workflow.output is errored, not returned", async () => {
		process.env.BLOK_VALIDATE_WORKFLOW_OUTPUT = "1";
		const client = new Client({ name: "test-client-badout-sse", version: "1.0.0" }, { capabilities: {} });
		const transport = new SSEClientTransport(new URL(`${BASE}/mcp/sse`));
		await client.connect(transport);

		const result = (await client.callTool({ name: "bad_output_tool", arguments: {} })) as {
			content: Array<{ type: string; text: string }>;
			isError?: boolean;
		};
		// The validation gate fires transport-agnostically: the SSE caller gets a
		// structured tool error, and the invalid payload is NOT echoed back.
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/output failed validation against workflow\.output/i);
		expect(result.content[0].text).not.toMatch(/"count":\s*"not-a-number"/);

		await client.close();
	}, 20_000);
});
