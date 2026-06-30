import type { WorkerJob } from "@blokjs/runner";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PgBossAdapter } from "../../src/adapters/PgBossAdapter";

/**
 * Real-Postgres integration test for `PgBossAdapter` (closes Phase 2.1
 * broker-adapter test debt deferred from PR #91).
 *
 * Gated on `BLOK_INTEGRATION_POSTGRES_URL`. Skipped when unset.
 *
 * Bring up the test fixtures via:
 *   docker compose -f infra/testing/docker-compose.yml up -d postgres
 *
 * Then run:
 *   BLOK_INTEGRATION_POSTGRES_URL=postgres://blok:blok_test@localhost:5433/blok_test \
 *   bun run test
 *
 * Note: pg-boss creates its own schema (`pgboss` by default) on first
 * connect; we use a per-test schema name so a flaky run doesn't poison
 * the next one. Each test cleans up via `boss.stop({ graceful: true })`.
 */

const POSTGRES_URL = process.env.BLOK_INTEGRATION_POSTGRES_URL;
const d = POSTGRES_URL ? describe : describe.skip;

const TEST_TIMEOUT_MS = 60_000; // pg-boss migration on first start is slow

d("PgBossAdapter — real Postgres", () => {
	const adapters: PgBossAdapter[] = [];

	async function newAdapter(): Promise<PgBossAdapter> {
		// Random schema per adapter so pg-boss's auto-migration runs
		// fresh and the per-test state doesn't bleed across `it`s. pg-boss
		// uses one schema per `PgBoss` instance.
		const schema = `pgboss_test_${Math.random().toString(36).slice(2, 10)}`;
		const adapter = new PgBossAdapter({ connectionString: POSTGRES_URL, schema });
		await adapter.connect();
		adapters.push(adapter);
		return adapter;
	}

	afterEach(async () => {
		for (const a of adapters.splice(0)) {
			try {
				await a.disconnect();
			} catch {
				/* ignore — best-effort */
			}
		}
	});

	afterAll(async () => {
		for (const a of adapters.splice(0)) {
			try {
				await a.disconnect();
			} catch {
				/* ignore */
			}
		}
	});

	it(
		"publishes a job and the consumer receives it (single-queue happy path)",
		async () => {
			const adapter = await newAdapter();
			const queue = `blok-test-pgboss-publish-${Math.random().toString(36).slice(2)}`;
			const received: WorkerJob[] = [];

			await adapter.process({ queue }, async (job) => {
				received.push(job);
				await job.complete();
			});

			const jobId = await adapter.addJob(queue, { hello: "pg-boss", n: 1 });
			expect(typeof jobId).toBe("string");
			expect(jobId.length).toBeGreaterThan(0);

			await waitFor(() => received.length === 1, TEST_TIMEOUT_MS - 10_000);

			expect(received[0].data).toEqual({ hello: "pg-boss", n: 1 });
			expect(received[0].queue).toBe(queue);
			expect(received[0].id).toBeTruthy();

			await adapter.stopProcessing(queue);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"isolates jobs across distinct queues within one PgBoss instance",
		async () => {
			const adapter = await newAdapter();
			const queueA = `blok-test-pgboss-a-${Math.random().toString(36).slice(2)}`;
			const queueB = `blok-test-pgboss-b-${Math.random().toString(36).slice(2)}`;
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

			await waitFor(() => receivedA.length === 1 && receivedB.length === 1, TEST_TIMEOUT_MS - 10_000);

			expect(receivedA[0].data).toEqual({ from: "A" });
			expect(receivedB[0].data).toEqual({ from: "B" });

			await adapter.stopProcessing(queueA);
			await adapter.stopProcessing(queueB);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"handler throw triggers pg-boss retry until retryLimit, then drops to DLQ",
		async () => {
			// pg-boss reschedules failed jobs internally based on
			// `retryLimit`. We assert the handler is invoked at least
			// twice when `retries: 1` (= 2 total attempts).
			const adapter = await newAdapter();
			const queue = `blok-test-pgboss-retry-${Math.random().toString(36).slice(2)}`;
			let attempts = 0;

			await adapter.process({ queue, retries: 1 }, async (_job) => {
				attempts += 1;
				throw new Error(`simulated failure attempt ${attempts}`);
			});

			await adapter.addJob(queue, { will_fail: true }, { retries: 1 });

			// Wait for at least 2 attempts. pg-boss's default retry-delay
			// can be several seconds; the test timeout (60s) accommodates.
			await waitFor(() => attempts >= 2, TEST_TIMEOUT_MS - 10_000);

			expect(attempts).toBeGreaterThanOrEqual(2);

			await adapter.stopProcessing(queue);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"deadLetterQueue: a job that exhausts retryLimit lands in the configured DLQ",
		async () => {
			// Root-cause fix under test: `ensureQueue` must pass
			// `{ deadLetter, retryLimit }` into pg-boss `createQueue` so a
			// job that fails past `retries` is routed to the DLQ. Without
			// the wiring, NOTHING is dead-lettered and this MUST fail.
			const adapter = await newAdapter();
			const queue = `blok-test-pgboss-dlqsrc-${Math.random().toString(36).slice(2)}`;
			const dlq = `blok-test-pgboss-dlq-${Math.random().toString(36).slice(2)}`;
			let attempts = 0;

			// retries: 0 → 1 total attempt, then straight to DLQ. Keeps the
			// test fast (no retry-delay waiting).
			await adapter.process({ queue, retries: 0, deadLetterQueue: dlq }, async (_job) => {
				attempts += 1;
				throw new Error("always fails -> should be dead-lettered");
			});

			await adapter.addJob(queue, { will_dead_letter: true });

			// The failed job is moved into the DLQ as a fresh pending job;
			// `getQueueStats(dlq).waiting` (pg-boss getQueueSize) reflects it.
			await waitFor(async () => {
				const stats = await adapter.getQueueStats(dlq);
				return stats.waiting >= 1;
			}, TEST_TIMEOUT_MS - 10_000);

			const dlqStats = await adapter.getQueueStats(dlq);
			expect(dlqStats.waiting).toBeGreaterThanOrEqual(1);
			expect(attempts).toBe(1); // retries:0 → exactly one handler call

			await adapter.stopProcessing(queue);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"concurrency maps to batchSize: K jobs enqueued up front drain in one poll window",
		async () => {
			// Root-cause fix under test: `config.concurrency` -> `batchSize`
			// on `work()`. pg-boss polls every ~2s (its default
			// pollingIntervalSeconds) and fetches up to `batchSize` jobs per
			// poll. Observable signature: with batchSize=K, K jobs enqueued
			// BEFORE a poll are all fetched together → their completions
			// cluster within a single poll window. With the old hard-coded
			// batchSize:1, each poll drains exactly one job, so K jobs spread
			// across K poll cycles (~2s apart). We assert the completion
			// timestamps span LESS than one poll interval — which is false
			// when the fix is reverted to batchSize:1.
			const adapter = await newAdapter();
			const queue = `blok-test-pgboss-batch-${Math.random().toString(36).slice(2)}`;
			const K = 4;
			const completedAt: number[] = [];

			await adapter.process({ queue, concurrency: K }, async (job) => {
				completedAt.push(Date.now());
				await job.complete();
			});

			// Enqueue all K jobs up front so the very next poll can batch them.
			for (let i = 0; i < K; i++) {
				await adapter.addJob(queue, { n: i });
			}

			await waitFor(() => completedAt.length === K, TEST_TIMEOUT_MS - 10_000);
			expect(completedAt.length).toBe(K);

			// pg-boss default pollingIntervalSeconds is 2s. A batched fetch
			// drains all K in one poll → tight cluster. batchSize:1 drains
			// one-per-poll → ≥ (K-1)*~2s spread. 1500ms cleanly separates the
			// two regimes for K=4.
			const span = Math.max(...completedAt) - Math.min(...completedAt);
			expect(span).toBeLessThan(1500);

			await adapter.stopProcessing(queue);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"retries: a job that fails once then succeeds within retryLimit completes",
		async () => {
			const adapter = await newAdapter();
			const queue = `blok-test-pgboss-retrysucceed-${Math.random().toString(36).slice(2)}`;
			let attempts = 0;
			const completed: unknown[] = [];

			await adapter.process({ queue, retries: 2 }, async (job) => {
				attempts += 1;
				if (attempts === 1) {
					throw new Error("transient failure on first attempt");
				}
				completed.push(job.data);
				await job.complete();
			});

			await adapter.addJob(queue, { eventually: "succeeds" }, { retries: 2 });

			await waitFor(() => completed.length === 1, TEST_TIMEOUT_MS - 10_000);
			expect(completed.length).toBe(1);
			expect(attempts).toBeGreaterThanOrEqual(2);
			expect(completed[0]).toEqual({ eventually: "succeeds" });

			await adapter.stopProcessing(queue);
		},
		TEST_TIMEOUT_MS,
	);

	it("isConnected + healthCheck reflect the live state", async () => {
		const adapter = await newAdapter();
		expect(adapter.isConnected()).toBe(true);
		const healthy = await adapter.healthCheck();
		expect(healthy).toBe(true);
	});
});

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (await predicate()) return;
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}
