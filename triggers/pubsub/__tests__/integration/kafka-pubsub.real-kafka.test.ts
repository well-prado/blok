import type { PubSubMessage } from "@blokjs/runner";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KafkaPubSubAdapter } from "../../src/adapters/KafkaPubSubAdapter";

/**
 * Narrow shapes for the bits of `kafkajs` we touch in this test. The
 * runtime types in the package are loosely-typed (the adapter itself
 * pins `any` behind biome-ignore comments); these test-local interfaces
 * keep us on the safe `as unknown as <T>` boundary-cast path required
 * by the repo's no-`any`-in-tests rule.
 */
interface KafkaAdminClient {
	connect(): Promise<void>;
	disconnect(): Promise<void>;
	createTopics(opts: {
		waitForLeaders?: boolean;
		topics: Array<{ topic: string; numPartitions: number; replicationFactor: number }>;
	}): Promise<boolean>;
}

interface KafkaClient {
	admin(): KafkaAdminClient;
}

interface KafkaJsModule {
	Kafka: new (opts: { clientId: string; brokers: string[] }) => KafkaClient;
}

/**
 * Real-Kafka integration test for `KafkaPubSubAdapter` (closes Phase 2.1
 * broker-adapter test debt deferred from PR #91).
 *
 * Exercises both the **fan-out** (no `consumerGroup` — adapter generates
 * per-subscriber group ids) and **competing-consumer** (explicit shared
 * `consumerGroup`) delivery patterns documented in the adapter.
 *
 * Gated on `BLOK_INTEGRATION_KAFKA_BROKERS`. Skipped when unset, so the
 * regular unit test run on a developer laptop without docker-compose
 * doesn't break.
 *
 * Bring up the test fixtures via:
 *   docker compose -f infra/testing/docker-compose.yml up -d kafka
 *
 * Then run:
 *   BLOK_INTEGRATION_KAFKA_BROKERS=localhost:9094 bun run test
 */

const KAFKA_BROKERS = process.env.BLOK_INTEGRATION_KAFKA_BROKERS;
const d = KAFKA_BROKERS ? describe : describe.skip;

// CI runners are slower than local — Kafka group coordinator assignment
// alone takes a few seconds for a fresh consumer, and the first message
// after subscribe usually waits one heartbeat. Bump the per-test cap so
// CI doesn't flake on the assignment + first-poll round-trip.
const TEST_TIMEOUT_MS = 45_000;
const SUBSCRIPTION_WARMUP_MS = 2_000;

