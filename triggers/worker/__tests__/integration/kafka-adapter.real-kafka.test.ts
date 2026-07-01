import type { WorkerJob } from "@blokjs/runner";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KafkaAdapter } from "../../src/adapters/KafkaAdapter";

/**
 * Real-Kafka integration test for `KafkaAdapter` (issue #593).
 *
 * Proves the three behaviors the adversarial audit flagged as broken:
 *   1. A handler failure does NOT crash-loop the consumer — the poison
 *      message's offset commits and a later-enqueued job still completes.
 *      (Pre-fix: eachMessage re-threw → offset never committed → kafkajs
 *      redelivered the SAME message forever, starving every job behind it.)
 *   2. A job that exhausts `retries` is produced to `deadLetterQueue`
 *      (subscribe to the DLQ topic and assert the payload).
 *   3. `priority` / `delay` are rejected with a clear config error — Kafka
 *      is an ordered log with no native priority or scheduling.
 *
 * Gated on `BLOK_INTEGRATION_KAFKA_BROKERS`. Skipped when unset, so the
 * regular unit run on a laptop without docker-compose doesn't break.
 *
 * Run:
 *   BLOK_INTEGRATION_KAFKA_BROKERS=localhost:9092 \
 *     bunx vitest run __tests__/integration/kafka-adapter.real-kafka.test.ts --root triggers/worker
 */

// Narrow shapes for the bits of `kafkajs` this test touches directly (admin
// topic pre-create + a throwaway consumer for the DLQ assertion). Keeps us on
// the safe `as unknown as <T>` boundary-cast path required by the no-`any`
// rule — the adapter itself pins the client behind biome-ignore comments.
interface KafkaAdminClient {
	connect(): Promise<void>;
	disconnect(): Promise<void>;
	createTopics(opts: {
		waitForLeaders?: boolean;
		topics: Array<{ topic: string; numPartitions: number; replicationFactor: number }>;
	}): Promise<boolean>;
}
interface KafkaConsumerForTest {
	connect(): Promise<void>;
	subscribe(opts: { topic: string; fromBeginning?: boolean }): Promise<void>;
	run(opts: {
		eachMessage: (payload: { message: { value?: Buffer | null; headers?: Record<string, Buffer> } }) => Promise<void>;
	}): Promise<void>;
	disconnect(): Promise<void>;
}
interface KafkaClient {
	admin(): KafkaAdminClient;
	consumer(opts: { groupId: string }): KafkaConsumerForTest;
}
interface KafkaJsModule {
	Kafka: new (opts: { clientId: string; brokers: string[] }) => KafkaClient;
}

const KAFKA_BROKERS = process.env.BLOK_INTEGRATION_KAFKA_BROKERS;
const d = KAFKA_BROKERS ? describe : describe.skip;

// Kafka is slow: group-coordinator election + first-poll heartbeat alone eats
// several seconds on a cold broker. Generous per-test cap per the campaign.
const TEST_TIMEOUT_MS = 60_000;
const SUBSCRIPTION_WARMUP_MS = 2_500;

