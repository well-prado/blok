import type { WorkerJob } from "@blokjs/runner";
import IORedis from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RedisStreamsAdapter } from "../../src/adapters/RedisStreamsAdapter";

/**
 * Real-Redis integration test for `RedisStreamsAdapter` (issue #589).
 *
 * Gated on `BLOK_INTEGRATION_REDIS`. Skipped when unset. Connects to the
 * broker via `REDIS_HOST` / `REDIS_PORT` (already running — do NOT start it).
 *
 * Every stream / group is namespaced with a random suffix so concurrent
 * targets on the SAME Redis never collide. Nothing is flushed; the only
 * keys touched are the per-test namespaced streams.
 *
 * Proves (with REAL broker assertions, not a mocked client):
 *   1. addJob happy path — NOMKSTREAM ordering fixed: enqueue → consume.
 *   2. ack:false → at-most-once: a throwing handler leaves XPENDING == 0
 *      (with the bug, NOACK is missing and the entry leaks into the PEL).
 *   3. deadLetterQueue: an exhausted job is XADDed to the DLQ stream then
 *      XACKed on the source (source PEL == 0, DLQ holds the payload).
 *   4. reject: `delay` / `priority` throw a clear config error at addJob.
 *   5. REDRIVE (#616): a stuck pending entry (dead consumer, never acked) is
 *      reclaimed by the in-process periodic XAUTOCLAIM and processed; XPENDING
 *      drains. With the bug (no redrive loop) it stays stuck forever.
 *   6. CONCURRENCY (#616): concurrency=K slow jobs finish in ~1×SLEEP (dedicated
 *      ioredis connection per loop), not K× as when loops serialize on one
 *      shared blocking connection.
 */

const REDIS = process.env.BLOK_INTEGRATION_REDIS;
const d = REDIS ? describe : describe.skip;

const HOST = process.env.REDIS_HOST ?? "localhost";
const PORT = Number.parseInt(process.env.REDIS_PORT ?? "6379", 10);

const TEST_TIMEOUT_MS = 30_000;
const sfx = () => Math.random().toString(36).slice(2);

/** Raw XPENDING summary: [count, minId, maxId, consumers]. */
async function pendingCount(client: IORedis, stream: string, group: string): Promise<number> {
	const summary = (await client.xpending(stream, group)) as [number, ...unknown[]];
	return Number(summary?.[0] ?? 0);
}

