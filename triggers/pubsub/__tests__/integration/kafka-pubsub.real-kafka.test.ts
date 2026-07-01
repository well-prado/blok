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
	fetchTopicOffsets(topic: string): Promise<Array<{ partition: number; offset: string; high: string; low: string }>>;
	fetchTopicMetadata(opts: { topics: string[] }): Promise<unknown>;
}

interface KafkaConsumerForWarmup {
	connect(): Promise<void>;
	subscribe(opts: { topic: string; fromBeginning?: boolean }): Promise<void>;
	run(opts: { eachMessage: () => Promise<void> }): Promise<void>;
	disconnect(): Promise<void>;
}

interface KafkaClient {
	admin(): KafkaAdminClient;
	consumer(opts: { groupId: string }): KafkaConsumerForWarmup;
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

// retry: a single-broker Kafka can still transiently report "This server does
// not host this topic-partition" right after topic creation — leader/metadata
// propagation lags the admin createTopics({waitForLeaders:true}) ack. The
// beforeAll warmup narrows the window but can't fully close it on a contended
// CI broker, so let each test self-heal on a fresh produce/consume attempt.
d("KafkaPubSubAdapter — real Kafka", { retry: 2 }, () => {
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

		// Cold-start warmup. On a freshly booted broker (the CI case),
		// Kafka's `__consumer_offsets` topic and the group-coordinator
		// election aren't ready immediately after the broker accepts
		// admin connections. The first `consumer.run()` that triggers
		// `findCoordinator` hits the 5-retry budget before the offsets
		// topic is fully initialised and throws
		// `KafkaJSNumberOfRetriesExceeded: This is not the correct
		// coordinator for this group`.
		//
		// Drive that initialisation explicitly here: create a throwaway
		// topic, run a brief consumer against it (which forces group-
		// coordinator election), then disconnect. Subsequent real test
		// subscribes find a warm coordinator and skip the race.
		const warmupTopic = `blok-test-pubsub-warmup-${Math.random().toString(36).slice(2)}`;
		await admin.createTopics({
			waitForLeaders: true,
			topics: [{ topic: warmupTopic, numPartitions: 1, replicationFactor: 1 }],
		});
		const warmupConsumer = adminKafka.consumer({ groupId: `blok-test-warmup-${Math.random().toString(36).slice(2)}` });
		await warmupConsumer.connect();
		await warmupConsumer.subscribe({ topic: warmupTopic, fromBeginning: true });
		await warmupConsumer.run({
			eachMessage: async () => {
				/* never fires — topic stays empty */
			},
		});
		// Give the group coordinator a beat to finalise the join+sync
		// for the warmup group. Without this, the next test's subscribe
		// can still race on a brand-new group's coordinator lookup.
		await new Promise((r) => setTimeout(r, 2_000));
		await warmupConsumer.disconnect();
	}, TEST_TIMEOUT_MS);

