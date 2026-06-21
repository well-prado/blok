/**
 * WorkerTrigger.handleJob — cancellation + timeout taxonomy
 *
 * Covers:
 *   - F3: a `RunCancelledError` from a worker run ACKs the broker WITHOUT
 *     requeue (`job.complete()`), so the deliberately-cancelled work does NOT
 *     run again on redelivery.
 *   - F4: a trigger-level `config.timeout` fires the ctx AbortController (the
 *     detached run unwinds cooperatively) and the second run never starts
 *     (ACK without requeue).
 *   - F24: the timeout flips the run record to `timedOut` via
 *     `markRunTimedOut`, instead of routing through the generic retry/DLQ
 *     path.
 */

import { type HelperResponse, workflow } from "@blokjs/helper";
import { type BlokService, RunCancelledError, RunTracker, type TriggerResponse, defineNode } from "@blokjs/runner";
import type { Context } from "@blokjs/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { type WorkerJob, WorkerTimeoutError, WorkerTrigger } from "./WorkerTrigger";

const echoNode = defineNode({
	name: "echo",
	description: "echoes its input",
	input: z.object({}).passthrough(),
	output: z.object({}).passthrough(),
	async execute(_ctx, input) {
		return input;
	},
});

function makeWorkerWorkflow(name: string, queue: string, timeout?: number): HelperResponse {
	return workflow({
		name,
		version: "1.0.0",
		trigger: { worker: { queue, ...(timeout !== undefined ? { timeout } : {}) } },
		steps: [{ id: "process", use: "echo", type: "module", inputs: {} }],
	}) as unknown as HelperResponse;
}

type RunImpl = (ctx: Context) => Promise<TriggerResponse>;

class TestWorkerTrigger extends WorkerTrigger {
	protected nodes: Record<string, BlokService<unknown>> = { echo: echoNode as unknown as BlokService<unknown> };
	protected workflows: Record<string, HelperResponse>;
	private runImpl: RunImpl;

	constructor(workflows: Record<string, HelperResponse>, runImpl: RunImpl) {
		super();
		this.workflows = workflows;
		this.runImpl = runImpl;
		this.loadNodes();
		this.loadWorkflows();
	}

	override run(ctx: Context): Promise<TriggerResponse> {
		return this.runImpl(ctx);
	}

	public callHandleJob(job: WorkerJob) {
		const model = this.getWorkerWorkflows()[0];
		const config = model.config.trigger?.worker as never;
		return this.handleJob(job, model as never, config);
	}
}

function fakeJob(overrides: Partial<WorkerJob> = {}): WorkerJob {
	return {
		id: "job-1",
		data: {},
		headers: {},
		queue: "q",
		priority: 0,
		attempts: 0,
		maxRetries: 3,
		createdAt: new Date(),
		raw: {},
		complete: vi.fn(async () => {}),
		fail: vi.fn(async () => {}),
		...overrides,
	};
}

describe("WorkerTrigger.handleJob — cancellation (F3)", () => {
	afterEach(() => vi.restoreAllMocks());

	it("ACKs without requeue when the run throws RunCancelledError", async () => {
		const trigger = new TestWorkerTrigger({ wf: makeWorkerWorkflow("wf-x", "q") }, async () => {
			throw new RunCancelledError("run-123");
		});

		const job = fakeJob({ attempts: 0, maxRetries: 3 });
		await trigger.callHandleJob(job);

		// ACK (complete), NOT a requeue (fail) — even though attempts < maxRetries.
		expect(job.complete).toHaveBeenCalledTimes(1);
		expect(job.fail).not.toHaveBeenCalled();
	});
});

describe("WorkerTrigger.handleJob — timeout taxonomy (F4 + F24)", () => {
	afterEach(() => vi.restoreAllMocks());

	it("aborts the ctx, flips the run to timedOut, and ACKs without requeue on timeout", async () => {
		const markSpy = vi.spyOn(RunTracker.getInstance(), "markRunTimedOut").mockImplementation(() => {});

		let capturedCtx: Context | undefined;
		const trigger = new TestWorkerTrigger({ wf: makeWorkerWorkflow("wf-x", "q", 30) }, (ctx) => {
			capturedCtx = ctx;
			// Simulate a run that has started (so it owns a run id) but hangs
			// past the timeout. It must settle only AFTER the abort fires.
			(ctx as { _traceRunId?: string })._traceRunId = "run-timeout-1";
			return new Promise<TriggerResponse>((resolve) => {
				// Resolve far later than the 30ms timeout — the timeout wins.
				setTimeout(() => resolve({ ctx, metrics: {} as never }), 500);
			});
		});

		const job = fakeJob({ attempts: 0, maxRetries: 3 });
		await trigger.callHandleJob(job);

		// F4 — the detached run was aborted cooperatively.
		expect(capturedCtx?.signal?.aborted).toBe(true);

		// F24 — flipped to timedOut with the worker-timeout sentinel step id.
		expect(markSpy).toHaveBeenCalledTimes(1);
		expect(markSpy.mock.calls[0][0]).toBe("run-timeout-1");
		expect(markSpy.mock.calls[0][1]).toMatchObject({ stepId: "__worker_timeout__", maxDurationMs: 30 });

		// ACK without requeue (no second run).
		expect(job.complete).toHaveBeenCalledTimes(1);
		expect(job.fail).not.toHaveBeenCalled();
	});

	it("WorkerTimeoutError carries the timeout + run id", () => {
		const err = new WorkerTimeoutError(5000, "run-xyz");
		expect(err).toBeInstanceOf(WorkerTimeoutError);
		expect(err).toBeInstanceOf(Error);
		expect(err.timeoutMs).toBe(5000);
		expect(err.runId).toBe("run-xyz");
		expect(err.message).toContain("5000");
	});

	it("does NOT time out a fast run (completes normally)", async () => {
		const markSpy = vi.spyOn(RunTracker.getInstance(), "markRunTimedOut").mockImplementation(() => {});
		const trigger = new TestWorkerTrigger({ wf: makeWorkerWorkflow("wf-x", "q", 1000) }, async (ctx) => {
			(ctx as { _traceRunId?: string })._traceRunId = "run-fast";
			return { ctx, metrics: {} as never };
		});

		const job = fakeJob();
		await trigger.callHandleJob(job);

		expect(markSpy).not.toHaveBeenCalled();
		expect(job.complete).toHaveBeenCalledTimes(1);
		expect(job.fail).not.toHaveBeenCalled();
	});
});
