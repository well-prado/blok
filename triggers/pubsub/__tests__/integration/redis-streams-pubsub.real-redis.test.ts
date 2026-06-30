import type { PubSubMessage } from "@blokjs/runner";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RedisStreamsPubSubAdapter } from "../../src/adapters/RedisStreamsPubSubAdapter";

/**
 * Real-Redis integration test for `RedisStreamsPubSubAdapter` (issue #584).
 *
 * Proves, against a LIVE Redis (Streams), the four delivery / replay
 * behaviours the adapter promises:
 *   1. fan-out          — 2 subscribers, no group → both get every message.
 *   2. competing        — 2 subscribers, same group → each msg to exactly one.
 *   3. startFrom replay — second subscribe on an EXISTING group with
 *                          `startFrom:"earliest"` replays history (XGROUP SETID
 *                          repositions the group). This is the HIGH-bug guard.
 *   4. startFrom:{timestamp} — resumes from a time cursor.
 *
 * Gated on `BLOK_INTEGRATION_REDIS`. Connects via REDIS_HOST/REDIS_PORT.
 * Every stream + group is namespaced with a random suffix; nothing is flushed.
 */

const REDIS = process.env.BLOK_INTEGRATION_REDIS;
const d = REDIS ? describe : describe.skip;

const TEST_TIMEOUT_MS = 30_000;
// Redis blocks the consumer loop; give freshly-installed groups a moment.
const WARMUP_MS = 300;

const rnd = () => Math.random().toString(36).slice(2);
const newAdapter = () => new RedisStreamsPubSubAdapter({ blockMs: 200, count: 10 });