	afterAll(async () => {
		// Best-effort cleanup. A failed test can leave a consumer in a
		// state where `disconnect()` hangs (kafkajs internal retry loop
		// still running). Wrap each call in a 5s timeout so a single
		// stuck consumer doesn't trip vitest's default 10s afterAll
		// cap and cascade-mask the real failure.
		const safeDisconnect = async (label: string, fn: () => Promise<void>): Promise<void> => {
			try {
				await Promise.race([
					fn(),
					new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} disconnect timed out`)), 5_000)),
				]);
			} catch {
				/* ignore — afterAll is best-effort */
			}
		};
		await safeDisconnect("consumerA", () => consumerA.disconnect());
		await safeDisconnect("consumerB", () => consumerB.disconnect());
		await safeDisconnect("producer", () => producer.disconnect());
		if (admin) {
			await safeDisconnect("admin", () => admin?.disconnect() ?? Promise.resolve());
		}
	}, 30_000);

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
		"nack (handler failure) suppresses the offset commit and the message is redelivered",
		async () => {
			// A failing handler nacks the message; the adapter must throw out
			// of eachMessage so kafkajs does NOT auto-commit the offset and
			// redelivers. Before the fix the nack() was a no-op and the offset
			// auto-committed — the failed message was lost.
			const topic = `blok-test-pubsub-redeliver-${Math.random().toString(36).slice(2)}`;
			await createTopic(topic, 1);
			const deliveries: number[] = [];
			let failFirst = true;

			await consumerA.subscribe(
				{
					topic,
					consumerGroup: `blok-rd-${Math.random().toString(36).slice(2)}`,
					durable: false,
					startFrom: "earliest",
				},
				async (msg) => {
					deliveries.push((msg.body as { n: number }).n);
					if (failFirst) {
						failFirst = false;
						await msg.nack(); // first delivery fails → must redeliver
					}
					// redelivery: no nack → offset commits, loop moves on
				},
			);

			await new Promise((r) => setTimeout(r, SUBSCRIPTION_WARMUP_MS));
			await producer.publish(topic, { n: 7 });

			await waitFor(() => deliveries.length >= 2, TEST_TIMEOUT_MS - 10_000);

			expect(deliveries.length).toBeGreaterThanOrEqual(2);
			// Every delivery is the SAME message (redelivered, not a new one).
			expect(deliveries.every((n) => n === 7)).toBe(true);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"startFrom {timestamp} replays only messages at or after the broker timestamp cursor",
		async () => {
			const topic = `blok-test-pubsub-seek-ts-${Math.random().toString(36).slice(2)}`;
			await createTopic(topic, 1);

			for (const n of [1, 2, 3]) await producer.publish(topic, { n, phase: "old" });
			await sleep(250);
			const cursorMs = Date.now();
			await sleep(250);
			for (const n of [4, 5, 6]) await producer.publish(topic, { n, phase: "new" });

			const seeker = new KafkaPubSubAdapter({ brokers: brokerList(), clientId: "blok-test-seek-ts" });
			const received: PubSubMessage[] = [];
			await seeker.connect();
			try {
				await seeker.subscribe(
					{
						topic,
						consumerGroup: `blok-seek-ts-${Math.random().toString(36).slice(2)}`,
						durable: false,
						startFrom: { timestamp: cursorMs },
					},
					async (msg) => {
						received.push(msg);
					},
				);

				await waitFor(() => received.length >= 3, TEST_TIMEOUT_MS - 15_000);
				await sleep(1_000);
			} finally {
				await seeker.disconnect().catch(() => {});
			}

			expect(received.map((m) => (m.body as { n: number }).n).sort((a, b) => a - b)).toEqual([4, 5, 6]);
			for (const msg of received) {
				expect((msg.body as { phase: string }).phase).toBe("new");
				expect(Number((msg.raw as { timestamp: string }).timestamp)).toBeGreaterThanOrEqual(cursorMs);
			}
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"startFrom {seq} seeks a single-partition topic to offset N",
		async () => {
			const topic = `blok-test-pubsub-seek-seq-${Math.random().toString(36).slice(2)}`;
			await createTopic(topic, 1);

			for (const n of [1, 2, 3, 4, 5, 6]) await producer.publish(topic, { n });

			if (!admin) throw new Error("admin not initialised");
			const p0 = (await admin.fetchTopicOffsets(topic)).find((offset) => offset.partition === 0);
			expect(p0?.offset).toBe("6");

			const seeker = new KafkaPubSubAdapter({ brokers: brokerList(), clientId: "blok-test-seek-seq" });
			const received: PubSubMessage[] = [];
			await seeker.connect();
			try {
				await seeker.subscribe(
					{
						topic,
						consumerGroup: `blok-seek-seq-${Math.random().toString(36).slice(2)}`,
						durable: false,
						startFrom: { seq: 3 },
					},
					async (msg) => {
						received.push(msg);
					},
				);

				await waitFor(() => received.length >= 3, TEST_TIMEOUT_MS - 15_000);
				await sleep(1_000);
			} finally {
				await seeker.disconnect().catch(() => {});
			}

			expect(received.map((m) => (m.body as { n: number }).n).sort((a, b) => a - b)).toEqual([4, 5, 6]);
			expect(received.map((m) => Number((m.raw as { offset: string }).offset)).sort((a, b) => a - b)).toEqual([
				3, 4, 5,
			]);
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

function brokerList(): string[] {
	return KAFKA_BROKERS?.split(",").map((s) => s.trim()) ?? [];
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (predicate()) return;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}
