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

	it(
		"ack:false → at-most-once: a throwing handler does NOT cause redelivery",
		async () => {
			const queue = `test-q-noack-${Math.random().toString(36).slice(2)}`;
			let calls = 0;

			// retries=3 would normally redeliver up to 4 times. Under ack:false the
			// consumer uses AckPolicy.None: the broker never tracks the message, so a
			// handler that throws is NOT redelivered. Exactly-once even on failure.
			await adapter.process({ queue, ack: false, retries: 3 }, async () => {
				calls++;
				throw new Error("boom — handler always fails");
			});

			await adapter.addJob(queue, { attempt: "should-not-redeliver" });

			// Wait for the first (and only) delivery.
			await waitFor(() => calls >= 1, TEST_TIMEOUT_MS - 8_000);

			// Hold long enough to catch a redelivery. With the bug (AckPolicy.Explicit),
			// the adapter's catch nak()s the message → the broker redelivers ~instantly,
			// so `calls` climbs past 1. With the fix (AckPolicy.None + nak skipped) it
			// stays at 1.
			await new Promise((r) => setTimeout(r, 3_000));

			expect(calls).toBe(1);

			await adapter.stopProcessing(queue);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"deadLetterQueue → an exhausted job is published to worker.<dlq>",
		async () => {
			const nats = await import("nats");
			const queue = `test-q-dlq-${Math.random().toString(36).slice(2)}`;
			const dlq = `dlq-${Math.random().toString(36).slice(2)}`;
			const dlqSubject = `worker.${dlq}`;
			const payload = { order: 42, note: "dead-letter-me" };

			// Independent core subscription on the DLQ subject. The adapter
			// dead-letters via nc.publish() (a normal NATS publish), so a core
			// subscriber on the subject receives it. Reuse the adapter's live
			// connection to avoid opening a second one.
			const sub = adapterNc(adapter).subscribe(dlqSubject);
			const dlqMessages: unknown[] = [];
			const jsonCodec = nats.JSONCodec();
			(async () => {
				for await (const m of sub) {
					try {
						dlqMessages.push(jsonCodec.decode(m.data));
					} catch {
						dlqMessages.push(m.data);
					}
				}
			})();
			// Give the core subscription a moment to register before publishing.
			await new Promise((r) => setTimeout(r, 200));

			// Handler simulates terminal failure: retries exhausted → fail(err, false).
			// WorkerTrigger.handleJob normally decides requeue vs DLQ; here we drive
			// the terminal path directly to exercise the adapter's dead-letter route.
			await adapter.process({ queue, deadLetterQueue: dlq, retries: 0 }, async (job) => {
				await job.fail(new Error("permanent failure"), false);
			});

			await adapter.addJob(queue, payload);

			await waitFor(() => dlqMessages.length >= 1, TEST_TIMEOUT_MS - 5_000);

			expect(dlqMessages).toHaveLength(1);
			expect(dlqMessages[0]).toEqual(payload);

			sub.unsubscribe();
			await adapter.stopProcessing(queue);
		},
		TEST_TIMEOUT_MS,
	);
});

/**
 * Reach into the adapter's live NATS connection so the DLQ test can subscribe
 * to the dead-letter subject without opening a second connection. The adapter
 * keeps `nc` private; this test-only accessor reads it via an index signature.
 */
/** Minimal shape of the bits of the live NATS connection this test touches. */
interface TestNc {
	subscribe: (subject: string) => AsyncIterable<{ data: Uint8Array }>;
}
function adapterNc(a: NATSWorkerAdapter): TestNc {
	return (a as unknown as { nc: TestNc }).nc;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (predicate()) return;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}
