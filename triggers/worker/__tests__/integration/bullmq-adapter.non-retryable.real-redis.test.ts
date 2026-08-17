import { type WorkflowV2Builder, workflow } from "@blokjs/helper";
import { type BlokService, defineNode } from "@blokjs/runner";
import { GlobalError } from "@blokjs/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { type WorkerJob, WorkerTrigger } from "../../src/WorkerTrigger.js";
import { BullMQAdapter } from "../../src/adapters/BullMQAdapter.js";

/**
 * Real-Redis integration test for the #679 terminal contract.
 *
 * Gated on `BLOK_INTEGRATION_REDIS`. Skipped when unset. Connects via
 * `REDIS_HOST` / `REDIS_PORT` (already running — do NOT start it). Every queue
 * is namespaced with a random suffix + a per-run key prefix, so nothing is
 * flushed and concurrent targets on the same Redis never collide.
 *
 * `WorkerTrigger.handleJob` routes a declared-non-retryable step failure to
 * `job.fail(err, false)`. This proves what that actually buys against a REAL
 * BullMQ worker: the adapter's `discard()` clears the job's remaining attempts
 * (BullMQ's `shouldRetryJob` checks `discarded` in exactly the same breath as
 * `UnrecoverableError`), so the processor runs ONCE even with a retry budget of
 * 3. The `requeue = true` case is the control — the budget is honoured as
 * before.
 */

const REDIS = process.env.BLOK_INTEGRATION_REDIS;
const d = REDIS ? describe : describe.skip;

const HOST = process.env.REDIS_HOST ?? "localhost";
const PORT = Number.parseInt(process.env.REDIS_PORT ?? "6379", 10);

const TEST_TIMEOUT_MS = 30_000;
const sfx = () => Math.random().toString(36).slice(2);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

d("BullMQAdapter — declared non-retryable failure stops job retry (#679)", () => {
	let adapter: BullMQAdapter;

	beforeAll(async () => {
		adapter = new BullMQAdapter({ host: HOST, port: PORT, prefix: `blok-test-679-${sfx()}` });
		await adapter.connect();
	});

	afterAll(async () => {
		await adapter.disconnect();
	});

	it(
		"requeue=false → BullMQ runs the processor exactly ONCE despite retries: 3",
		async () => {
			const queue = `blok-679-terminal-${sfx()}`;
			let runs = 0;

			await adapter.process({ queue, retries: 3 }, async (job) => {
				runs++;
				const err = new Error("graph is containment-only");
				err.name = "GRAPH_STILL_A_TREE";
				// The terminal contract handleJob takes for a declared
				// non-retryable step error.
				await job.fail(err, false);
			});

			await adapter.addJob(queue, { hello: "world" }, { retries: 3 });

			// Backoff for attempt 2 would be 1000ms — wait well past it, so a
			// re-attempt would have been observed if the budget were still live.
			await sleep(4000);

			expect(runs).toBe(1);
			const stats = await adapter.getQueueStats(queue);
			expect(stats.failed).toBe(1);
			await adapter.stopProcessing(queue);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"requeue=true → the retry budget is still honoured (control)",
		async () => {
			const queue = `blok-679-retry-${sfx()}`;
			let runs = 0;

			await adapter.process({ queue, retries: 1 }, async (job) => {
				runs++;
				await job.fail(new Error("upstream 503"), true);
			});

			await adapter.addJob(queue, { hello: "world" }, { retries: 1 });

			// attempts = retries + 1 = 2, second one after the 1000ms backoff.
			const deadline = Date.now() + 10_000;
			while (runs < 2 && Date.now() < deadline) await sleep(100);

			expect(runs).toBe(2);
			await adapter.stopProcessing(queue);
		},
		TEST_TIMEOUT_MS,
	);
});

/**
 * The #679 acceptance criterion end to end: a REAL BullMQ worker, the REAL
 * `WorkerTrigger.handleJob`, and the REAL runner. The workflow's only step
 * declares `retry.nonRetryableErrorNames`; the job must land FAILED after ONE
 * attempt even though the trigger grants `retries: 3`.
 */

let executions = 0;
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

function guardedWorkflow(queue: string, nonRetryableErrorNames: string[]): WorkflowV2Builder {
	return workflow({
		name: "guarded",
		version: "1.0.0",
		trigger: { worker: { queue, retries: 3 } },
		steps: [
			{
				id: "guard",
				use: "guard",
				type: "module",
				inputs: {},
				retry: { maxAttempts: 2, minTimeoutInMs: 1, factor: 1, nonRetryableErrorNames },
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

d("WorkerTrigger + BullMQ — acceptance (#679)", () => {
	let adapter: BullMQAdapter;

	beforeAll(async () => {
		adapter = new BullMQAdapter({ host: HOST, port: PORT, prefix: `blok-test-679-e2e-${sfx()}` });
		await adapter.connect();
	});

	afterAll(async () => {
		await adapter.disconnect();
	});

	async function drive(queue: string, names: string[], makeError: () => unknown): Promise<void> {
		executions = 0;
		thrown = makeError;
		const trigger = new TestWorkerTrigger({ guarded: guardedWorkflow(queue, names) });
		await adapter.process({ queue, retries: 3 }, (job) => trigger.callHandleJob(job));
		await adapter.addJob(queue, {}, { retries: 3 });
	}

	it(
		"a declared non-retryable step error lands FAILED after ONE job attempt",
		async () => {
			const queue = `blok-679-e2e-terminal-${sfx()}`;
			await drive(queue, ["GRAPH_STILL_A_TREE"], () => {
				const err = new GlobalError("graph is containment-only");
				err.setName("GRAPH_STILL_A_TREE");
				return err;
			});

			// Past the 1000ms backoff a re-attempt would already have run.
			await sleep(4000);

			// One job attempt, and one step attempt inside it (maxAttempts: 2).
			expect(executions).toBe(1);
			const stats = await adapter.getQueueStats(queue);
			expect(stats.failed).toBe(1);
			await adapter.stopProcessing(queue);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"an unlisted error name still burns the job retry budget (control)",
		async () => {
			const queue = `blok-679-e2e-retry-${sfx()}`;
			await drive(queue, ["GRAPH_STILL_A_TREE"], () => {
				const err = new GlobalError("upstream 503");
				err.setName("DEPENDENCY_DOWN");
				return err;
			});

			// 2 step attempts per job attempt; wait for the 2nd job attempt.
			const deadline = Date.now() + 15_000;
			while (executions < 4 && Date.now() < deadline) await sleep(100);

			expect(executions).toBeGreaterThanOrEqual(4);
			await adapter.stopProcessing(queue);
		},
		TEST_TIMEOUT_MS,
	);
});
