import type { PubSubMessage } from "@blokjs/runner";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NATSPubSubAdapter } from "../../src/adapters/NATSPubSubAdapter";

/**
 * Real-NATS integration test for `NATSPubSubAdapter` (closes the
 * integration test debt from PR #87).
 *
 * Exercises both the **fan-out** (no `consumerGroup`) and
 * **competing-consumer** (with `consumerGroup`) delivery patterns
 * documented in the trigger.
 *
 * Gated on `BLOK_INTEGRATION_NATS_SERVERS`. Skipped when unset.
 *
 * Bring up the test fixtures via:
 *   docker compose -f infra/testing/docker-compose.yml up -d nats
 */

const NATS_SERVERS = process.env.BLOK_INTEGRATION_NATS_SERVERS;
const d = NATS_SERVERS ? describe : describe.skip;

// CI runners are slower than local — JetStream stream + consumer creation
// + cross-instance subscription propagation can take several seconds on
// a cold container. Override the default 5s timeout so CI doesn't flake.
const TEST_TIMEOUT_MS = 30_000;
const SUBSCRIPTION_WARMUP_MS = 500;

d("NATSPubSubAdapter — real NATS", () => {
	let producer: NATSPubSubAdapter;
	let consumerA: NATSPubSubAdapter;
	let consumerB: NATSPubSubAdapter;

	beforeAll(async () => {
		producer = new NATSPubSubAdapter({
			servers: NATS_SERVERS?.split(",").map((s) => s.trim()) ?? [],
		});
		await producer.connect();

		consumerA = new NATSPubSubAdapter({
			servers: NATS_SERVERS?.split(",").map((s) => s.trim()) ?? [],
		});
		await consumerA.connect();

		consumerB = new NATSPubSubAdapter({
			servers: NATS_SERVERS?.split(",").map((s) => s.trim()) ?? [],
		});
		await consumerB.connect();
	});

	afterAll(async () => {
		await consumerA.disconnect();
		await consumerB.disconnect();
		await producer.disconnect();
	});

	it(
		"fan-out: every subscriber without consumerGroup receives every message",
		async () => {
			const topic = `blok-test-pubsub-fanout-${Math.random().toString(36).slice(2)}`;
			const receivedA: PubSubMessage[] = [];
			const receivedB: PubSubMessage[] = [];

			await consumerA.subscribe({ topic, durable: false }, async (msg) => {
				receivedA.push(msg);
			});
			await consumerB.subscribe({ topic, durable: false }, async (msg) => {
				receivedB.push(msg);
			});

			// JetStream subscription registration is asynchronous — give the
			// consumer a moment to install before publishing.
			await new Promise((r) => setTimeout(r, SUBSCRIPTION_WARMUP_MS));

			await producer.publish(topic, { hello: "world", n: 1 });

			await waitFor(() => receivedA.length === 1 && receivedB.length === 1, TEST_TIMEOUT_MS - 5_000);

			expect(receivedA[0].body).toEqual({ hello: "world", n: 1 });
			expect(receivedB[0].body).toEqual({ hello: "world", n: 1 });
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"competing-consumer: consumerGroup means each message goes to one subscriber",
		async () => {
			const topic = `blok-test-pubsub-competing-${Math.random().toString(36).slice(2)}`;
			const group = "workers";
			const receivedA: PubSubMessage[] = [];
			const receivedB: PubSubMessage[] = [];

			await consumerA.subscribe({ topic, consumerGroup: group, durable: false }, async (msg) => {
				receivedA.push(msg);
			});
			await consumerB.subscribe({ topic, consumerGroup: group, durable: false }, async (msg) => {
				receivedB.push(msg);
			});

			await new Promise((r) => setTimeout(r, SUBSCRIPTION_WARMUP_MS));

			// Publish 10 messages — should split across A + B (not exact 50/50
			// but each message reaches exactly one).
			for (let i = 0; i < 10; i++) {
				await producer.publish(topic, { n: i });
			}

			await waitFor(() => receivedA.length + receivedB.length === 10, TEST_TIMEOUT_MS - 5_000);

			expect(receivedA.length + receivedB.length).toBe(10);
			// No duplicate keys across both lists.
			const seenN = new Set<number>();
			for (const m of [...receivedA, ...receivedB]) {
				const n = (m.body as { n: number }).n;
				expect(seenN.has(n)).toBe(false);
				seenN.add(n);
			}
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"publish to an unsubscribed topic does not throw",
		async () => {
			const topic = `blok-test-pubsub-orphan-${Math.random().toString(36).slice(2)}`;
			await expect(producer.publish(topic, { dropped: true })).resolves.toBeUndefined();
		},
		TEST_TIMEOUT_MS,
	);
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (predicate()) return;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}
