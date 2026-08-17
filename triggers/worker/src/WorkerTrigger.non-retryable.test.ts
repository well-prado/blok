/**
 * WorkerTrigger.handleJob — step `retry.nonRetryableErrorNames` stops the JOB too (#679)
 *
 * A step's `retry.nonRetryableErrorNames` already short-circuits STEP retries in
 * `RunnerSteps`. Before #679 the worker's job-level retry ignored it, so BullMQ
 * (and every other adapter) re-ran the ENTIRE workflow `retries` more times,
 * replaying a guard whose outcome cannot change between attempts.
 *
 * These tests run the REAL runner — no stubbed `run` — so they cover the whole
 * chain the fix depends on: the one shared matcher in `@blokjs/shared` classifies
 * the failure, `RunnerSteps` stamps the verdict on the propagating error, and
 * `handleJob` reads it back and takes the terminal `job.fail(err, false)` path
 * that every adapter maps to "do not retry" (BullMQ `discard`, others' DLQ).
 */

import { type WorkflowV2Builder, workflow } from "@blokjs/helper";
import { type BlokService, defineNode } from "@blokjs/runner";
import { GlobalError } from "@blokjs/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { type WorkerJob, WorkerTrigger } from "./WorkerTrigger.js";

/** Bumped on every node execution so we can assert step-level attempt counts. */
let executions = 0;
/** Swapped per-test; the guard node throws whatever this returns. */
let thrown: () => unknown = () => new Error("boom");

const guardNode = defineNode({
	name: "guard",
	description: "a deterministic pre-flight guard that always rejects",
	input: z.object({}).passthrough(),
	output: z.object({}).passthrough(),
	async execute() {
		executions++;
		throw thrown();
	},
});

const NON_RETRYABLE_NAME = "GRAPH_STILL_A_TREE";

function makeWorkflow(nonRetryableErrorNames: string[]): WorkflowV2Builder {
	return workflow({
		name: "guarded",
		version: "1.0.0",
		trigger: { worker: { queue: "q", retries: 3 } },
		steps: [
			{
				id: "guard",
				use: "guard",
				type: "module",
				inputs: {},
				// factor/minTimeout kept tiny so the retryable case doesn't sleep.
				retry: { maxAttempts: 3, minTimeoutInMs: 1, factor: 1, nonRetryableErrorNames },
			},
		],
	}) as unknown as WorkflowV2Builder;
}

class TestWorkerTrigger extends WorkerTrigger {
	protected nodes: Record<string, BlokService<unknown>> = { guard: guardNode as unknown as BlokService<unknown> };
	protected workflows: Record<string, WorkflowV2Builder>;

	constructor(workflows: Record<string, WorkflowV2Builder>) {
		super();
		this.workflows = workflows;
		this.loadNodes();
		this.loadWorkflows();
	}

	public callHandleJob(job: WorkerJob) {
		const model = this.getWorkerWorkflows()[0];
		return this.handleJob(job, model as never, model.config.trigger?.worker as never);
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
		// A retry budget EXISTS — the whole point is that a declared
		// non-retryable failure must NOT consume it.
		maxRetries: 3,
		createdAt: new Date(),
		raw: {},
		complete: vi.fn(async () => {}),
		fail: vi.fn(async () => {}),
		...overrides,
	};
}

async function runGuard(names: string[], makeError: () => unknown): Promise<WorkerJob> {
	thrown = makeError;
	const trigger = new TestWorkerTrigger({ guarded: makeWorkflow(names) });
	const job = fakeJob();
	await trigger.callHandleJob(job);
	return job;
}

describe("WorkerTrigger.handleJob — declared non-retryable step error (#679)", () => {
	beforeEach(() => {
		executions = 0;
	});
	afterEach(() => vi.restoreAllMocks());

	it("a declared error name lands terminal after ONE job attempt", async () => {
		const job = await runGuard([NON_RETRYABLE_NAME], () => {
			const err = new GlobalError("graph is containment-only");
			err.setName(NON_RETRYABLE_NAME);
			return err;
		});

		// requeue = false → BullMQ discards the remaining attempts; other
		// adapters route to their DLQ. Either way: no second job attempt.
		expect(job.fail).toHaveBeenCalledTimes(1);
		expect(job.fail).toHaveBeenCalledWith(expect.any(Error), false);
		expect(job.complete).not.toHaveBeenCalled();
		// Step-level agreed: no step retry either.
		expect(executions).toBe(1);
	});

	it("a declared name carried by a wrapped `cause` also lands terminal", async () => {
		const job = await runGuard([NON_RETRYABLE_NAME], () => {
			const inner = new Error("graph is containment-only");
			inner.name = NON_RETRYABLE_NAME;
			const outer = new GlobalError("adapter wrapper");
			(outer as Error & { cause?: unknown }).cause = inner;
			return outer;
		});

		expect(job.fail).toHaveBeenCalledTimes(1);
		expect(job.fail).toHaveBeenCalledWith(expect.any(Error), false);
		expect(job.complete).not.toHaveBeenCalled();
		expect(executions).toBe(1);
	});

	it("an UNLISTED error name still requeues — the retry budget is untouched", async () => {
		const job = await runGuard([NON_RETRYABLE_NAME], () => {
			const err = new GlobalError("upstream 503");
			err.setName("DEPENDENCY_DOWN");
			return err;
		});

		expect(job.fail).toHaveBeenCalledTimes(1);
		expect(job.fail).toHaveBeenCalledWith(expect.any(Error), true); // requeue
		expect(job.complete).not.toHaveBeenCalled();
		// And step-level retries ran normally (maxAttempts: 3).
		expect(executions).toBe(3);
	});

	it("declaring no names at all leaves job retry exactly as it was", async () => {
		const job = await runGuard([], () => {
			const err = new GlobalError("graph is containment-only");
			err.setName(NON_RETRYABLE_NAME);
			return err;
		});

		expect(job.fail).toHaveBeenCalledWith(expect.any(Error), true);
		expect(executions).toBe(3);
	});
});
