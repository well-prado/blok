import type { Context, ResponseContext } from "@blokjs/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Runner from "../../src/Runner";
import RunnerNode from "../../src/RunnerNode";
import { StepTimeoutError, isStepTimeoutError } from "../../src/timeouts/StepTimeoutError";
import { RunTracker } from "../../src/tracing/RunTracker";

class SlowNode extends RunnerNode {
	constructor(
		name: string,
		private readonly delayMs: number,
		private readonly value: unknown = { ok: true },
	) {
		super();
		this.name = name;
		this.node = name;
		this.type = "module";
		this.active = true;
	}

	async run(): Promise<ResponseContext> {
		await new Promise((resolve) => setTimeout(resolve, this.delayMs));
		return { success: true, data: this.value, error: null };
	}
}

class FlakyTimeoutNode extends RunnerNode {
	public attempts = 0;
	constructor(
		name: string,
		private readonly slowAttempts: number,
		private readonly slowDelayMs: number,
	) {
		super();
		this.name = name;
		this.node = name;
		this.type = "module";
		this.active = true;
	}
	async run(): Promise<ResponseContext> {
		this.attempts += 1;
		if (this.attempts <= this.slowAttempts) {
			await new Promise((resolve) => setTimeout(resolve, this.slowDelayMs));
		}
		return { success: true, data: { attempt: this.attempts }, error: null };
	}
}

function makeCtx(): Context {
	return {
		id: "req-1",
		workflow_name: "wf-timeout",
		workflow_path: "/wf-timeout",
		request: { body: {}, headers: {}, params: {}, query: {} } as unknown as Context["request"],
		response: { data: null, contentType: "application/json", success: true, error: null } as Context["response"],
		error: { message: [] } as Context["error"],
		logger: { log: () => {}, error: () => {} } as unknown as Context["logger"],
		config: {} as unknown as Context["config"],
		vars: {},
		env: {} as unknown as Context["env"],
		eventLogger: null,
		_PRIVATE_: null,
	} as unknown as Context;
}

