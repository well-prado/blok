/**
 * ADR 0015 — MCP input validation (the trigger-boundary half).
 *
 * `TriggerBase.run` now validates the request body against the workflow's
 * declared `input` Zod (read live off the WorkflowRegistry entry, same source
 * MCP advertises as the tool's `inputSchema`). A malformed call THROWS a
 * GlobalError(400) inside `run`; `dispatchTool` catches it and returns a
 * structured MCP tool-error result (`isError: true`) — NOT a transport crash.
 * A valid call has its body REPLACED with the parsed value, so Zod `.default()`s
 * are applied. Kill switch: `BLOK_VALIDATE_WORKFLOW_INPUT=0`.
 *
 * Driven end-to-end through the REAL MCP SDK client over Streamable-HTTP (same
 * harness as McpTrigger.output-validation.test.ts) — the assertion is on the
 * client-observed envelope, not an internal call.
 */

import type { Server } from "node:http";
import { NodeMap, WorkflowRegistry, defineNode } from "@blokjs/runner";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
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

let nextPort = 4981;
let BASE = `http://localhost:${nextPort}`;

/** Echoes the (post-validation) request body so tests can assert defaults applied. */
const echoBodyNode = defineNode({
	name: "echo-body-node",
	description: "test fixture — returns the request body as seen by the node",
	input: z.object({}).passthrough(),
	output: z.object({}).passthrough(),
	async execute(ctx) {
		return (ctx.request?.body ?? {}) as Record<string, unknown>;
	},
});

/** A workflow declaring an `input` schema with a required field and a default. */
function registerValidatedWorkflow(): void {
	WorkflowRegistry.getInstance().register({
		name: "search_tool",
		source: "/test/search.ts",
		workflow: {
			name: "search_tool",
			version: "1.0.0",
			trigger: { mcp: { path: "/mcp", serverName: "validate-mcp", tool: { description: "Search" } } },
			input: z.object({ query: z.string(), page: z.number().default(1) }),
			steps: [{ id: "echo", node: "echo-body-node", type: "module", inputs: {} }],
			nodes: { echo: { inputs: {} } },
		},
	});
}

async function callSearch(
	args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
	const client = new Client({ name: "test-validate-input", version: "1.0.0" }, { capabilities: {} });
	const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`));
	await client.connect(transport);
	const result = (await client.callTool({ name: "search_tool", arguments: args })) as {
		content: Array<{ type: string; text: string }>;
		isError?: boolean;
	};
	await client.close();
	return result;
}

describe("McpTrigger — workflow input validation (ADR 0015)", () => {
	let app: Hono;
	let trigger: InstanceType<typeof McpTriggerClass>;
	let httpServer: Server | null = null;
	const priorFlag = process.env.BLOK_VALIDATE_WORKFLOW_INPUT;

	beforeEach(async () => {
		WorkflowRegistry.resetInstance();
		_setActiveMcpTrigger(null);
		app = new Hono();

		const nodes = new NodeMap();
		nodes.addNode("echo-body-node", echoBodyNode);
		registerValidatedWorkflow();

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
				// biome-ignore lint/performance/noDelete: env-var cleanup needs real deletion
				if (priorFlag === undefined) delete process.env.BLOK_VALIDATE_WORKFLOW_INPUT;
				else process.env.BLOK_VALIDATE_WORKFLOW_INPUT = priorFlag;
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

	it("malformed args → structured MCP error (isError), naming the offending field", async () => {
		const result = await callSearch({ page: "not-a-number" }); // missing `query`, wrong `page` type

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/input validation failed/i);
		expect(result.content[0].text).toMatch(/query/);
	}, 20_000);

	it("valid args → success, with Zod defaults applied to the body the node sees", async () => {
		const result = await callSearch({ query: "hello" }); // `page` omitted → default 1

		expect(result.isError).toBeFalsy();
		const body = JSON.parse(result.content[0].text) as { query: string; page: number };
		expect(body).toEqual({ query: "hello", page: 1 });
	}, 20_000);

	it("kill switch: BLOK_VALIDATE_WORKFLOW_INPUT=0 lets malformed args through", async () => {
		process.env.BLOK_VALIDATE_WORKFLOW_INPUT = "0";
		const result = await callSearch({ page: "not-a-number" });

		// No gate → the raw (unvalidated, un-defaulted) body reaches the node.
		expect(result.isError).toBeFalsy();
		const body = JSON.parse(result.content[0].text) as Record<string, unknown>;
		expect(body).toEqual({ page: "not-a-number" });
	}, 20_000);
});
