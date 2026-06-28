import type { Context, ResponseContext } from "@blokjs/shared";
import type { GlobalError } from "@blokjs/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Runner from "../../src/Runner";
import RunnerNode from "../../src/RunnerNode";
import { RunTracker } from "../../src/tracing/RunTracker";

/**
 * Echo node — runs `count` times across calls, returns whatever inputs it
 * was given as `data`. Used to assert cache hit/miss behaviour by counting
 * actual run() invocations.
 */
class EchoNode extends RunnerNode {
	public runs = 0;
	public lastData: unknown = null;

	constructor(name: string, returnData: unknown = { hello: "world" }) {
		super();
		this.name = name;
		this.node = name;
		this.type = "module";
		this.active = true;
		this.lastData = returnData;
	}

	async run() {
		this.runs += 1;
		return { success: true, data: this.lastData, error: null };
	}
}

function makeCtx(overrides: Partial<Context> = {}): Context {
	return {
		id: "test-run",
		workflow_name: "wf-idem",
		workflow_path: "/wf",
		request: {
			body: { requestId: "req-1" },
			headers: {},
			params: {},
			query: {},
		} as unknown as Context["request"],
		response: { data: null, contentType: "application/json", success: true, error: null },
		error: { message: [] },
		logger: { log: () => {}, error: () => {} } as unknown as Context["logger"],
		config: {} as unknown as Context["config"],
		vars: {},
		env: {} as unknown as Context["env"],
		eventLogger: null,
		_PRIVATE_: null,
		...overrides,
	};
}

/**
 * Spin up a tracked run and return both the ctx and the actual run id
 * RunTracker generated. Tests need the generated id (not a synthetic
 * fixture) because `InMemoryRunStore.saveEvent` silently drops events
 * for unknown run ids — the events Map is keyed off real `run.id` values
 * created by `startRun`.
 */
function ctxWithTracing(
	opts: { workflow: string; reqBody?: Record<string, unknown> } = {
		workflow: "wf-idem",
	},
): { ctx: Context; runId: string } {
	const tracker = RunTracker.getInstance();
	const run = tracker.startRun({
		workflowName: opts.workflow,
		workflowPath: `/${opts.workflow}`,
		triggerType: "http",
		triggerSummary: opts.workflow,
		nodeCount: 1,
	});
	const ctx = makeCtx({
		workflow_name: opts.workflow,
		request: {
			body: opts.reqBody ?? { requestId: "req-1" },
			headers: {},
			params: {},
			query: {},
		} as unknown as Context["request"],
	});
	(ctx as Record<string, unknown>)._traceRunId = run.id;
	return { ctx, runId: run.id };
}

