import type { Context } from "@blokjs/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Runner from "../../src/Runner";
import RunnerNode from "../../src/RunnerNode";
import { RunTracker } from "../../src/tracing/RunTracker";

class FlakyNode extends RunnerNode {
	public attempts = 0;

	constructor(
		name: string,
		private readonly failuresBeforeSuccess: number,
		private readonly successData: unknown = { ok: true },
	) {
		super();
		this.name = name;
		this.node = name;
		this.type = "module";
		this.active = true;
	}

	async run() {
		this.attempts += 1;
		if (this.attempts <= this.failuresBeforeSuccess) {
			throw new Error(`flake-attempt-${this.attempts}`);
		}
		return { success: true, data: this.successData, error: null };
	}
}

class AlwaysThrowNode extends RunnerNode {
	public attempts = 0;
	constructor(name: string) {
		super();
		this.name = name;
		this.node = name;
		this.type = "module";
		this.active = true;
	}
	async run() {
		this.attempts += 1;
		throw new Error("always-fails");
	}
}

function makeCtx(): Context {
	return {
		id: "test-run",
		workflow_name: "wf-retry",
		workflow_path: "/wf-retry",
		request: { body: {}, headers: {}, params: {}, query: {} } as unknown as Context["request"],
		response: { data: null, contentType: "application/json", success: true, error: null },
		error: { message: [] },
		logger: { log: () => {}, error: () => {} } as unknown as Context["logger"],
		config: {} as unknown as Context["config"],
		vars: {},
		env: {} as unknown as Context["env"],
		eventLogger: null,
		_PRIVATE_: null,
	};
}

function ctxWithTracing(workflow = "wf-retry"): { ctx: Context; runId: string } {
	const tracker = RunTracker.getInstance();
	const run = tracker.startRun({
		workflowName: workflow,
		workflowPath: `/${workflow}`,
		triggerType: "http",
		triggerSummary: workflow,
		nodeCount: 1,
	});
	const ctx = makeCtx();
	(ctx as Record<string, unknown>).workflow_name = workflow;
	(ctx as Record<string, unknown>)._traceRunId = run.id;
	return { ctx, runId: run.id };
}