// A single-broker Kafka can transiently report "This server does not host this
// topic-partition" right after topic creation (leader/metadata propagation
// lags the admin ack). retry:2 lets a flaky first poll self-heal.
d("KafkaAdapter — real Kafka", { retry: 2 }, () => {
	const brokers = KAFKA_BROKERS?.split(",").map((s) => s.trim()) ?? [];
	let adapter: KafkaAdapter;
	let admin: KafkaAdminClient | null = null;
	let kafkajs: KafkaJsModule;

	beforeAll(async () => {
		adapter = new KafkaAdapter({ brokers, clientId: "blok-test-worker-kafka" });
		await adapter.connect();

		kafkajs = (await import("kafkajs")) as unknown as KafkaJsModule;
		const adminKafka = new kafkajs.Kafka({ clientId: "blok-test-worker-admin", brokers });
		admin = adminKafka.admin();
		await admin.connect();

		// Cold-start warmup (mirrors the pubsub kafka test): force the group
		// coordinator election on a throwaway topic so the real tests find a
		// warm coordinator and skip the "not the correct coordinator" race.
		const warmupTopic = `blok-test-worker-warmup-${Math.random().toString(36).slice(2)}`;
		await admin.createTopics({
			waitForLeaders: true,
			topics: [{ topic: warmupTopic, numPartitions: 1, replicationFactor: 1 }],
		});
		const warmupConsumer = adminKafka.consumer({
			groupId: `blok-test-worker-warmup-${Math.random().toString(36).slice(2)}`,
		});
		await warmupConsumer.connect();
		await warmupConsumer.subscribe({ topic: warmupTopic, fromBeginning: true });
		await warmupConsumer.run({ eachMessage: async () => {} });
		await new Promise((r) => setTimeout(r, 2_000));
		await warmupConsumer.disconnect();
	}, TEST_TIMEOUT_MS);

	afterAll(async () => {
		const safe = async (fn: () => Promise<void>): Promise<void> => {
			try {
				await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 8_000))]);
			} catch {
				/* best-effort */
			}
		};
		await safe(() => adapter.disconnect());
		if (admin) await safe(() => admin?.disconnect() ?? Promise.resolve());
	}, 30_000);

	async function createTopic(topic: string, numPartitions = 1): Promise<void> {
		if (!admin) throw new Error("admin client not initialised — beforeAll didn't run");
		await admin.createTopics({
			waitForLeaders: true,
			topics: [{ topic, numPartitions, replicationFactor: 1 }],
		});
	}

	it(
		"handler failure does NOT crash-loop: a later job still completes after an earlier one throws",
		async () => {
			const topic = `blok-test-worker-crashloop-${Math.random().toString(36).slice(2)}`;
			await createTopic(topic, 1);
			const completed: unknown[] = [];
			let poisonDeliveries = 0;

			// retries:0 → the poison message is committed (no DLQ set) and the
			// consumer must advance to the second, healthy message. Single
			// partition guarantees strict ordering, so if the fix works the
			// healthy job can ONLY run after the poison offset committed.
			await adapter.process({ queue: topic, retries: 0 }, async (job) => {
				const body = job.data as { poison?: boolean; n?: number };
				if (body.poison) {
					poisonDeliveries += 1;
					throw new Error("boom — poison message"); // raw throw = the audit bug scenario
				}
				completed.push(body);
				await job.complete();
			});

			await new Promise((r) => setTimeout(r, SUBSCRIPTION_WARMUP_MS));

			await adapter.addJob(topic, { poison: true }); // fails first (same partition, in order)
			await adapter.addJob(topic, { poison: false, n: 2 }); // must still complete

			await waitFor(() => completed.length === 1, TEST_TIMEOUT_MS - 10_000);

			expect(completed).toEqual([{ poison: false, n: 2 }]);
			// Poison committed after ONE delivery — not redelivered forever.
			// Give redelivery a window to (wrongly) fire; with the bug this climbs.
			await new Promise((r) => setTimeout(r, 3_000));
			expect(poisonDeliveries).toBe(1);

			await adapter.stopProcessing(topic);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"deadLetterQueue: a job exhausting retries is produced to the DLQ topic",
		async () => {
			const topic = `blok-test-worker-dlq-src-${Math.random().toString(36).slice(2)}`;
			const dlq = `blok-test-worker-dlq-dst-${Math.random().toString(36).slice(2)}`;
			await createTopic(topic, 1);
			await createTopic(dlq, 1);
			const payload = { order: 42, note: "dead-letter-me" };

			// Independent consumer on the DLQ topic to capture the dead-lettered
			// payload. Separate group so it reads the DLQ from the beginning.
			const dlqKafka = new kafkajs.Kafka({ clientId: "blok-test-dlq-reader", brokers });
			const dlqConsumer = dlqKafka.consumer({ groupId: `blok-test-dlq-${Math.random().toString(36).slice(2)}` });
			await dlqConsumer.connect();
			await dlqConsumer.subscribe({ topic: dlq, fromBeginning: true });
			const dlqMessages: unknown[] = [];
			const dlqHeaders: Record<string, string>[] = [];
			await dlqConsumer.run({
				eachMessage: async ({ message }) => {
					const raw = message.value?.toString() ?? "";
					try {
						dlqMessages.push(JSON.parse(raw));
					} catch {
						dlqMessages.push(raw);
					}
					const h: Record<string, string> = {};
					if (message.headers) for (const [k, v] of Object.entries(message.headers)) h[k] = v?.toString() ?? "";
					dlqHeaders.push(h);
				},
			});

			// retries:0 → terminal on first failure. The handler drives the
			// terminal path directly (job.fail(err, false)), exactly as
			// WorkerTrigger.handleJob does when attempts are exhausted.
			await adapter.process({ queue: topic, deadLetterQueue: dlq, retries: 0 }, async (job) => {
				await job.fail(new Error("permanent failure"), false);
			});

			await new Promise((r) => setTimeout(r, SUBSCRIPTION_WARMUP_MS));
			await adapter.addJob(topic, payload);

			await waitFor(() => dlqMessages.length >= 1, TEST_TIMEOUT_MS - 12_000);

			expect(dlqMessages).toHaveLength(1);
			expect(dlqMessages[0]).toEqual(payload);
			expect(dlqHeaders[0]?.["x-blok-source-topic"]).toBe(topic);

			await dlqConsumer.disconnect();
			await adapter.stopProcessing(topic);
		},
		TEST_TIMEOUT_MS,
	);

	it("priority / delay are rejected with a clear config error", async () => {
		const topic = `blok-test-worker-reject-${Math.random().toString(36).slice(2)}`;
		// addJob-level rejects (per-job opts).
		await expect(adapter.addJob(topic, { a: 1 }, { priority: 5 })).rejects.toThrow(/no native message priority/);
		await expect(adapter.addJob(topic, { a: 1 }, { delay: 1000 })).rejects.toThrow(/no native delayed delivery/);
		// process-level rejects (config) — must throw before subscribing.
		await expect(adapter.process({ queue: topic, priority: 5 }, async () => {})).rejects.toThrow(
			/no native message priority/,
		);
		await expect(adapter.process({ queue: topic, delay: 1000 }, async () => {})).rejects.toThrow(
			/no native delayed delivery/,
		);
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
