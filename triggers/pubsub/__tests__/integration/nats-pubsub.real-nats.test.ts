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
// Durable subscriptions also create a JetStream stream + consumer, which
// takes longer to install than a Core subscription — give it more headroom.
const DURABLE_WARMUP_MS = 1_000;

function newAdapter(): NATSPubSubAdapter {
	return new NATSPubSubAdapter({ servers: NATS_SERVERS?.split(",").map((s) => s.trim()) ?? [] });
}
const rndGroup = (p: string) => `${p}-${Math.random().toString(36).slice(2)}`;

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

	it(
		"durable: replays retained history from `earliest` and from a `{seq}` cursor",
		async () => {
			const topic = `blok-test-pubsub-durable-replay-${Math.random().toString(36).slice(2)}`;
			const live = newAdapter();
			const replay = newAdapter();
			const seqCons = newAdapter();
			await Promise.all([live.connect(), replay.connect(), seqCons.connect()]);
			try {
				// Live durable consumer — captures the stream sequence numbers
				// (message.id is `stream:seq`) so we can replay from a cursor.
				const liveRecv: PubSubMessage[] = [];
				await live.subscribe({ topic, durable: true, consumerGroup: rndGroup("g-live") }, async (m) => {
					liveRecv.push(m);
				});
				await new Promise((r) => setTimeout(r, DURABLE_WARMUP_MS));

				for (let i = 0; i < 3; i++) await producer.publish(topic, { n: i });
				await waitFor(() => liveRecv.length === 3, TEST_TIMEOUT_MS - 5_000);
				expect(liveRecv.length).toBe(3);

				// Fresh durable consumer, startFrom "earliest" → full history.
				const replayRecv: PubSubMessage[] = [];
				await replay.subscribe(
					{ topic, durable: true, consumerGroup: rndGroup("g-replay"), startFrom: "earliest" },
					async (m) => {
						replayRecv.push(m);
					},
				);
				await waitFor(() => replayRecv.length === 3, TEST_TIMEOUT_MS - 5_000);
				expect(replayRecv.map((m) => (m.body as { n: number }).n).sort()).toEqual([0, 1, 2]);

				// Fresh durable consumer, startFrom the 2nd stream sequence →
				// only the tail (2 of 3 messages).
				const seqs = liveRecv.map((m) => Number(m.id.split(":")[1])).sort((a, b) => a - b);
				const seqRecv: PubSubMessage[] = [];
				await seqCons.subscribe(
					{ topic, durable: true, consumerGroup: rndGroup("g-seq"), startFrom: { seq: seqs[1] } },
					async (m) => {
						seqRecv.push(m);
					},
				);
				await waitFor(() => seqRecv.length === 2, TEST_TIMEOUT_MS - 5_000);
				expect(seqRecv.length).toBe(2);
			} finally {
				await Promise.all([live.disconnect(), replay.disconnect(), seqCons.disconnect()]);
			}
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"durable: a thrown handler nacks and JetStream redelivers",
		async () => {
			const topic = `blok-test-pubsub-durable-redeliver-${Math.random().toString(36).slice(2)}`;
			const cons = newAdapter();
			await cons.connect();
			try {
				const redeliveryCounts: number[] = [];
				let failFirst = true;
				await cons.subscribe({ topic, durable: true, consumerGroup: rndGroup("g-rd") }, async (m) => {
					redeliveryCounts.push((m.raw as { info: { redeliveryCount: number } }).info.redeliveryCount);
					if (failFirst) {
						failFirst = false;
						throw new Error("forced failure → nack");
					}
				});
				await new Promise((r) => setTimeout(r, DURABLE_WARMUP_MS));

				await producer.publish(topic, { evt: "redeliver-me" });
				await waitFor(() => redeliveryCounts.length >= 2, TEST_TIMEOUT_MS - 5_000);

				expect(redeliveryCounts.length).toBeGreaterThanOrEqual(2);
				// JetStream increments redeliveryCount on each re-delivery.
				expect(redeliveryCounts[1]).toBeGreaterThan(redeliveryCounts[0]);
			} finally {
				await cons.disconnect();
			}
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