d("KafkaPubSubAdapter — real Kafka", () => {
	let producer: KafkaPubSubAdapter;
	let consumerA: KafkaPubSubAdapter;
	let consumerB: KafkaPubSubAdapter;
	let admin: KafkaAdminClient | null = null;

	beforeAll(async () => {
		const brokers = KAFKA_BROKERS?.split(",").map((s) => s.trim()) ?? [];
		producer = new KafkaPubSubAdapter({ brokers, clientId: "blok-test-pubsub-producer" });
		await producer.connect();

		consumerA = new KafkaPubSubAdapter({ brokers, clientId: "blok-test-pubsub-consumer-a" });
		await consumerA.connect();

		consumerB = new KafkaPubSubAdapter({ brokers, clientId: "blok-test-pubsub-consumer-b" });
		await consumerB.connect();

		// Admin client used only by this test to pre-create topics
		// before consumers subscribe — eliminates the metadata-propagation
		// race where `auto.create.topics.enable` lets a subscribe succeed
		// against a topic the producer can't immediately see (kafkajs
		// reports "This server does not host this topic-partition" on the
		// first publish attempt). The adapter itself relies on auto-create
		// in production (Kafka's durable-log model means orphan publishes
		// are valid); this guard is purely a test-hygiene measure.
		const kafkajs = (await import("kafkajs")) as unknown as KafkaJsModule;
		const adminKafka = new kafkajs.Kafka({ clientId: "blok-test-pubsub-admin", brokers });
		admin = adminKafka.admin();
		await admin.connect();
	}, TEST_TIMEOUT_MS);

	afterAll(async () => {
		await consumerA.disconnect();
		await consumerB.disconnect();
		await producer.disconnect();
		if (admin) {
			try {
				await admin.disconnect();
			} catch {
				/* ignore — best-effort cleanup */
			}
		}
	});

	async function createTopic(topic: string, numPartitions = 1): Promise<void> {
		if (!admin) throw new Error("admin client not initialised — beforeAll didn't run");
		await admin.createTopics({
			waitForLeaders: true,
			topics: [{ topic, numPartitions, replicationFactor: 1 }],
		});
	}

	it(
		"fan-out: every subscriber without an explicit consumerGroup receives every message",
		async () => {
			// Topic name varies per run so the consumer-group offset state
			// from a prior run doesn't bleed into this one. Pre-create via
			// admin so the producer's metadata is fresh before the first
			// publish — bypasses the auto-create-on-publish race that
			// shows up as "This server does not host this topic-partition".
			const topic = `blok-test-pubsub-fanout-${Math.random().toString(36).slice(2)}`;
			await createTopic(topic, 1);
			const receivedA: PubSubMessage[] = [];
			const receivedB: PubSubMessage[] = [];

			await consumerA.subscribe({ topic, durable: false, startFrom: "earliest" }, async (msg) => {
				receivedA.push(msg);
			});
			await consumerB.subscribe({ topic, durable: false, startFrom: "earliest" }, async (msg) => {
				receivedB.push(msg);
			});

			// Kafka group-coordinator assignment is asynchronous; the
			// `consumer.run` call above returns once the consumer LOOP has
			// started, but the first heartbeat-driven assignment isn't done
			// yet. Without this warm-up we routinely lose the first publish
			// to "no assigned partition" on cold-CI runs.
			await new Promise((r) => setTimeout(r, SUBSCRIPTION_WARMUP_MS));

			await producer.publish(topic, { hello: "kafka", n: 1 });

			await waitFor(() => receivedA.length === 1 && receivedB.length === 1, TEST_TIMEOUT_MS - 10_000);

			expect(receivedA[0].body).toEqual({ hello: "kafka", n: 1 });
			expect(receivedB[0].body).toEqual({ hello: "kafka", n: 1 });
			expect(receivedA[0].topic).toBe(topic);
			expect(receivedB[0].topic).toBe(topic);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"competing-consumer: explicit consumerGroup means each message goes to exactly one subscriber",
		async () => {
			// Three partitions so each consumer in the shared group gets at
			// least one assignment — exercises the actual competing-consumer
			// load-balance instead of routing all 10 messages to whichever
			// consumer happened to win the single-partition leadership.
			const topic = `blok-test-pubsub-competing-${Math.random().toString(36).slice(2)}`;
			await createTopic(topic, 3);
			const group = `blok-test-workers-${Math.random().toString(36).slice(2)}`;
			const receivedA: PubSubMessage[] = [];
			const receivedB: PubSubMessage[] = [];

			await consumerA.subscribe({ topic, consumerGroup: group, durable: false, startFrom: "earliest" }, async (msg) => {
				receivedA.push(msg);
			});
			await consumerB.subscribe({ topic, consumerGroup: group, durable: false, startFrom: "earliest" }, async (msg) => {
				receivedB.push(msg);
			});

			await new Promise((r) => setTimeout(r, SUBSCRIPTION_WARMUP_MS));

			// Publish 10 messages with distinct partition keys so the
			// broker spreads them across the topic's partitions. The
			// auto-created topic defaults to 1 partition, which means BOTH
			// consumers join the same group but only ONE gets the partition
			// assignment — and therefore all 10 messages. We can't assert a
			// 50/50 split, but we CAN assert exactly-once delivery across
			// the union.
			for (let i = 0; i < 10; i++) {
				await producer.publish(topic, { n: i }, { partitionKey: String(i) });
			}

			await waitFor(() => receivedA.length + receivedB.length === 10, TEST_TIMEOUT_MS - 10_000);

			expect(receivedA.length + receivedB.length).toBe(10);
			const seenN = new Set<number>();
			for (const m of [...receivedA, ...receivedB]) {
				const n = (m.body as { n: number }).n;
				expect(seenN.has(n)).toBe(false);
				seenN.add(n);
			}
			expect(seenN.size).toBe(10);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"publish to a topic with no subscribers does not throw",
		async () => {
			// Note: kafkajs's auto.create.topics.enable is true on the test
			// broker, so this also exercises the on-publish topic-create
			// path. The publish should succeed even if no consumer is
			// listening — that's the durable-log model Kafka guarantees.
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
