import type { Context } from "@blokjs/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RunnerNode from "../../src/RunnerNode";
import { RuntimeAdapterNode } from "../../src/RuntimeAdapterNode";
import type { ExecutionResult, RuntimeAdapter } from "../../src/adapters/RuntimeAdapter";
import type { DecodedExecuteEvent } from "../../src/adapters/grpc/GrpcCodec";
import { RunTracker } from "../../src/tracing/RunTracker";

class TargetNode extends RunnerNode {
	async run() {
		return { success: true, data: null, error: null };
	}
}

function makeTarget(name = "step-x"): RunnerNode {
	const n = new TargetNode();
	n.name = name;
	n.node = name;
	n.type = "runtime.python3";
	return n;
}

function makeCtx(traceRunId: string | null = null, traceNodeId: string | null = null): Context {
	const ctx = {
		id: "ctx-1",
		workflow_name: "wf",
		workflow_path: "/wf",
		request: {
			body: null,
			headers: {},
			params: {},
			query: {},
			cookies: {},
			method: "POST",
			url: "/wf",
			baseUrl: "",
		} as unknown as Context["request"],
		response: { data: null, contentType: "application/json", success: true, error: null },
		error: { message: [] },
		logger: { log: () => {}, error: () => {} } as unknown as Context["logger"],
		config: {} as unknown as Context["config"],
		vars: {},
		env: {} as unknown as Context["env"],
		eventLogger: null,
		_PRIVATE_: null,
	} as Context;
	if (traceRunId) (ctx as Record<string, unknown>)._traceRunId = traceRunId;
	if (traceNodeId) (ctx as Record<string, unknown>)._traceNodeId = traceNodeId;
	return ctx;
}

const successResult: ExecutionResult = {
	success: true,
	data: { ok: true },
	errors: null,
	logs: [],
	metrics: { duration_ms: 1, cpu_ms: 0, memory_bytes: 0, request_bytes: 0, response_bytes: 0 },
	vars: {},
};

interface FakeStreamingAdapter extends RuntimeAdapter {
	executeStream: (
		node: RunnerNode,
		ctx: Context,
	) => { events: AsyncIterable<DecodedExecuteEvent>; result: Promise<ExecutionResult> };
}

function makeStreamingAdapter(events: DecodedExecuteEvent[], result: ExecutionResult): FakeStreamingAdapter {
	return {
		kind: "python3",
		transport: "grpc",
		execute: vi.fn().mockResolvedValue(result),
		executeStream: vi.fn(() => {
			const iter: AsyncIterable<DecodedExecuteEvent> = {
				[Symbol.asyncIterator]: async function* () {
					for (const ev of events) yield ev;
				},
			};
			return { events: iter, result: Promise.resolve(result) };
		}),
	};
}

function makeUnaryOnlyAdapter(result: ExecutionResult): RuntimeAdapter {
	return {
		kind: "python3",
		transport: "http",
		execute: vi.fn().mockResolvedValue(result),
	};
}

