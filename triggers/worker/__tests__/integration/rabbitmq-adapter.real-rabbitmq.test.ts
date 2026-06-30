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

	it(
		"delivers higher-priority jobs before lower-priority ones (priority queue)",
		async () => {
			// The queue must be declared with x-max-priority for Rabbit to
			// honour the per-message `priority`. We enqueue a batch of mixed
			// priorities while NO consumer is attached (so they all sit in the
			// queue and Rabbit can reorder), then start consuming and assert
			// the broker hands them back high-priority-first.
			//
			// REGRESSION GUARD: without `maxPriority` on assertQueue the queue
			// is a plain FIFO and this comes back [1,1,5,9,3] (publish order),
			// failing the "first delivered is priority 9" assertion below.
			const queue = `blok-test-q-prio-${Math.random().toString(36).slice(2)}`;
			const priorities = [1, 9, 3, 1, 5];

			// Enqueue first (addJob declares the priority queue). No consumer yet.
			for (const p of priorities) {
				await adapter.addJob(queue, { p }, { priority: p });
			}

			// Give the broker a beat to settle all enqueues before consuming,
			// so reordering is across the whole batch, not a race with publish.
			await new Promise((r) => setTimeout(r, 500));

			const deliveredPriorities: number[] = [];
			await adapter.process({ queue, concurrency: 1 }, async (job) => {
				deliveredPriorities.push((job.data as { p: number }).p);
				await job.complete();
			});

			await waitFor(() => deliveredPriorities.length === priorities.length, TEST_TIMEOUT_MS - 5_000);

			// The single highest-priority message must come out first.
			expect(deliveredPriorities[0]).toBe(9);
			// And the set is non-increasing overall (priority ordering, not FIFO).
			const sortedDesc = [...priorities].sort((a, b) => b - a);
			expect(deliveredPriorities).toEqual(sortedDesc);

			await adapter.stopProcessing(queue);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"connects to a dedicated vhost and round-trips a job through it",
		async () => {
			// vhost is set on a string URL — amqplib reads it from the URL
			// path, so the adapter must encode it there. With the bug (vhost
			// passed as socket options) the connection lands on the default
			// "/" vhost and `connect()` would either fail (vhost not present)
			// or publish into the wrong vhost. We prove isolation by creating
			// a fresh vhost via the management API, connecting WITH it, and
			// round-tripping a job.
			const vhost = `blok-test-vhost-${Math.random().toString(36).slice(2)}`;
			await createVhost(vhost);
			const vhostAdapter = new RabbitMQAdapter({ url: RABBITMQ_URL, vhost });
			try {
				await vhostAdapter.connect();
				expect(vhostAdapter.isConnected()).toBe(true);

				const queue = `blok-test-q-vhost-${Math.random().toString(36).slice(2)}`;
				const received: WorkerJob[] = [];
				await vhostAdapter.process({ queue }, async (job) => {
					received.push(job);
					await job.complete();
				});
				await vhostAdapter.addJob(queue, { in: vhost });

				await waitFor(() => received.length === 1, TEST_TIMEOUT_MS - 5_000);
				expect(received[0].data).toEqual({ in: vhost });

				// Broker-side proof: the queue exists IN THE TEST VHOST per the
				// management API (not on "/"), so the connection really used it.
				const queues = await listQueues(vhost);
				expect(queues.map((q) => q.name)).toContain(queue);

				await vhostAdapter.stopProcessing(queue);
			} finally {
				await vhostAdapter.disconnect();
				await deleteVhost(vhost);
			}
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"rejects opts.delay with a clear config error on a broker without the delayed-message plugin",
		async () => {
			// Stock rabbitmq:3.13-management has no
			// rabbitmq_delayed_message_exchange plugin. Silently dropping the
			// delay would deliver immediately and lie to the caller, so the
			// adapter must throw.
			const queue = `blok-test-q-delay-${Math.random().toString(36).slice(2)}`;
			await expect(adapter.addJob(queue, { x: 1 }, { delay: 5_000 })).rejects.toThrow(
				/delayed delivery|delayed_message|plugin/i,
			);
		},
		TEST_TIMEOUT_MS,
	);
});

// --- RabbitMQ management HTTP API helpers (test setup only) ---------------
// The management API runs on :15672 with the same creds as the broker. We
// derive its base URL from BLOK_INTEGRATION_RABBITMQ_URL so the test follows
// whatever host/creds the broker uses. Creating/deleting a vhost via this API
// is allowed test SETUP — it never starts/stops the broker container.

function managementBase(): { base: string; auth: string } {
	const u = new URL(RABBITMQ_URL as string);
	const auth = `Basic ${Buffer.from(`${u.username || "guest"}:${u.password || "guest"}`).toString("base64")}`;
	return { base: `http://${u.hostname}:15672/api`, auth };
}

async function createVhost(name: string): Promise<void> {
	const { base, auth } = managementBase();
	const res = await fetch(`${base}/vhosts/${encodeURIComponent(name)}`, {
		method: "PUT",
		headers: { authorization: auth, "content-type": "application/json" },
		body: "{}",
	});
	if (!res.ok) throw new Error(`createVhost(${name}) failed: ${res.status} ${await res.text()}`);
}

async function deleteVhost(name: string): Promise<void> {
	const { base, auth } = managementBase();
	const res = await fetch(`${base}/vhosts/${encodeURIComponent(name)}`, {
		method: "DELETE",
		headers: { authorization: auth },
	});
	// 404 is fine on teardown (already gone); anything else is a real failure.
	if (!res.ok && res.status !== 404) throw new Error(`deleteVhost(${name}) failed: ${res.status}`);
}

async function listQueues(vhost: string): Promise<Array<{ name: string }>> {
	const { base, auth } = managementBase();
	const res = await fetch(`${base}/queues/${encodeURIComponent(vhost)}`, { headers: { authorization: auth } });
	if (!res.ok) throw new Error(`listQueues(${vhost}) failed: ${res.status}`);
	return (await res.json()) as Array<{ name: string }>;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (predicate()) return;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}
