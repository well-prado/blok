/**
 * G3 / Route A1 — native runtime→SSE streaming integration test.
 *
 * Proves the headline pattern end-to-end over a real HTTP/SSE connection:
 * an SSE-triggered workflow runs a long `runtime.python3` node (here a
 * fake streaming adapter standing in for the Python SDK) that emits
 * incremental `PartialResult` events WHILE it runs; with `streamTo: "sse"`
 * the runner forwards each partial to the client live, before the node's
 * terminal result lands; then a finalization step emits a frame built from
 * that terminal result and closes the stream.
 *
 * Mirrors `SSETrigger.integration.test.ts` (same Hono + @hono/node-server
 * harness), but exercises the runtime-adapter path: the fake adapter is
 * injected into the process-singleton `RuntimeRegistry` via `replace()`.
 * `Configuration.initializeRuntimeRegistry` skips kinds already present
 * (`if (registry.has(kind)) continue`), so the fake survives boot.
 */

import type { Server } from "node:http";
import { NodeMap, RuntimeRegistry, WorkflowRegistry, defineNode } from "@blokjs/runner";
import type { ExecutionResult, RuntimeAdapter } from "@blokjs/runner";
import type { Context } from "@blokjs/shared";
import { serve } from "@hono/node-server";
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
			startSpan: () => ({ setAttribute: vi.fn(), setStatus: vi.fn(), recordException: vi.fn(), end: vi.fn() }),
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
	context: { active: () => ({}) },
}));

import SSETriggerClass, { _setActiveSSETrigger } from "./SSETrigger";
import { _resetBusForTests } from "./bus";

const TEST_PORT = 4903;

/** A decoded streamed event, shaped like the runner's DecodedExecuteEvent. */
type FakeEvent = { type: "partial"; snapshot: unknown } | { type: "final"; response: unknown };

/**
 * Fake `runtime.python3` adapter that emits N partials then resolves a
 * terminal result — the TS analogue of a Python node calling `ctx.emit(...)`
 * three times before `return`. `executeStream` is the surface
 * `RuntimeAdapterNode` drains when a step opts into streaming.
 */
function makeFakeAgentAdapter(partials: unknown[], finalData: unknown): RuntimeAdapter {
	const result: ExecutionResult = {
		success: true,
		data: finalData,
		errors: null,
		logs: [],
		metrics: { duration_ms: 1, cpu_ms: 0, memory_bytes: 0, request_bytes: 0, response_bytes: 0 },
		vars: {},
	};
	return {
		kind: "python3",
		transport: "grpc",
		execute: async () => result,
		executeStream: (
			_node: unknown,
			_ctx: unknown,
		): { events: AsyncIterable<FakeEvent>; result: Promise<ExecutionResult> } => {
			const events: AsyncIterable<FakeEvent> = {
				[Symbol.asyncIterator]: async function* () {
					for (const snapshot of partials) {
						// Small yield so the partials interleave like a real stream.
						await new Promise((r) => setTimeout(r, 5));
						yield { type: "partial", snapshot } as FakeEvent;
					}
				},
			};
			return { events, result: Promise.resolve(result) };
		},
	} as unknown as RuntimeAdapter;
}

/**
 * Finalization node — emits one frame from the agent's terminal result and
 * closes the stream so the client's body ends deterministically.
 */
const finalizeNode = defineNode({
	name: "finalize",
	description: "test fixture — emit a `complete` frame from the agent result then close the stream",
	input: z.object({ answer: z.string() }),
	output: z.object({ done: z.literal(true) }),
	async execute(ctx, input) {
		if (!ctx.stream) throw new Error("no ctx.stream");
		await ctx.stream.writeSSE({ event: "complete", data: { answer: input.answer }, id: "final" });
		ctx.stream.close();
		return { done: true as const };
	},
});