describe("RunnerSteps — retry loop", () => {
	beforeEach(() => {
		RunTracker.resetInstance();
		// Speed up tests by stubbing setTimeout to fire immediately. The
		// loop's backoff math is unit-tested separately via the helper.
		vi.useFakeTimers({ toFake: ["setTimeout"] });
	});

	afterEach(() => {
		vi.useRealTimers();
		RunTracker.resetInstance();
	});

	it("default behaviour (no retry config) attempts once and throws on failure", async () => {
		const node = new AlwaysThrowNode("once");
		const runner = new Runner([node]);

		const promise = runner.run(ctxWithTracing("wf-once").ctx);
		// Claim the rejection handler immediately so Vitest does not treat
		// it as an unhandled promise rejection between scheduling and the
		// expect(...).rejects below.
		promise.catch(() => {});
		await vi.runAllTimersAsync();
		await expect(promise).rejects.toBeDefined();

		expect(node.attempts).toBe(1);
	});

	it("retries up to maxAttempts on transient failure and succeeds on a later attempt", async () => {
		const node = new FlakyNode("flaky", 2, { recovered: true });
		node.retry = { maxAttempts: 3, minTimeoutInMs: 1, factor: 1 };
		const runner = new Runner([node]);

		const { ctx } = ctxWithTracing("wf-recover");
		const promise = runner.run(ctx);
		await vi.runAllTimersAsync();
		await promise;

		expect(node.attempts).toBe(3);
		// RunnerSteps writes the successful step's output onto ctx.response.
		// State persistence is the responsibility of the step's own process()
		// (Blok / RuntimeAdapterNode call applyStepOutput); a bare RunnerNode
		// subclass like FlakyNode does not, so we assert on ctx.response only.
		expect(ctx.response as unknown).toEqual({ recovered: true });
	});

	it("emits NODE_ATTEMPT_FAILED for each pre-final attempt and NODE_COMPLETED on success", async () => {
		const node = new FlakyNode("flaky", 2);
		node.retry = { maxAttempts: 5, minTimeoutInMs: 1, factor: 1 };
		const runner = new Runner([node]);

		const { ctx, runId } = ctxWithTracing("wf-events");
		const promise = runner.run(ctx);
		await vi.runAllTimersAsync();
		await promise;

		const events = RunTracker.getInstance().getStore().getEvents(runId);
		const attemptFailed = events.filter((e) => e.type === "NODE_ATTEMPT_FAILED");
		expect(attemptFailed).toHaveLength(2);
		// attempt numbers are 1-based and contiguous
		expect((attemptFailed[0].payload as { attempt: number }).attempt).toBe(1);
		expect((attemptFailed[1].payload as { attempt: number }).attempt).toBe(2);

		const completed = events.find((e) => e.type === "NODE_COMPLETED");
		expect(completed).toBeDefined();
	});

	it("fails the node when maxAttempts is exhausted (NODE_FAILED, no NODE_COMPLETED)", async () => {
		const node = new AlwaysThrowNode("doomed");
		node.retry = { maxAttempts: 3, minTimeoutInMs: 1, factor: 1 };
		const runner = new Runner([node]);

		const { ctx, runId } = ctxWithTracing("wf-doomed");
		const promise = runner.run(ctx);
		promise.catch(() => {});
		await vi.runAllTimersAsync();
		await expect(promise).rejects.toBeDefined();

		expect(node.attempts).toBe(3);

		const events = RunTracker.getInstance().getStore().getEvents(runId);
		const attemptFailed = events.filter((e) => e.type === "NODE_ATTEMPT_FAILED");
		expect(attemptFailed).toHaveLength(2);
		expect(events.some((e) => e.type === "NODE_FAILED")).toBe(true);
		expect(events.some((e) => e.type === "NODE_COMPLETED")).toBe(false);
	});

	it("persists per-attempt history on the NodeRun.attempts array", async () => {
		const node = new FlakyNode("flaky", 2);
		node.retry = { maxAttempts: 5, minTimeoutInMs: 1, factor: 1 };
		const runner = new Runner([node]);

		const { ctx, runId } = ctxWithTracing("wf-persist");
		const promise = runner.run(ctx);
		await vi.runAllTimersAsync();
		await promise;

		const nodeRuns = RunTracker.getInstance().getStore().getNodeRuns(runId);
		expect(nodeRuns).toHaveLength(1);
		expect(nodeRuns[0].attempts).toBeDefined();
		expect(nodeRuns[0].attempts?.length).toBe(2);
		expect(nodeRuns[0].attempts?.[0].attempt).toBe(1);
		expect(nodeRuns[0].attempts?.[0].error.message).toContain("flake-attempt-1");
	});

	it("caps stored attempts at MAX_STORED_ATTEMPTS (10) under extreme retry counts", async () => {
		const node = new AlwaysThrowNode("loop");
		node.retry = { maxAttempts: 15, minTimeoutInMs: 1, factor: 1 };
		const runner = new Runner([node]);

		const { ctx, runId } = ctxWithTracing("wf-cap");
		const promise = runner.run(ctx);
		promise.catch(() => {});
		await vi.runAllTimersAsync();
		await expect(promise).rejects.toBeDefined();

		const nodeRuns = RunTracker.getInstance().getStore().getNodeRuns(runId);
		// 14 NODE_ATTEMPT_FAILED were emitted (15th attempt fails the node);
		// the persisted array is capped at 10, with the most recent kept.
		expect(nodeRuns[0].attempts?.length).toBe(10);
	});
});

describe("RunTracker — replay lineage", () => {
	beforeEach(() => {
		RunTracker.resetInstance();
	});

	afterEach(() => {
		RunTracker.resetInstance();
	});

	it("startRun honours the replayOf option and persists it on the WorkflowRun", () => {
		const tracker = RunTracker.getInstance();
		const original = tracker.startRun({
			workflowName: "wf-orig",
			workflowPath: "/wf-orig",
			triggerType: "http",
			triggerSummary: "POST /api/foo",
			nodeCount: 1,
		});
		const replay = tracker.startRun({
			workflowName: "wf-orig",
			workflowPath: "/wf-orig",
			triggerType: "http",
			triggerSummary: "POST /api/foo",
			nodeCount: 1,
			replayOf: original.id,
		});

		expect(replay.replayOf).toBe(original.id);

		const stored = tracker.getRun(replay.id);
		expect(stored?.replayOf).toBe(original.id);

		// The original carries no replayOf — it was triggered, not replayed.
		expect(tracker.getRun(original.id)?.replayOf).toBeUndefined();
	});
});
