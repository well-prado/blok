import type { WorkerJob } from "@blokjs/runner";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RabbitMQAdapter } from "../../src/adapters/RabbitMQAdapter";

/**
 * Real-RabbitMQ integration test for `RabbitMQAdapter` (closes Phase 2.1
 * broker-adapter test debt deferred from PR #91).
 *
 * Exercises the worker contract end-to-end against a real broker: queue
 * declaration, job add, consume + ack, isolation across queues, manual
 * `complete()` / `fail()` paths.
 *
 * Gated on `BLOK_INTEGRATION_RABBITMQ_URL`. Skipped when unset.
 *
 * Bring up the test fixtures via:
 *   docker compose -f infra/testing/docker-compose.yml up -d rabbitmq
 *
 * Then run:
 *   BLOK_INTEGRATION_RABBITMQ_URL=amqp://blok:blok_test@localhost:5673 bun run test
 */

const RABBITMQ_URL = process.env.BLOK_INTEGRATION_RABBITMQ_URL;
const d = RABBITMQ_URL ? describe : describe.skip;

const TEST_TIMEOUT_MS = 30_000;

d("RabbitMQAdapter — real RabbitMQ", () => {
	let adapter: RabbitMQAdapter;

	beforeAll(async () => {
		adapter = new RabbitMQAdapter({ url: RABBITMQ_URL });
		await adapter.connect();
	}, TEST_TIMEOUT_MS);

	afterAll(async () => {
		await adapter.disconnect();
	});

	it(
		"publishes a job and the consumer receives it (single-queue happy path)",
		async () => {
			// Random queue name per run so this test is idempotent against
			// a long-lived broker — orphan messages from a prior crashed run
			// wouldn't bleed into the count assertion below.
			const queue = `blok-test-q-publish-${Math.random().toString(36).slice(2)}`;
			const received: WorkerJob[] = [];

			await adapter.process({ queue }, async (job) => {
				received.push(job);
				await job.complete();
			});

			const jobId = await adapter.addJob(queue, { hello: "world", n: 1 });
			expect(typeof jobId).toBe("string");
			expect(jobId).toBeTruthy();

			await waitFor(() => received.length === 1, TEST_TIMEOUT_MS - 5_000);

			expect(received).toHaveLength(1);
			expect(received[0].data).toEqual({ hello: "world", n: 1 });
			expect(received[0].queue).toBe(queue);
			expect(received[0].id).toBeTruthy();

			await adapter.stopProcessing(queue);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"isolates jobs across distinct queues",
		async () => {
			const queueA = `blok-test-q-a-${Math.random().toString(36).slice(2)}`;
			const queueB = `blok-test-q-b-${Math.random().toString(36).slice(2)}`;
			const receivedA: WorkerJob[] = [];
			const receivedB: WorkerJob[] = [];

			await adapter.process({ queue: queueA }, async (job) => {
				receivedA.push(job);
				await job.complete();
			});
			await adapter.process({ queue: queueB }, async (job) => {
				receivedB.push(job);
				await job.complete();
			});

			await adapter.addJob(queueA, { from: "A" });
			await adapter.addJob(queueB, { from: "B" });

			await waitFor(() => receivedA.length === 1 && receivedB.length === 1, TEST_TIMEOUT_MS - 5_000);

			expect(receivedA[0].data).toEqual({ from: "A" });
			expect(receivedB[0].data).toEqual({ from: "B" });
			expect(receivedA[0].queue).toBe(queueA);
			expect(receivedB[0].queue).toBe(queueB);

			await adapter.stopProcessing(queueA);
			await adapter.stopProcessing(queueB);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"delivers multiple jobs in order on a single-consumer queue",
		async () => {
			// Single consumer + prefetch(1) (the adapter's default for
			// non-concurrent processing) preserves FIFO order. With multiple
			// consumers Rabbit doesn't guarantee global order, so we keep
			// this test narrow to single-consumer semantics.
			const queue = `blok-test-q-order-${Math.random().toString(36).slice(2)}`;
			const received: number[] = [];

			await adapter.process({ queue }, async (job) => {
				const data = job.data as { n: number };
				received.push(data.n);
				await job.complete();
			});

			for (let i = 0; i < 5; i++) {
				await adapter.addJob(queue, { n: i });
			}

			await waitFor(() => received.length === 5, TEST_TIMEOUT_MS - 5_000);

			expect(received).toEqual([0, 1, 2, 3, 4]);

			await adapter.stopProcessing(queue);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"failed jobs requeue when retries remain (manual fail path)",
		async () => {
			// Adapter NACK-with-requeue contract: the same job message is
			// re-delivered after `fail()` until the retry budget is hit.
			// We assert one re-delivery here; the full retry-budget DLQ
			// flow is exercised by the adapter unit tests.
			const queue = `blok-test-q-retry-${Math.random().toString(36).slice(2)}`;
			let attempts = 0;
			let firstAttemptId = "";

			await adapter.process({ queue, retries: 1 }, async (job) => {
				attempts++;
				if (attempts === 1) {
					firstAttemptId = job.id;
					await job.fail(new Error("simulated transient failure"));
					return;
				}
				// Second delivery: ack so we exit cleanly.
				expect(job.id).toBe(firstAttemptId);
				await job.complete();
			});

			await adapter.addJob(queue, { will_retry: true });

			await waitFor(() => attempts >= 2, TEST_TIMEOUT_MS - 5_000);

			expect(attempts).toBeGreaterThanOrEqual(2);

			await adapter.stopProcessing(queue);
		},
		TEST_TIMEOUT_MS,
	);

	it("isConnected + healthCheck reflect the live state", async () => {
		expect(adapter.isConnected()).toBe(true);
		const healthy = await adapter.healthCheck();
		expect(healthy).toBe(true);
	});
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (predicate()) return;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}