describe("RunnerSteps — idempotency cache integration", () => {
	beforeEach(() => {
		RunTracker.resetInstance();
	});

	afterEach(() => {
		RunTracker.resetInstance();
	});

	it("does not consult the cache when the step has no idempotencyKey (zero overhead path)", async () => {
		const node = new EchoNode("echo");
		// no idempotencyKey set
		const runner = new Runner([node]);

		await runner.run(ctxWithTracing({ workflow: "wf-noop" }).ctx);
		await runner.run(ctxWithTracing({ workflow: "wf-noop" }).ctx);

		// No cache → both calls actually executed.
		expect(node.runs).toBe(2);
	});

	it("caches the result on first run and short-circuits on second run with the same key", async () => {
		const node = new EchoNode("echo", { computed: "expensive" });
		node.idempotencyKey = "static-key-A";
		const runner = new Runner([node]);

		await runner.run(ctxWithTracing({ workflow: "wf-A" }).ctx);
		expect(node.runs).toBe(1);

		const second = ctxWithTracing({ workflow: "wf-A" });
		await runner.run(second.ctx);
		// Cache hit — execute() not called a second time.
		expect(node.runs).toBe(1);
		// Cached data lands in state via applyStepOutput, same as fresh run.
		const state = (second.ctx as unknown as { state: Record<string, unknown> }).state;
		expect(state.echo).toEqual({ computed: "expensive" });
	});

	it("emits a NODE_CACHED event with source-run lineage on the cache-hit run", async () => {
		const node = new EchoNode("echo", { v: 1 });
		node.idempotencyKey = "static-key-B";
		const runner = new Runner([node]);

		const first = ctxWithTracing({ workflow: "wf-B" });
		await runner.run(first.ctx);

		const second = ctxWithTracing({ workflow: "wf-B" });
		await runner.run(second.ctx);

		const events = RunTracker.getInstance().getStore().getEvents(second.runId);
		const cachedEvent = events.find((e) => e.type === "NODE_CACHED");
		expect(cachedEvent).toBeDefined();
		expect(cachedEvent?.nodeName).toBe("echo");
		const payload = cachedEvent?.payload as { source: { sourceRunId: string } };
		expect(payload.source.sourceRunId).toBe(first.runId);
	});

	it("respects ephemeral: true on a cache hit (data reaches ctx.prev but not state)", async () => {
		const node = new EchoNode("ephemeral-echo", { secret: "shh" });
		node.idempotencyKey = "static-key-C";
		node.ephemeral = true;
		const runner = new Runner([node]);

		await runner.run(ctxWithTracing({ workflow: "wf-C" }).ctx);
		const second = ctxWithTracing({ workflow: "wf-C" });
		await runner.run(second.ctx);

		expect(node.runs).toBe(1);
		const state = (second.ctx as unknown as { state?: Record<string, unknown> }).state;
		expect(state?.["ephemeral-echo"]).toBeUndefined();
	});

	it("respects as: on a cache hit (renames the slot identically to a fresh run — #346)", async () => {
		const node = new EchoNode("echo-as", { computed: 42 });
		node.idempotencyKey = "static-key-as";
		node.as = "renamed";
		const runner = new Runner([node]);

		await runner.run(ctxWithTracing({ workflow: "wf-as" }).ctx);
		const second = ctxWithTracing({ workflow: "wf-as" });
		await runner.run(second.ctx);

		expect(node.runs).toBe(1); // cache hit — execute() not re-run
		const state = (second.ctx as unknown as { state: Record<string, unknown> }).state;
		expect(state.renamed).toEqual({ computed: 42 }); // landed at state[as]
		expect(state["echo-as"]).toBeUndefined(); // NOT at state[id]
	});

	it("respects spread: on a cache hit (merges the cached object's keys into state — #346)", async () => {
		const node = new EchoNode("echo-spread", { alpha: 1, beta: 2 });
		node.idempotencyKey = "static-key-spread";
		node.spread = true;
		const runner = new Runner([node]);

		await runner.run(ctxWithTracing({ workflow: "wf-spread" }).ctx);
		const second = ctxWithTracing({ workflow: "wf-spread" });
		await runner.run(second.ctx);

		expect(node.runs).toBe(1); // cache hit
		const state = (second.ctx as unknown as { state: Record<string, unknown> }).state;
		expect(state.alpha).toBe(1); // per-key merged into state
		expect(state.beta).toBe(2);
		expect(state["echo-spread"]).toBeUndefined(); // not nested under id
	});

	it("namespaces cache by (workflowName, stepId, key) — same key in two workflows does not collide", async () => {
		const nodeA = new EchoNode("echo", { from: "wf-X" });
		nodeA.idempotencyKey = "shared-key";
		const runnerA = new Runner([nodeA]);
		await runnerA.run(ctxWithTracing({ workflow: "wf-X" }).ctx);
		expect(nodeA.runs).toBe(1);

		const nodeB = new EchoNode("echo", { from: "wf-Y" });
		nodeB.idempotencyKey = "shared-key";
		const runnerB = new Runner([nodeB]);
		await runnerB.run(ctxWithTracing({ workflow: "wf-Y" }).ctx);
		// Different workflow → cold cache → step ran.
		expect(nodeB.runs).toBe(1);
	});

	it("treats a TTL of 0 as immediately expired (caching effectively disabled)", async () => {
		const node = new EchoNode("echo", { x: 1 });
		node.idempotencyKey = "ttl-zero-key";
		node.idempotencyKeyTTL = 0;
		const runner = new Runner([node]);

		await runner.run(ctxWithTracing({ workflow: "wf-ttl0" }).ctx);
		await runner.run(ctxWithTracing({ workflow: "wf-ttl0" }).ctx);

		// Entry was written but immediately expired → second run re-executes.
		expect(node.runs).toBe(2);
	});

	it("does not cache the result when the step throws (cache is success-only)", async () => {
		class ThrowingNode extends RunnerNode {
			public attempts = 0;
			constructor() {
				super();
				this.name = "boom";
				this.node = "boom";
				this.type = "module";
				this.active = true;
				this.idempotencyKey = "should-not-cache";
			}
			async run(_ctx: Context): Promise<ResponseContext> {
				this.attempts += 1;
				return { success: false, data: null, error: { message: "boom" } as unknown as GlobalError };
			}
		}
		const node = new ThrowingNode();
		const runner = new Runner([node]);

		await expect(runner.run(ctxWithTracing({ workflow: "wf-throw" }).ctx)).rejects.toBeDefined();

		// Re-run with same key — must execute again, since the previous run failed.
		const node2 = new ThrowingNode();
		const runner2 = new Runner([node2]);
		await expect(runner2.run(ctxWithTracing({ workflow: "wf-throw" }).ctx)).rejects.toBeDefined();
		expect(node2.attempts).toBe(1);
	});

	it("resolves a $ proxy idempotencyKey (js/ctx.request.body.requestId) at runtime", async () => {
		const node = new EchoNode("echo", { dynamic: true });
		node.idempotencyKey = "js/ctx.request.body.requestId";
		const runner = new Runner([node]);

		// Two runs with the SAME requestId → cache hit on second.
		await runner.run(ctxWithTracing({ workflow: "wf-dyn", reqBody: { requestId: "abc" } }).ctx);
		await runner.run(ctxWithTracing({ workflow: "wf-dyn", reqBody: { requestId: "abc" } }).ctx);
		expect(node.runs).toBe(1);

		// Third run with a DIFFERENT requestId → fresh cold key → runs.
		await runner.run(ctxWithTracing({ workflow: "wf-dyn", reqBody: { requestId: "xyz" } }).ctx);
		expect(node.runs).toBe(2);
	});
});