describe("runtime → SSE live streaming (G3 / Route A1, real HTTP/SSE)", () => {
	let app: Hono;
	let trigger: InstanceType<typeof SSETriggerClass>;
	let httpServer: Server | null = null;

	beforeEach(() => {
		WorkflowRegistry.resetInstance();
		_setActiveSSETrigger(null);
		_resetBusForTests();
		app = new Hono();
	});

	afterEach(
		() =>
			new Promise<void>((resolve) => {
				if (trigger) void trigger.stop();
				_resetBusForTests();
				if (httpServer) {
					httpServer.close(() => {
						httpServer = null;
						WorkflowRegistry.resetInstance();
						_setActiveSSETrigger(null);
						resolve();
					});
				} else {
					WorkflowRegistry.resetInstance();
					_setActiveSSETrigger(null);
					resolve();
				}
			}),
	);

	it("forwards 3 live runtime partials then a finalization frame, in order, on one connection", async () => {
		// Inject the fake agent adapter BEFORE the trigger boots. `replace()`
		// wins over Configuration's `has()`-guarded built-in registration.
		RuntimeRegistry.getInstance().replace(
			makeFakeAgentAdapter(
				[
					{ event: "text", data: { delta: "Hel" }, id: "1" },
					{ event: "text", data: { delta: "lo" }, id: "2" },
					{ event: "source", data: { url: "https://example.com" }, id: "3" },
				],
				{ answer: "Hello" },
			),
		);

		const nodes = new NodeMap();
		nodes.addNode("finalize", finalizeNode);

		WorkflowRegistry.getInstance().register({
			name: "agent-chat",
			source: "/test/agent-chat.json",
			workflow: {
				name: "agent-chat",
				version: "1.0.0",
				trigger: { sse: { path: "/sse/chat" } },
				steps: [
					// The long runtime node — streams partials live to the client.
					{ id: "agent", node: "agent", type: "runtime.python3", streamTo: "sse", inputs: {} },
					// Finalization — emits a frame from the terminal result, closes stream.
					{ id: "finalize", node: "finalize", type: "module", inputs: { answer: "js/ctx.state.agent.answer" } },
				],
				nodes: {
					agent: { inputs: {} },
					finalize: { inputs: { answer: "js/ctx.state.agent.answer" } },
				},
			},
		});

		trigger = new SSETriggerClass(app);
		trigger.setNodeMap({ nodes });
		await trigger.listen();

		await new Promise<void>((resolve) => {
			httpServer = serve({ fetch: app.fetch, port: TEST_PORT }, () => resolve()) as Server;
		});

		const controller = new AbortController();
		const response = await fetch(`http://localhost:${TEST_PORT}/sse/chat`, {
			headers: { Accept: "text/event-stream" },
			signal: controller.signal,
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toMatch(/text\/event-stream/);

		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		let buf = "";
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline) {
			const { value, done } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
		}
		controller.abort();

		// Collect (event, data) pairs in frame order.
		const frames = buf
			.split("\n\n")
			.map((block) => {
				const lines = block.split("\n");
				const event = lines
					.find((l) => l.startsWith("event:"))
					?.slice("event:".length)
					.trim();
				const dataLine = lines
					.find((l) => l.startsWith("data:"))
					?.slice("data:".length)
					.trim();
				return event && dataLine ? { event, data: JSON.parse(dataLine) } : null;
			})
			.filter((f): f is { event: string; data: unknown } => f !== null);

		expect(frames).toEqual([
			{ event: "text", data: { delta: "Hel" } },
			{ event: "text", data: { delta: "lo" } },
			{ event: "source", data: { url: "https://example.com" } },
			{ event: "complete", data: { answer: "Hello" } },
		]);
	}, 15_000);

	it("stops client writes on disconnect mid-stream but the run still completes", async () => {
		const seen: string[] = [];
		// A finalize node that records it ran — proving the run reached the end
		// even though the client disconnected during the partial stream.
		const recordFinalize = defineNode({
			name: "finalize",
			description: "test fixture — record completion",
			input: z.object({}),
			output: z.object({ done: z.literal(true) }),
			async execute(ctx) {
				seen.push("finalize-ran");
				ctx.stream?.close();
				return { done: true as const };
			},
		});

		RuntimeRegistry.getInstance().replace(
			makeFakeAgentAdapter(
				[
					{ event: "text", data: { delta: "a" }, id: "1" },
					{ event: "text", data: { delta: "b" }, id: "2" },
					{ event: "text", data: { delta: "c" }, id: "3" },
				],
				{ answer: "abc" },
			),
		);

		const nodes = new NodeMap();
		nodes.addNode("finalize", recordFinalize);

		WorkflowRegistry.getInstance().register({
			name: "agent-chat-2",
			source: "/test/agent-chat-2.json",
			workflow: {
				name: "agent-chat-2",
				version: "1.0.0",
				trigger: { sse: { path: "/sse/chat2" } },
				steps: [
					{ id: "agent", node: "agent", type: "runtime.python3", streamTo: "sse", inputs: {} },
					{ id: "finalize", node: "finalize", type: "module", inputs: {} },
				],
				nodes: { agent: { inputs: {} }, finalize: { inputs: {} } },
			},
		});

		trigger = new SSETriggerClass(app);
		trigger.setNodeMap({ nodes });
		await trigger.listen();
		await new Promise<void>((resolve) => {
			httpServer = serve({ fetch: app.fetch, port: TEST_PORT }, () => resolve()) as Server;
		});

		const controller = new AbortController();
		const response = await fetch(`http://localhost:${TEST_PORT}/sse/chat2`, {
			headers: { Accept: "text/event-stream" },
			signal: controller.signal,
		});
		const reader = response.body!.getReader();
		// Read just the first frame, then disconnect.
		await reader.read();
		controller.abort();
		await reader.cancel().catch(() => {});

		// Give the server time to drain the rest of the stream + run finalize.
		await new Promise((r) => setTimeout(r, 300));

		expect(seen).toContain("finalize-ran");
	}, 15_000);
});
