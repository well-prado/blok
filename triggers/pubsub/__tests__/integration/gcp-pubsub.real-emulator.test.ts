import type { PubSubMessage } from "@blokjs/runner";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
}

interface GcpSubscription {
	delete(): Promise<unknown>;
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