d("RedisStreamsAdapter — real Redis Streams", () => {
	let adapter: RedisStreamsAdapter;
	let probe: IORedis;

	beforeAll(async () => {
		adapter = new RedisStreamsAdapter({ host: HOST, port: PORT, blockMs: 300, count: 10 });
		await adapter.connect();
		probe = new IORedis({ host: HOST, port: PORT, maxRetriesPerRequest: null });
	});

	afterAll(async () => {
		await adapter.disconnect();
		await probe.quit();
	});

	it(
		"addJob happy path: NOMKSTREAM ordering fixed → enqueue then consume",
		async () => {
			const queue = `blok-test-redis-publish-${sfx()}`;
			const received: WorkerJob[] = [];

			await adapter.process({ queue }, async (job) => {
				received.push(job);
				await job.complete();
			});

			const jobId = await adapter.addJob(queue, { hello: "world", n: 1 });
			// A valid stream id is `<ms>-<seq>`. With the NOMKSTREAM bug the
			// assembled args were dropped — `*` still produced an id, but the
			// fix proves the arg list is actually threaded through xadd.
			expect(jobId).toMatch(/^\d+-\d+$/);

			await waitFor(() => received.length === 1, TEST_TIMEOUT_MS - 5_000);

			expect(received).toHaveLength(1);
			expect(received[0].data).toEqual({ hello: "world", n: 1 });
			expect(received[0].queue).toBe(queue);
			expect(received[0].id).toBe(jobId);

			await adapter.stopProcessing(queue);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"ack:false → at-most-once: a throwing handler leaves NO pending entry (XPENDING == 0)",
		async () => {
			const queue = `blok-test-redis-noack-${sfx()}`;
			const group = `${queue}-group`;
			let calls = 0;

			await adapter.process({ queue, ack: false, retries: 3 }, async () => {
				calls++;
				throw new Error("boom — handler always fails");
			});

			await adapter.addJob(queue, { attempt: "should-not-leak-pending" });

			await waitFor(() => calls >= 1, TEST_TIMEOUT_MS - 8_000);
			// Let the loop cycle a couple of BLOCK windows so any pending entry
			// would have shown up by now.
			await new Promise((r) => setTimeout(r, 1_000));

			// THE assertion: NOACK means Redis never added the entry to the
			// group's PEL. With the bug (NOACK missing, XACK merely skipped) the
			// delivered-but-failed entry leaks into the PEL → count >= 1 → FAIL.
			const pending = await pendingCount(probe, queue, group);
			expect(pending).toBe(0);

			await adapter.stopProcessing(queue);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"deadLetterQueue → terminal fail XADDs to the DLQ stream then XACKs the source",
		async () => {
			const queue = `blok-test-redis-dlq-${sfx()}`;
			const group = `${queue}-group`;
			const dlq = `blok-test-redis-dlq-sink-${sfx()}`;
			const payload = { order: 42, note: "dead-letter-me" };

			// Drive the terminal path directly (retries exhausted → fail(err, false)),
			// mirroring how WorkerTrigger.handleJob calls job.fail on exhaustion.
			await adapter.process({ queue, deadLetterQueue: dlq, retries: 0 }, async (job) => {
				await job.fail(new Error("permanent failure"), false);
			});

			await adapter.addJob(queue, payload);

			// Wait until the DLQ stream actually holds an entry (real broker read).
			await waitFor(async () => (await probe.xlen(dlq)) >= 1, TEST_TIMEOUT_MS - 5_000);

			// DLQ holds the original payload, JSON-encoded under the `data` field.
			const entries = (await probe.xrange(dlq, "-", "+")) as Array<[string, string[]]>;
			expect(entries).toHaveLength(1);
			const fields = entries[0][1];
			const dataIdx = fields.indexOf("data");
			expect(dataIdx).toBeGreaterThanOrEqual(0);
			expect(JSON.parse(fields[dataIdx + 1])).toEqual(payload);

			// Source entry was XACKed (removed from the PEL) — not left dangling.
			await new Promise((r) => setTimeout(r, 300));
			expect(await pendingCount(probe, queue, group)).toBe(0);

			await adapter.stopProcessing(queue);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"reject: addJob with delay or priority throws a clear config error",
		async () => {
			const queue = `blok-test-redis-reject-${sfx()}`;
			await expect(adapter.addJob(queue, { x: 1 }, { delay: 1000 })).rejects.toThrow(/no native delayed delivery/i);
			await expect(adapter.addJob(queue, { x: 1 }, { priority: 5 })).rejects.toThrow(/no native priority/i);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"REDRIVE: a stuck pending entry (dead consumer) is reclaimed by the periodic XAUTOCLAIM and processed",
		async () => {
			const queue = `blok-test-redis-redrive-${sfx()}`;
			const group = `${queue}-group`;

			// Create the group at 0 (sees the whole stream) and enqueue a job,
			// then read it into a THROWAWAY consumer WITHOUT acking — this is a
			// consumer that died mid-processing: the entry is stuck in the PEL.
			await probe.xgroup("CREATE", queue, group, "0", "MKSTREAM");
			const jobId = await probe.xadd(queue, "*", "data", JSON.stringify({ stuck: true }), "jobId", "");
			await probe.xreadgroup("GROUP", group, "dead-consumer", "COUNT", "10", "STREAMS", queue, ">");

			// The entry is pending under the dead consumer and will NEVER be
			// redelivered via XREADGROUP `>` (already delivered). Only redrive
			// reclaims it. Sanity: it's stuck right now.
			expect(await pendingCount(probe, queue, group)).toBe(1);

			const received: WorkerJob[] = [];
			// `timeout` is the redrive idle threshold. Small so the test is fast;
			// blockMs is 300 (from beforeAll) so the redrive interval fires quickly.
			await adapter.process({ queue, timeout: 500, retries: 3 }, async (job) => {
				received.push(job);
				await job.complete();
			});

			// The live XREADGROUP loop can't see the already-delivered entry — it
			// only surfaces via the periodic XAUTOCLAIM redrive after idle > 500ms.
			await waitFor(() => received.length === 1, TEST_TIMEOUT_MS - 2_000);

			expect(received).toHaveLength(1);
			expect(received[0].id).toBe(jobId);
			expect(received[0].data).toEqual({ stuck: true });

			// Redrive reclaimed AND the handler acked → PEL drains to 0. With the
			// bug (no in-process XAUTOCLAIM) the entry stays stuck forever → the
			// waitFor above times out (received stays empty) → this test FAILS.
			await waitFor(async () => (await pendingCount(probe, queue, group)) === 0, TEST_TIMEOUT_MS - 2_000);
			expect(await pendingCount(probe, queue, group)).toBe(0);

			await adapter.stopProcessing(queue);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"CONCURRENCY: with concurrency=K, K slow jobs finish in ~1×SLEEP, not K× (dedicated connection per loop)",
		async () => {
			const K = 3;
			const SLEEP_MS = 1_200;
			const queue = `blok-test-redis-concurrency-${sfx()}`;

			// Dedicated adapter with COUNT=1 so no single read can hog all K jobs
			// (fan-out fairness) and a short BLOCK so idle loops re-read quickly.
			// If the K consumer loops shared ONE ioredis connection, their blocking
			// XREADGROUP calls serialize on the socket and total throughput collapses
			// toward K×SLEEP; with a DEDICATED connection per loop they truly overlap
			// and total wall time is ~1×SLEEP.
			const local = new RedisStreamsAdapter({ host: HOST, port: PORT, blockMs: 200, count: 1 });
			await local.connect();
			try {
				let started = 0;
				let finishedAt = 0;
				const t0 = Date.now();

				await local.process({ queue, concurrency: K }, async (job) => {
					started++;
					await new Promise((r) => setTimeout(r, SLEEP_MS));
					await job.complete();
					finishedAt = Date.now();
				});

				// Enqueue K jobs back-to-back; they arrive while all K loops block.
				for (let i = 0; i < K; i++) await local.addJob(queue, { n: i });

				await waitFor(() => started === K, TEST_TIMEOUT_MS - 5_000);
				// Wait until all K completed.
				await waitFor(async () => (await local.getQueueStats(queue)).completed === K, TEST_TIMEOUT_MS - 5_000);

				const total = finishedAt - t0;
				// Real parallelism finishes in ~1×SLEEP (+ overhead). Serialized-on-
				// one-socket needs multiples of SLEEP. Bar at 2×SLEEP: fixed passes
				// (~1×), the shared-connection bug fails (measured ~2.7× for K=3).
				expect(total).toBeLessThan(2 * SLEEP_MS);

				await local.stopProcessing(queue);
			} finally {
				await local.disconnect();
			}
		},
		TEST_TIMEOUT_MS,
	);

	it("isConnected + healthCheck reflect a live connection", async () => {
		expect(adapter.isConnected()).toBe(true);
		expect(await adapter.healthCheck()).toBe(true);
	});
});

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (await predicate()) return;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}
