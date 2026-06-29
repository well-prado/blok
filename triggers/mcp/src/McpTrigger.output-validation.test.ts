/**
 * #437 — MCP output validation (the runtime half of the #436 deliverable).
 *
 * `runWorkflow` validates a tool's result against the workflow's declared
 * `output` Zod ONLY when `BLOK_VALIDATE_WORKFLOW_OUTPUT` is on. A failure THROWS
 * inside `runWorkflow`; `dispatchTool` catches it and returns a structured MCP
 * tool-error result (`isError: true`) — NOT a transport-level 500 / crash. With
 * the flag OFF (default), the raw `ctx.response.data` passes through untouched,
 * even when it would violate the declared `output` schema.
 *
 * Driven end-to-end through the REAL MCP SDK client over Streamable-HTTP (the
 * same harness as McpTrigger.integration.test.ts), so the assertion is on the
 * client-observed result envelope — the honest "what does the MCP caller see"
 * boundary, not an internal call to the private `dispatchTool`.
 *
 * Adversarial: the node deliberately returns a payload that the workflow's
 * `output` Zod rejects (a `count: string` where the schema demands a number).
 * Flag-on => isError + the validation message; flag-off => the bad payload is
 * echoed straight back with no error.
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

let nextPort = 4951;
let BASE = `http://localhost:${nextPort}`;

/**
 * The node's RUNTIME output deliberately violates the workflow's declared
 * `output` Zod (it returns `count` as a string, schema wants a number). The
 * node's OWN output schema is loose (passthrough) so the violation survives to
 * the trigger's workflow-output check rather than being caught node-side.
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

/** A workflow declaring an `output` the node's result will fail (count must be a number). */
function registerValidatedWorkflow(): void {
	const reg = WorkflowRegistry.getInstance();
	reg.register({
		name: "counter_tool",
		source: "/test/counter.ts",
		workflow: {
			name: "counter_tool",
			version: "1.0.0",
			trigger: { mcp: { path: "/mcp", serverName: "validate-mcp", tool: { description: "Returns a count" } } },
			input: z.object({}).passthrough(),
			output: z.object({ count: z.number() }),
			steps: [{ id: "count", node: "bad-shape-node", type: "module", inputs: {} }],
			nodes: { count: { inputs: {} } },
		},
	});
}

async function callCounter(): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
	const client = new Client({ name: "test-validate", version: "1.0.0" }, { capabilities: {} });
	const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`));
	await client.connect(transport);
	const result = (await client.callTool({ name: "counter_tool", arguments: {} })) as {
		content: Array<{ type: string; text: string }>;
		isError?: boolean;
	};
	await client.close();
	return result;
}

describe("McpTrigger — workflow output validation (#437)", () => {
	let app: Hono;
	let trigger: InstanceType<typeof McpTriggerClass>;
	let httpServer: Server | null = null;
	const priorFlag = process.env.BLOK_VALIDATE_WORKFLOW_OUTPUT;

	beforeEach(async () => {
		WorkflowRegistry.resetInstance();
		_setActiveMcpTrigger(null);
		app = new Hono();

		const nodes = new NodeMap();
		nodes.addNode("bad-shape-node", badShapeNode);
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
				// Restore the flag so cross-test state never leaks. `delete` (not
				// `= undefined`) — assigning undefined stores the literal string
				// "undefined", which would not faithfully restore an unset env var.
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

	it("flag ON: output violating workflow.output yields a structured MCP error (isError), NOT a 500", async () => {
		process.env.BLOK_VALIDATE_WORKFLOW_OUTPUT = "1";

		// The call completes (the transport does NOT crash) and the caller observes
		// a tool-error envelope — proof the validation failure is surfaced as an MCP
		// error result, never an unhandled transport 500.
		const result = await callCounter();

		expect(result.isError).toBe(true);
		expect(result.content[0].type).toBe("text");
		// The message names the workflow + that it failed against workflow.output.
		expect(result.content[0].text).toMatch(/output failed validation against workflow\.output/i);
		// It must NOT have leaked the raw (invalid) payload as a success.
		expect(result.content[0].text).not.toMatch(/"count":\s*"not-a-number"/);
	}, 20_000);

	it("flag OFF: raw passthrough — the violating payload is returned untouched, no error", async () => {
		// Default: flag unset. The declared output is ignored; raw data passes through.
		// biome-ignore lint/performance/noDelete: must fully unset the env var, not store "undefined"
		delete process.env.BLOK_VALIDATE_WORKFLOW_OUTPUT;

		const result = await callCounter();

		expect(result.isError).toBeFalsy();
		const payload = JSON.parse(result.content[0].text) as { count: unknown };
		// The bad shape survives untouched — no validation gate when the flag is off.
		expect(payload).toEqual({ count: "not-a-number" });
	}, 20_000);
});
