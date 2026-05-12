import type { WorkerJob } from "@blokjs/runner";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NATSWorkerAdapter } from "../../src/adapters/NATSAdapter";

/**
 * Real-NATS integration test for `NATSWorkerAdapter` (closes the
 * integration test debt from PR #86).
 *
 * Gated on `BLOK_INTEGRATION_NATS_SERVERS`. Skipped when unset.
 *
 * Bring up the test fixtures via:
 *   docker compose -f infra/testing/docker-compose.yml up -d nats
 */

const NATS_SERVERS = process.env.BLOK_INTEGRATION_NATS_SERVERS;
const d = NATS_SERVERS ? describe : describe.skip;

// CI runners are slower than local — JetStream stream + consumer
// creation + first poll cycle can take several seconds on a cold
// container. Override the 5s default so CI doesn't flake.
const TEST_TIMEOUT_MS = 30_000;

d("NATSWorkerAdapter — real NATS JetStream", () => {
	let adapter: NATSWorkerAdapter;
	const stream = `blok-test-worker-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

	beforeAll(async () => {
		adapter = new NATSWorkerAdapter({
			servers: NATS_SERVERS?.split(",").map((s) => s.trim()) ?? [],
			streamName: stream,
		});
		await adapter.connect();
	});

	afterAll(async () => {
		await adapter.disconnect();
	});

	it(
		"publishes a job and the consumer receives it",
		async () => {
			const queue = `test-q-publish-${Math.random().toString(36).slice(2)}`;
			const received: WorkerJob[] = [];

			await adapter.process({ queue }, async (job) => {
				received.push(job);
				await job.complete();
			});

			const jobId = await adapter.addJob(queue, { hello: "world", n: 1 });
			expect(typeof jobId).toBe("string");

			// Wait for delivery — NATS JetStream is durable; consumer pulls within ms.
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
		"isolates jobs across queues",
		async () => {
			const queueA = `test-q-a-${Math.random().toString(36).slice(2)}`;
			const queueB = `test-q-b-${Math.random().toString(36).slice(2)}`;
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

	it("isConnected reflects state", async () => {
		expect(adapter.isConnected()).toBe(true);
	});

	it("healthCheck returns true when connected", async () => {
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
