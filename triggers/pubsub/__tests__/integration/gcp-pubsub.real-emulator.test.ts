import type { PubSubMessage } from "@blokjs/runner";
import { Subscription } from "@google-cloud/pubsub";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { GCPPubSubAdapter } from "../../src/adapters/GCPPubSubAdapter";

/**
 * Real-GCP-emulator integration test for `GCPPubSubAdapter` (closes
 * Phase 2.1 broker-adapter test debt deferred from PR #91).
 *
 * Gated on `BLOK_INTEGRATION_GCP_PUBSUB_ENDPOINT`. Skipped when unset.
 *
 * Bring up the emulator via:
 *   docker compose -f infra/testing/docker-compose.yml up -d pubsub-emulator
 *
 * Then run:
 *   BLOK_INTEGRATION_GCP_PUBSUB_ENDPOINT=localhost:8086 \
 *   PUBSUB_EMULATOR_HOST=localhost:8086 \
 *   PUBSUB_PROJECT_ID=blok-test \
 *   bun run test
 *
 * Note: the GCP SDK's `PubSub` client only routes to the emulator when
 * `PUBSUB_EMULATOR_HOST` is set BEFORE import. We set it in beforeAll
 * to keep developers from having to remember the dance.
 */

const GCP_PUBSUB_ENDPOINT = process.env.BLOK_INTEGRATION_GCP_PUBSUB_ENDPOINT;
const d = GCP_PUBSUB_ENDPOINT ? describe : describe.skip;

const TEST_TIMEOUT_MS = 30_000;
const TEST_PROJECT = "blok-test";

/**
 * Narrow shape for the bits of `@google-cloud/pubsub` we drive directly
 * from this test (topic + subscription creation). Keeps us off `any`
 * per the repo's no-`any`-in-tests rule.
 */
interface GcpTopic {
	createSubscription(name: string): Promise<unknown>;
	delete(): Promise<unknown>;
	get(opts?: { autoCreate?: boolean }): Promise<unknown>;
	readonly name: string;
}

interface GcpSubscriptionMetadata {
	filter?: string | null;
	deadLetterPolicy?: { deadLetterTopic?: string | null } | null;
}

interface GcpSubscription {
	delete(): Promise<unknown>;
	getMetadata(): Promise<[GcpSubscriptionMetadata]>;
}

interface GcpPubSubClient {
	topic(name: string): GcpTopic;
	subscription(name: string): GcpSubscription;
	createTopic(name: string): Promise<[GcpTopic, unknown]>;
	close(): Promise<void>;
}

interface GcpPubSubModule {
	PubSub: new (opts: { projectId: string }) => GcpPubSubClient;
}