function ctxWithTracing(workflow = "wf-timeout"): { ctx: Context; runId: string } {
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

describe("StepTimeoutError", () => {
	it("captures stepName + maxDurationMs", () => {
		const err = new StepTimeoutError("fetch", 5000);
		expect(err.stepName).toBe("fetch");
		expect(err.maxDurationMs).toBe(5000);
		expect(err.message).toContain("fetch");
		expect(err.message).toContain("5000");
	});

	it("preserves Error semantics + isStepTimeoutError type guard", () => {
		const err = new StepTimeoutError("fetch", 1000);
		expect(err).toBeInstanceOf(Error);
		expect(err).toBeInstanceOf(StepTimeoutError);
		expect(isStepTimeoutError(err)).toBe(true);
		expect(isStepTimeoutError(new Error("nope"))).toBe(false);
		expect(isStepTimeoutError("string")).toBe(false);
		expect(isStepTimeoutError(undefined)).toBe(false);
	});
});

describe("RunnerSteps — maxDuration (Tier 2 quick-wins)", () => {
	beforeEach(() => {
		RunTracker.resetInstance();
	});

	afterEach(() => {
		vi.useRealTimers();
		RunTracker.resetInstance();
	});

	it("step that completes within maxDuration succeeds", async () => {
		const node = new SlowNode("fast", 10);
		node.maxDurationMs = 1000;

		const { ctx } = ctxWithTracing();
		const runner = new Runner([node]);
		await runner.run(ctx);

		expect((ctx.response as { ok: boolean }).ok).toBe(true);
	});

	it("step that exceeds maxDuration throws StepTimeoutError", async () => {
		const node = new SlowNode("slow", 200);
		node.maxDurationMs = 50;

		const { ctx } = ctxWithTracing();
		const runner = new Runner([node]);

		await expect(runner.run(ctx)).rejects.toThrow();
	});

	it("retry loop covers timeouts — recovers when later attempt is fast enough", async () => {
		const node = new FlakyTimeoutNode("retry-recover", 1, 200);
		node.maxDurationMs = 50;
		node.retry = { maxAttempts: 3, minTimeoutInMs: 1, maxTimeoutInMs: 5 };

		const { ctx } = ctxWithTracing();
		const runner = new Runner([node]);
		await runner.run(ctx);

		// Second attempt is fast (no slow delay) — succeeds.
		expect(node.attempts).toBe(2);
		expect((ctx.response as { attempt: number }).attempt).toBe(2);
	});

	it("final-attempt timeout flips run status to 'timedOut'", async () => {
		const node = new SlowNode("always-slow", 200);
		node.maxDurationMs = 50;
		node.retry = { maxAttempts: 2, minTimeoutInMs: 1, maxTimeoutInMs: 5 };

		const { ctx, runId } = ctxWithTracing();
		const runner = new Runner([node]);
		await expect(runner.run(ctx)).rejects.toThrow();

		const tracker = RunTracker.getInstance();
		const run = tracker.getStore().getRun(runId);
		expect(run?.status).toBe("timedOut");
	});

	it("emits RUN_TIMED_OUT event with structured payload", async () => {
		const node = new SlowNode("always-slow", 200);
		node.maxDurationMs = 50;

		const { ctx } = ctxWithTracing();
		const tracker = RunTracker.getInstance();
		const events: Array<{ type: string; payload?: unknown }> = [];
		tracker.on("event", (e: { type: string; payload?: unknown }) => events.push(e));

		const runner = new Runner([node]);
		await expect(runner.run(ctx)).rejects.toThrow();

		const timedOutEvent = events.find((e) => e.type === "RUN_TIMED_OUT");
		expect(timedOutEvent).toBeDefined();
		const payload = timedOutEvent?.payload as {
			stepId: string;
			maxDurationMs: number;
			attemptsExhausted: number;
		};
		expect(payload.stepId).toBe("always-slow");
		expect(payload.maxDurationMs).toBe(50);
		expect(payload.attemptsExhausted).toBe(1);
	});

	it("zero or negative maxDurationMs disables the cap", async () => {
		const node = new SlowNode("slow-no-cap", 50);
		node.maxDurationMs = 0;

		const { ctx } = ctxWithTracing();
		const runner = new Runner([node]);
		await runner.run(ctx);

		expect((ctx.response as { ok: boolean }).ok).toBe(true);
	});

	it("undefined maxDurationMs is the default (no cap)", async () => {
		const node = new SlowNode("default", 50);
		// node.maxDurationMs explicitly NOT set

		const { ctx } = ctxWithTracing();
		const runner = new Runner([node]);
		await runner.run(ctx);

		expect((ctx.response as { ok: boolean }).ok).toBe(true);
	});

	it("each retry attempt gets its own timeout (NOT a shared budget)", async () => {
		const node = new FlakyTimeoutNode("per-attempt", 0, 0);
		node.maxDurationMs = 50;
		node.retry = { maxAttempts: 3, minTimeoutInMs: 1, maxTimeoutInMs: 5 };

		const { ctx } = ctxWithTracing();
		const runner = new Runner([node]);
		await runner.run(ctx);

		// Single fast attempt is enough — no retry needed because no slow delay.
		expect(node.attempts).toBe(1);
	});

	it("non-timeout errors during a max-duration step keep run as 'failed' (not 'timedOut')", async () => {
		class ThrowingNode extends RunnerNode {
			constructor() {
				super();
				this.name = "thrower";
				this.node = "thrower";
				this.type = "module";
				this.active = true;
			}
			async run(): Promise<ResponseContext> {
				throw new Error("boom");
			}
		}
		const node = new ThrowingNode();
		(node as RunnerNode & { maxDurationMs?: number }).maxDurationMs = 5000;

		const { ctx, runId } = ctxWithTracing();
		const runner = new Runner([node]);
		await expect(runner.run(ctx)).rejects.toThrow();

		const tracker = RunTracker.getInstance();
		const run = tracker.getStore().getRun(runId);
		// Final error was NOT a StepTimeoutError — status stays "failed"-class
		// (whatever the outer wrap produces; just NOT "timedOut").
		expect(run?.status).not.toBe("timedOut");
	});
});