d("RedisStreamsPubSubAdapter — real Redis", () => {
	let producer: RedisStreamsPubSubAdapter;
	let consumerA: RedisStreamsPubSubAdapter;
	let consumerB: RedisStreamsPubSubAdapter;

	beforeAll(async () => {
		producer = newAdapter();
		consumerA = newAdapter();
		consumerB = newAdapter();
		await Promise.all([producer.connect(), consumerA.connect(), consumerB.connect()]);
	});

	afterAll(async () => {
		await Promise.all([consumerA.disconnect(), consumerB.disconnect(), producer.disconnect()]);
	});

	it(
		"fan-out: 2 subscribers without consumerGroup each receive every message",
		async () => {
			const topic = `blok-test-redis-fanout-${rnd()}`;
			const recvA: PubSubMessage[] = [];
			const recvB: PubSubMessage[] = [];

			await consumerA.subscribe({ topic }, async (m) => {
				recvA.push(m);
			});
			await consumerB.subscribe({ topic }, async (m) => {
				recvB.push(m);
			});
			await sleep(WARMUP_MS);

			await producer.publish(topic, { hello: "world", n: 1 });

			await waitFor(() => recvA.length === 1 && recvB.length === 1, TEST_TIMEOUT_MS - 5_000);
			expect(recvA[0].body).toEqual({ hello: "world", n: 1 });
			expect(recvB[0].body).toEqual({ hello: "world", n: 1 });
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"competing-consumer: same consumerGroup delivers each message to exactly one subscriber",
		async () => {
			const topic = `blok-test-redis-competing-${rnd()}`;
			const group = `g-compete-${rnd()}`;
			const recvA: PubSubMessage[] = [];
			const recvB: PubSubMessage[] = [];

			await consumerA.subscribe({ topic, consumerGroup: group }, async (m) => {
				recvA.push(m);
			});
			await consumerB.subscribe({ topic, consumerGroup: group }, async (m) => {
				recvB.push(m);
			});
			await sleep(WARMUP_MS);

			for (let i = 0; i < 10; i++) await producer.publish(topic, { n: i });

			await waitFor(() => recvA.length + recvB.length === 10, TEST_TIMEOUT_MS - 5_000);
			expect(recvA.length + recvB.length).toBe(10);
			// No message delivered twice across the group.
			const seen = new Set<number>();
			for (const m of [...recvA, ...recvB]) {
				const n = (m.body as { n: number }).n;
				expect(seen.has(n)).toBe(false);
				seen.add(n);
			}
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"startFrom replay: second subscribe on an existing group with `earliest` replays all history",
		async () => {
			const topic = `blok-test-redis-replay-${rnd()}`;
			const group = `g-replay-${rnd()}`;

			// First subscriber creates group G (at `$`) and drains the live feed.
			const live = newAdapter();
			await live.connect();
			const liveRecv: PubSubMessage[] = [];
			await live.subscribe({ topic, consumerGroup: group }, async (m) => {
				liveRecv.push(m);
			});
			await sleep(WARMUP_MS);

			for (let i = 0; i < 3; i++) await producer.publish(topic, { n: i });
			await waitFor(() => liveRecv.length === 3, TEST_TIMEOUT_MS - 5_000);
			expect(liveRecv.length).toBe(3);

			// Stop draining so the group's cursor is parked past the 3 messages.
			await live.disconnect();

			// NEW subscribe on the SAME group G with startFrom:"earliest".
			// The group already exists → XGROUP CREATE returns BUSYGROUP. The fix
			// issues XGROUP SETID G 0, repositioning the group to the head, so the
			// fresh consumer re-reads all 3 via `>`. Without the fix SETID is never
			// issued, the group keeps its old cursor, and this consumer gets 0.
			const replay = newAdapter();
			await replay.connect();
			const replayRecv: PubSubMessage[] = [];
			await replay.subscribe({ topic, consumerGroup: group, startFrom: "earliest" }, async (m) => {
				replayRecv.push(m);
			});

			try {
				await waitFor(() => replayRecv.length === 3, TEST_TIMEOUT_MS - 5_000);
				expect(replayRecv.map((m) => (m.body as { n: number }).n).sort()).toEqual([0, 1, 2]);
			} finally {
				await replay.disconnect();
			}
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"startFrom:{timestamp} resumes from a time cursor",
		async () => {
			const topic = `blok-test-redis-ts-${rnd()}`;
			const group = `g-ts-${rnd()}`;

			// Seed three messages 5ms apart, capturing the wire id (`<ms>-<seq>`)
			// of the 2nd so we can build a time cursor from its millisecond.
			await producer.publish(topic, { n: 0 });
			await sleep(5);
			const midId = await rawXadd(producer, topic, { n: 1 });
			await sleep(5);
			await producer.publish(topic, { n: 2 });
			const midMs = Number(midId.split("-")[0]);

			// Time cursor at the 2nd message's ms → group created at `${midMs}-0`.
			// Redis treats a group start id as EXCLUSIVE, and `${midMs}-0` is the
			// 2nd message's own id, so the cursor sits at/after n:0 and n:1 and
			// delivers only what came strictly later: n:2.
			const cons = newAdapter();
			await cons.connect();
			const recv: PubSubMessage[] = [];
			await cons.subscribe({ topic, consumerGroup: group, startFrom: { timestamp: midMs } }, async (m) => {
				recv.push(m);
			});

			try {
				await waitFor(() => recv.length >= 1, TEST_TIMEOUT_MS - 5_000);
				await sleep(WARMUP_MS); // settle: ensure no late n:0/n:1 sneaks in
				const ns = recv.map((m) => (m.body as { n: number }).n).sort();
				expect(ns).toEqual([2]);
			} finally {
				await cons.disconnect();
			}
		},
		TEST_TIMEOUT_MS,
	);
});

/** Publish and return the assigned stream id, by reaching the live client. */
async function rawXadd(adapter: RedisStreamsPubSubAdapter, topic: string, payload: unknown): Promise<string> {
	// The adapter's publish() discards the returned id; grab it off the client.
	const client = (adapter as unknown as { client: { xadd: (s: string, ...a: string[]) => Promise<string> } }).client;
	return client.xadd(topic, "*", "data", JSON.stringify(payload));
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (predicate()) return;
		await sleep(50);
	}
	throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}