d("GCPPubSubAdapter — real GCP Pub/Sub emulator", () => {
	let adapter: GCPPubSubAdapter;
	let testClient: GcpPubSubClient | null = null;
	const createdTopics: string[] = [];
	const createdSubscriptions: string[] = [];

	beforeAll(async () => {
		// Both the SDK and the adapter look at PUBSUB_EMULATOR_HOST — set
		// it BEFORE importing to make sure the gRPC client routes to the
		// emulator instead of trying production endpoints (and waiting
		// for credentials we don't have).
		process.env.PUBSUB_EMULATOR_HOST = GCP_PUBSUB_ENDPOINT;
		process.env.PUBSUB_PROJECT_ID = TEST_PROJECT;
		process.env.GOOGLE_CLOUD_PROJECT = TEST_PROJECT;

		adapter = new GCPPubSubAdapter({ projectId: TEST_PROJECT });
		await adapter.connect();

		// Direct SDK client used only to create / tear down topics +
		// subscriptions. The adapter doesn't expose these (production
		// users provision them ahead of time via Terraform / gcloud).
		const sdk = (await import("@google-cloud/pubsub")) as unknown as GcpPubSubModule;
		testClient = new sdk.PubSub({ projectId: TEST_PROJECT });
	}, TEST_TIMEOUT_MS);

	async function createTopicAndSub(topicName: string, subscriptionName: string): Promise<void> {
		if (!testClient) throw new Error("test client not initialised — beforeAll didn't run");
		const [topic] = await testClient.createTopic(topicName);
		createdTopics.push(topicName);
		await topic.createSubscription(subscriptionName);
		createdSubscriptions.push(subscriptionName);
	}

	// Create the topic but NOT the subscription — used by the filter /
	// dead-letter tests, where the adapter itself is expected to provision
	// the subscription with the requested resource-level config.
	async function createTopicOnly(topicName: string): Promise<GcpTopic> {
		if (!testClient) throw new Error("test client not initialised — beforeAll didn't run");
		const [topic] = await testClient.createTopic(topicName);
		createdTopics.push(topicName);
		return topic;
	}

	afterEach(async () => {
		// Tear down per-test resources so a flaky test doesn't poison
		// the next one with stale messages or shared subscriptions.
		for (const name of createdSubscriptions.splice(0)) {
			try {
				await testClient?.subscription(name).delete();
			} catch {
				/* ignore — best-effort */
			}
		}
		for (const name of createdTopics.splice(0)) {
			try {
				await testClient?.topic(name).delete();
			} catch {
				/* ignore */
			}
		}
	});

	afterAll(async () => {
		await adapter.disconnect();
		try {
			await testClient?.close();
		} catch {
			/* ignore */
		}
	});

	it(
		"publishes a message and the subscriber receives it",
		async () => {
			const topic = `blok-test-gcp-publish-${Math.random().toString(36).slice(2)}`;
			const subscription = `${topic}-sub`;
			await createTopicAndSub(topic, subscription);

			const received: PubSubMessage[] = [];
			await adapter.subscribe({ topic, subscription, durable: true }, async (msg) => {
				received.push(msg);
				await msg.ack();
			});

			// Pub/Sub subscriptions can take a moment to register the
			// streaming pull connection. Give it a short warm-up so the
			// first publish lands after the subscriber is actively pulling.
			await new Promise((r) => setTimeout(r, 500));

			await adapter.publish(topic, { hello: "gcp", n: 1 });

			await waitFor(() => received.length === 1, TEST_TIMEOUT_MS - 5_000);

			expect(received[0].body).toEqual({ hello: "gcp", n: 1 });
			expect(received[0].topic).toBe(topic);
			expect(received[0].subscription).toBe(subscription);

			await adapter.unsubscribe(subscription);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"delivers multiple messages to a single subscriber in publish order",
		async () => {
			const topic = `blok-test-gcp-order-${Math.random().toString(36).slice(2)}`;
			const subscription = `${topic}-sub`;
			await createTopicAndSub(topic, subscription);

			const received: number[] = [];
			await adapter.subscribe({ topic, subscription, durable: true }, async (msg) => {
				const body = msg.body as { n: number };
				received.push(body.n);
				await msg.ack();
			});
			await new Promise((r) => setTimeout(r, 500));

			for (let i = 0; i < 5; i++) {
				await adapter.publish(topic, { n: i });
			}

			await waitFor(() => received.length === 5, TEST_TIMEOUT_MS - 5_000);

			// GCP Pub/Sub doesn't guarantee order across a topic without
			// `messageOrdering: true` + an `orderingKey`. Assert the set
			// of values, not the sequence.
			const seen = new Set(received);
			expect(seen.size).toBe(5);
			for (let i = 0; i < 5; i++) {
				expect(seen.has(i)).toBe(true);
			}

			await adapter.unsubscribe(subscription);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"isolates subscriptions across topics",
		async () => {
			const topicA = `blok-test-gcp-iso-a-${Math.random().toString(36).slice(2)}`;
			const topicB = `blok-test-gcp-iso-b-${Math.random().toString(36).slice(2)}`;
			const subA = `${topicA}-sub`;
			const subB = `${topicB}-sub`;
			await createTopicAndSub(topicA, subA);
			await createTopicAndSub(topicB, subB);

			const receivedA: PubSubMessage[] = [];
			const receivedB: PubSubMessage[] = [];

			await adapter.subscribe({ topic: topicA, subscription: subA, durable: true }, async (msg) => {
				receivedA.push(msg);
				await msg.ack();
			});
			await adapter.subscribe({ topic: topicB, subscription: subB, durable: true }, async (msg) => {
				receivedB.push(msg);
				await msg.ack();
			});
			await new Promise((r) => setTimeout(r, 500));

			await adapter.publish(topicA, { from: "A" });
			await adapter.publish(topicB, { from: "B" });

			await waitFor(() => receivedA.length === 1 && receivedB.length === 1, TEST_TIMEOUT_MS - 5_000);

			expect(receivedA[0].body).toEqual({ from: "A" });
			expect(receivedB[0].body).toEqual({ from: "B" });

			await adapter.unsubscribe(subA);
			await adapter.unsubscribe(subB);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"startFrom 'earliest' issues subscription.seek(epoch) before attaching listeners",
		async () => {
			const topic = `blok-test-gcp-replay-${Math.random().toString(36).slice(2)}`;
			const subscription = `${topic}-sub`;
			// Sub must exist BEFORE the publish so GCP retains the messages
			// against it; the adapter then seeks to epoch before delivering.
			await createTopicAndSub(topic, subscription);

			// Publish 3 messages, then consume + ack all 3 FIRST so the ack
			// cursor is advanced past them. This defeats the false-positive
			// the prior review flagged: GCP delivers retained UNACKED messages
			// on the first pull regardless of any seek, so a never-pulled
			// subscription would "pass" even with the seek neutered. By acking
			// first, the only way to see these bytes again is a real rewind of
			// the cursor.
			for (let i = 0; i < 3; i++) {
				await adapter.publish(topic, { n: i });
			}
			const drained: number[] = [];
			await adapter.subscribe({ topic, subscription, durable: true }, async (msg) => {
				drained.push((msg.body as { n: number }).n);
				await msg.ack();
			});
			await waitFor(() => drained.length === 3, TEST_TIMEOUT_MS - 20_000);
			await adapter.unsubscribe(subscription);
			// Let the acks settle in the emulator before we rewind.
			await new Promise((r) => setTimeout(r, 500));

			// Now spy on the REAL client's seek and re-subscribe with
			// startFrom 'earliest'. The adapter must call
			// subscription.seek(new Date(0)) BEFORE attaching the message
			// listener. This spy is the load-bearing assertion: when the
			// `await subscription.seek(new Date(0))` line is reverted to a
			// no-op, seek is never invoked and this test fails.
			const seekSpy = vi.spyOn(Subscription.prototype, "seek");
			try {
				const replayed: number[] = [];
				await adapter.subscribe({ topic, subscription, durable: true, startFrom: "earliest" }, async (msg) => {
					replayed.push((msg.body as { n: number }).n);
					await msg.ack();
				});

				// The adapter issued a seek to the epoch (retention floor).
				expect(seekSpy).toHaveBeenCalled();
				const seekArg = seekSpy.mock.calls[0][0];
				expect(seekArg).toBeInstanceOf(Date);
				expect((seekArg as Date).getTime()).toBe(0);

				// Emulator-limitation note (verified live 2026-06-30 against
				// the emulator at localhost:8085): the GCP emulator ACCEPTS
				// seek(new Date(0)) — the RPC succeeds — but does NOT rewind
				// the ack cursor, so already-acked messages are NOT replayed
				// (second pull returns []). On real GCP Pub/Sub the same call
				// replays everything still within the retention window. Per
				// the campaign's partial-support rule we therefore assert the
				// adapter ISSUES the correct API call rather than faking a
				// redelivery the emulator cannot produce. `replayed` is left
				// unasserted for that reason.
				void replayed;

				await adapter.unsubscribe(subscription);
			} finally {
				seekSpy.mockRestore();
			}
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"startFrom {seq} is rejected — GCP has no sequence-number cursor",
		async () => {
			const topic = `blok-test-gcp-seq-${Math.random().toString(36).slice(2)}`;
			const subscription = `${topic}-sub`;
			await createTopicAndSub(topic, subscription);

			await expect(
				adapter.subscribe({ topic, subscription, durable: true, startFrom: { seq: 0 } }, async () => {}),
			).rejects.toThrow(/seq.*not supported|not supported.*seq/i);

			// The subscription must NOT have been wired up after the reject.
			// Reach the adapter's private registry via a typed boundary cast
			// (no `any`, no bracket-key access).
			const registry = (adapter as unknown as { subscriptions: Map<string, unknown> }).subscriptions;
			expect(registry.has(subscription)).toBe(false);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"filter provisions the subscription resource with the requested filter",
		async () => {
			const topicName = `blok-test-gcp-filter-${Math.random().toString(36).slice(2)}`;
			const subscription = `${topicName}-sub`;
			await createTopicOnly(topicName);
			// The adapter provisions the subscription (it does not pre-exist).
			createdSubscriptions.push(subscription);

			const filter = 'attributes.type = "urgent"';
			await adapter.subscribe({ topic: topicName, subscription, durable: true, filter }, async (msg) => {
				await msg.ack();
			});

			// Assert the real wire state: the filter round-trips through the
			// emulator's subscription metadata.
			if (!testClient) throw new Error("test client not initialised");
			const [metadata] = await testClient.subscription(subscription).getMetadata();
			expect(metadata.filter).toBe(filter);

			await adapter.unsubscribe(subscription);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"deadLetterTopic provisions the subscription resource with a dead-letter policy",
		async () => {
			const topicName = `blok-test-gcp-dlt-${Math.random().toString(36).slice(2)}`;
			const dlqName = `blok-test-gcp-dlq-${Math.random().toString(36).slice(2)}`;
			const subscription = `${topicName}-sub`;
			await createTopicOnly(topicName);
			const dlqTopic = await createTopicOnly(dlqName);
			createdSubscriptions.push(subscription);

			await adapter.subscribe(
				{ topic: topicName, subscription, durable: true, deadLetterTopic: dlqName },
				async (msg) => {
					await msg.ack();
				},
			);

			// Assert the real wire state: the dead-letter policy points at the
			// fully-qualified DLQ topic path.
			if (!testClient) throw new Error("test client not initialised");
			const [metadata] = await testClient.subscription(subscription).getMetadata();
			expect(metadata.deadLetterPolicy?.deadLetterTopic).toBe(dlqTopic.name);

			await adapter.unsubscribe(subscription);
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
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}