describe("RuntimeAdapterNode", () => {
	describe("transport metadata", () => {
		it("mirrors the underlying adapter's transport tag", () => {
			const grpcNode = new RuntimeAdapterNode(makeStreamingAdapter([], successResult), makeTarget());
			expect(grpcNode.transport).toBe("grpc");

			const httpNode = new RuntimeAdapterNode(makeUnaryOnlyAdapter(successResult), makeTarget());
			expect(httpNode.transport).toBe("http");
		});
	});

	describe("default unary path", () => {
		it("calls adapter.execute when streamLogs is not enabled", async () => {
			const adapter = makeStreamingAdapter([], successResult);
			const node = new RuntimeAdapterNode(adapter, makeTarget());

			const response = await node.run(makeCtx());

			expect(response.success).toBe(true);
			expect(response.data).toEqual({ ok: true });
			expect(adapter.execute).toHaveBeenCalledTimes(1);
			expect(adapter.executeStream).not.toHaveBeenCalled();
		});

		it("falls back to execute when streamLogs is true but adapter has no executeStream", async () => {
			const adapter = makeUnaryOnlyAdapter(successResult);
			const node = new RuntimeAdapterNode(adapter, makeTarget(), { streamLogs: true });

			const response = await node.run(makeCtx());

			expect(response.success).toBe(true);
			expect(adapter.execute).toHaveBeenCalledTimes(1);
		});
	});

	describe("streaming path", () => {
		let tracker: RunTracker;
		const traceRunId = "test-run";
		const traceNodeId = "test-node";

		beforeEach(() => {
			tracker = RunTracker.getInstance();
			// Seed a workflow run + node run so addLog has somewhere to attach logs.
			tracker.startRun({
				workflowName: "wf",
				workflowPath: "/wf",
				triggerType: "http",
				triggerSummary: "test",
				nodeCount: 0,
			});
			vi.spyOn(tracker, "addLog");
			vi.spyOn(tracker, "getNodeRun").mockReturnValue({
				id: traceNodeId,
				runId: traceRunId,
				nodeName: "step-x",
				nodeType: "runtime.python3",
				status: "running",
				startedAt: Date.now(),
			} as unknown as ReturnType<RunTracker["getNodeRun"]>);
		});

		afterEach(() => {
			vi.restoreAllMocks();
		});

		it("uses executeStream when streamLogs is enabled and the adapter supports it", async () => {
			const adapter = makeStreamingAdapter([], successResult);
			const node = new RuntimeAdapterNode(adapter, makeTarget(), { streamLogs: true });

			await node.run(makeCtx(traceRunId, traceNodeId));

			expect(adapter.executeStream).toHaveBeenCalledTimes(1);
			expect(adapter.execute).not.toHaveBeenCalled();
		});

		it("forwards LogLine frames to RunTracker.addLog with normalized levels", async () => {
			const events: DecodedExecuteEvent[] = [
				{ type: "started", at: 1000 },
				{
					type: "log",
					log: { timestamp: 1100, level: "INFO", message: "running query", attributes: { sql: "SELECT 1" } },
				},
				{
					type: "log",
					log: { timestamp: 1200, level: "warning", message: "slow", attributes: {} },
				},
				{
					type: "log",
					log: { timestamp: 1300, level: "weird-level", message: "unknown", attributes: {} },
				},
			];
			const adapter = makeStreamingAdapter(events, successResult);
			const node = new RuntimeAdapterNode(adapter, makeTarget(), { streamLogs: true });

			await node.run(makeCtx(traceRunId, traceNodeId));

			const addLogMock = tracker.addLog as unknown as ReturnType<typeof vi.fn>;
			expect(addLogMock).toHaveBeenCalledTimes(3);

			expect(addLogMock).toHaveBeenNthCalledWith(1, {
				runId: traceRunId,
				nodeId: traceNodeId,
				nodeName: "step-x",
				level: "info",
				message: "running query",
				data: { sql: "SELECT 1" },
			});
			expect(addLogMock).toHaveBeenNthCalledWith(2, {
				runId: traceRunId,
				nodeId: traceNodeId,
				nodeName: "step-x",
				level: "warn",
				message: "slow",
				data: undefined,
			});
			// Unknown levels coerce to "info" rather than crashing the stream.
			expect(addLogMock).toHaveBeenNthCalledWith(3, expect.objectContaining({ level: "info", message: "unknown" }));
		});

		it("does not call addLog when there is no trace run on the context", async () => {
			const events: DecodedExecuteEvent[] = [
				{ type: "log", log: { timestamp: 1, level: "info", message: "ignored", attributes: {} } },
			];
			const adapter = makeStreamingAdapter(events, successResult);
			const node = new RuntimeAdapterNode(adapter, makeTarget(), { streamLogs: true });

			await node.run(makeCtx(null, null));

			expect((tracker.addLog as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
		});

		it("ignores non-log frames (started/progress/partial) at the tracker boundary", async () => {
			const events: DecodedExecuteEvent[] = [
				{ type: "started", at: 1 },
				{ type: "progress", percent: 0.5, phase: "loading" },
				{ type: "partial", snapshot: { checkpoint: "halfway" } },
			];
			const adapter = makeStreamingAdapter(events, successResult);
			const node = new RuntimeAdapterNode(adapter, makeTarget(), { streamLogs: true });

			await node.run(makeCtx(traceRunId, traceNodeId));

			expect((tracker.addLog as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
		});

		it("populates ctx.state[name] with result.data by default (v2 default-store)", async () => {
			// Regression for the cross-runtime-chain bug on Phase 6:
			// the legacy `set_var: false` default short-circuited
			// `PersistenceHelper.applyStepOutput` for every SDK step
			// (`state['go']` was undefined even though the GO step ran fine).
			// `set_var` was removed in v0.5; this test pins default-store.
			const adapter = makeStreamingAdapter([], {
				success: true,
				data: { chain: [{ language: "go", order: 2 }], origin: "blok-test" },
				errors: null,
				logs: [],
				metrics: { duration_ms: 1, cpu_ms: 0, memory_bytes: 0, request_bytes: 0, response_bytes: 0 },
				vars: {},
			});
			const target = makeTarget("go");
			const node = new RuntimeAdapterNode(adapter, target);
			const ctx = makeCtx();

			await node.run(ctx);

			const state = (ctx as unknown as { state: Record<string, unknown> }).state;
			expect(state.go).toEqual({
				chain: [{ language: "go", order: 2 }],
				origin: "blok-test",
			});
		});

		it("declares optional idempotencyKey + idempotencyKeyTTL + retry on NodeBase (Phase 2 wiring)", () => {
			// Phase 2 lands the field declarations + Configuration thread-through.
			// Phase 3 wires RunnerSteps to actually consult them. This test pins
			// the NodeBase contract: the fields are declared, default to
			// undefined, and accept the documented shapes. If a future refactor
			// drops them from the base class, RunnerSteps' cache-check + retry-
			// loop wrapper would silently no-op.
			const target = makeTarget("idem-step");
			expect(target.idempotencyKey).toBeUndefined();
			expect(target.idempotencyKeyTTL).toBeUndefined();
			expect(target.retry).toBeUndefined();

			target.idempotencyKey = "user-123";
			target.idempotencyKeyTTL = 60_000;
			target.retry = { maxAttempts: 3, minTimeoutInMs: 250, maxTimeoutInMs: 5000, factor: 2 };

			expect(target.idempotencyKey).toBe("user-123");
			expect(target.idempotencyKeyTTL).toBe(60_000);
			expect(target.retry).toEqual({ maxAttempts: 3, minTimeoutInMs: 250, maxTimeoutInMs: 5000, factor: 2 });
		});

		it("skips ctx.state[name] when ephemeral is true", async () => {
			const adapter = makeStreamingAdapter([], successResult);
			const target = makeTarget("ephemeral-step");
			target.ephemeral = true;
			const node = new RuntimeAdapterNode(adapter, target);
			const ctx = makeCtx();

			await node.run(ctx);

			const state = (ctx as unknown as { state: Record<string, unknown> }).state;
			expect(state["ephemeral-step"]).toBeUndefined();
		});

		it("stashes adapter metrics on ctx._stepMetrics so RunnerSteps can thread them into completeNode", async () => {
			// Contract: `RuntimeAdapterNode` does not mutate the persisted
			// `nodeRun` directly (the previous version did, which was the
			// dead-end fixed by stashing on ctx — see RuntimeAdapterNode.ts
			// comment block). Instead it parks `result.metrics` on
			// `ctx._stepMetrics`; `RunnerSteps` reads it after the step
			// returns and passes it as the third argument to
			// `tracker.completeNode(...)`. That single path survives every
			// store backend (in-memory, sqlite, postgres) and reaches the
			// NODE_COMPLETED event payload Studio's inspector consumes.
			const adapter = makeStreamingAdapter([], {
				success: true,
				data: { ok: true },
				errors: null,
				logs: [],
				metrics: {
					duration_ms: 12,
					cpu_ms: 4,
					memory_bytes: 1024,
					request_bytes: 256,
					response_bytes: 512,
				},
				vars: {},
			});
			const node = new RuntimeAdapterNode(adapter, makeTarget(), { streamLogs: true });
			const ctx = makeCtx(traceRunId, traceNodeId);

			await node.run(ctx);

			expect((ctx as Record<string, unknown>)._stepMetrics).toEqual({
				duration_ms: 12,
				cpu_ms: 4,
				memory_bytes: 1024,
				request_bytes: 256,
				response_bytes: 512,
			});
		});
	});

	// =========================================================================
	// G3 / Route A1 — live runtime→SSE streaming via PartialResult forwarding.
	// A `streamTo: "sse"` runtime step forwards each PartialResult frame to
	// `ctx.stream.writeSSE(...)` AS IT ARRIVES, before the terminal result.
	// =========================================================================
	describe('streamTo: "sse" live forwarding', () => {
		interface FakeStream {
			id: string;
			writeSSE: ReturnType<typeof vi.fn>;
			writeComment: ReturnType<typeof vi.fn>;
			close: () => void;
			closed: boolean;
			signal: AbortSignal;
			lastEventId: string | null;
			subscribe: () => never;
		}

		function makeStreamCtx(): {
			ctx: Context;
			stream: FakeStream;
			writes: Array<{ event?: string; data: unknown; id?: string; retry?: number }>;
			controller: AbortController;
		} {
			const writes: Array<{ event?: string; data: unknown; id?: string; retry?: number }> = [];
			const controller = new AbortController();
			let closed = false;
			const stream: FakeStream = {
				id: "stream-1",
				writeSSE: vi.fn(async (o: { event?: string; data: unknown; id?: string; retry?: number }) => {
					writes.push(o);
				}),
				writeComment: vi.fn(async () => {}),
				close: () => {
					closed = true;
				},
				get closed() {
					return closed;
				},
				signal: controller.signal,
				lastEventId: null,
				subscribe: () => {
					throw new Error("subscribe not used in this test");
				},
			};
			const ctx = makeCtx();
			(ctx as Record<string, unknown>).stream = stream;
			return { ctx, stream, writes, controller };
		}

		it("forwards framed PartialResult frames to ctx.stream.writeSSE in order, then sets final state", async () => {
			const events: DecodedExecuteEvent[] = [
				{ type: "partial", snapshot: { event: "text", data: { delta: "Hel" }, id: "1" } },
				{ type: "partial", snapshot: { event: "text", data: { delta: "lo" }, id: "2" } },
				{ type: "partial", snapshot: { event: "source", data: { url: "https://x" }, id: "3" } },
			];
			const adapter = makeStreamingAdapter(events, {
				...successResult,
				data: { answer: "Hello", sources: ["https://x"] },
			});
			const node = new RuntimeAdapterNode(adapter, makeTarget("agent"), { streamTo: "sse" });
			const { ctx, stream, writes } = makeStreamCtx();

			await node.run(ctx);

			// 3 live frames, in order, with producer-chosen event names + ids.
			expect(stream.writeSSE).toHaveBeenCalledTimes(3);
			expect(writes).toEqual([
				{ event: "text", data: { delta: "Hel" }, id: "1", retry: undefined },
				{ event: "text", data: { delta: "lo" }, id: "2", retry: undefined },
				{ event: "source", data: { url: "https://x" }, id: "3", retry: undefined },
			]);
			// Terminal result still lands in state for finalization steps.
			const state = (ctx as unknown as { state: Record<string, unknown> }).state;
			expect(state.agent).toEqual({ answer: "Hello", sources: ["https://x"] });
		});

		it("maps a raw (non-framed) partial snapshot to { data: snapshot }", async () => {
			const events: DecodedExecuteEvent[] = [{ type: "partial", snapshot: { tokens: 5 } }];
			const adapter = makeStreamingAdapter(events, successResult);
			const node = new RuntimeAdapterNode(adapter, makeTarget("agent"), { streamTo: "sse" });
			const { ctx, writes } = makeStreamCtx();

			await node.run(ctx);

			expect(writes).toEqual([{ data: { tokens: 5 } }]);
		});

		it("does NOT forward partials when streamTo is unset (default behaviour preserved)", async () => {
			const events: DecodedExecuteEvent[] = [{ type: "partial", snapshot: { event: "text", data: "x" } }];
			const adapter = makeStreamingAdapter(events, successResult);
			// streamLogs engages the streaming path, but without streamTo no SSE forward.
			const node = new RuntimeAdapterNode(adapter, makeTarget("agent"), { streamLogs: true });
			const { ctx, stream } = makeStreamCtx();

			await node.run(ctx);

			expect(stream.writeSSE).not.toHaveBeenCalled();
		});

		it("is a no-op (no throw) when streamTo is 'sse' but ctx.stream is absent", async () => {
			const events: DecodedExecuteEvent[] = [{ type: "partial", snapshot: { event: "text", data: "x" } }];
			const adapter = makeStreamingAdapter(events, successResult);
			const node = new RuntimeAdapterNode(adapter, makeTarget("agent"), { streamTo: "sse" });
			const ctx = makeCtx(); // no .stream attached

			const response = await node.run(ctx);

			expect(response.success).toBe(true);
			const state = (ctx as unknown as { state: Record<string, unknown> }).state;
			expect(state.agent).toEqual({ ok: true });
		});

		it("stops client writes after disconnect but keeps draining so the node completes (final state set)", async () => {
			const events: DecodedExecuteEvent[] = [
				{ type: "partial", snapshot: { event: "text", data: "a", id: "1" } },
				{ type: "partial", snapshot: { event: "text", data: "b", id: "2" } },
				{ type: "partial", snapshot: { event: "text", data: "c", id: "3" } },
			];
			const adapter = makeStreamingAdapter(events, { ...successResult, data: { answer: "done" } });
			const node = new RuntimeAdapterNode(adapter, makeTarget("agent"), { streamTo: "sse" });
			const { ctx, stream, writes, controller } = makeStreamCtx();
			// Client disconnects right after the first frame is written.
			stream.writeSSE.mockImplementation(async (o: { event?: string; data: unknown; id?: string; retry?: number }) => {
				writes.push(o);
				controller.abort();
			});

			await node.run(ctx);

			// Only the first frame reached the client; the rest were skipped.
			expect(stream.writeSSE).toHaveBeenCalledTimes(1);
			// ...but the node still ran to completion and persisted its result.
			const state = (ctx as unknown as { state: Record<string, unknown> }).state;
			expect(state.agent).toEqual({ answer: "done" });
		});
	});
});
