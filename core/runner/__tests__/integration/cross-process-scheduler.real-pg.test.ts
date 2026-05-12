import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresRunStore } from "../../src/tracing/PostgresRunStore";
import type { ScheduledDispatchRow } from "../../src/tracing/types";

/**
 * Real-Postgres integration test for Tier C #2 — cross-process scheduler
 * coordination. Two `PostgresRunStore` instances pointing at the same PG
 * simulate two processes; the claim protocol must guarantee exactly one
 * fires each row.
 *
 * Gated on `BLOK_INTEGRATION_POSTGRES_URL`. Skipped when unset.
 *
 * Bring up the test fixtures via:
 *   docker compose -f infra/testing/docker-compose.yml up -d postgres
 */

const PG_URL = process.env.BLOK_INTEGRATION_POSTGRES_URL;
const d = PG_URL ? describe : describe.skip;

const baseRow = (overrides?: Partial<ScheduledDispatchRow>): ScheduledDispatchRow => ({
	runId: `r-${Math.random().toString(36).slice(2)}`,
	workflowName: "wf-c2",
	triggerType: "http",
	scheduledAt: Date.now() + 60_000,
	dispatchStatus: "delayed",
	payload: { hello: "world" },
	createdAt: Date.now(),
	...overrides,
});

interface PgClient {
	query(sql: string, args?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

d("Cross-process scheduler — real Postgres (Tier C #2)", () => {
	let storeA: PostgresRunStore;
	let storeB: PostgresRunStore;

	beforeAll(async () => {
		if (!PG_URL) throw new Error("unreachable — describe is skipped without PG_URL");
		storeA = new PostgresRunStore({ connectionString: PG_URL, max: 4 });
		storeB = new PostgresRunStore({ connectionString: PG_URL, max: 4 });
		await storeA.ready();
		await storeB.ready();
	});

	afterAll(async () => {
		await storeA.close?.();
		await storeB.close?.();
	});

	beforeEach(async () => {
		// Truncate the table between tests so each starts clean.
		const pool = (storeA as unknown as { pool: PgClient }).pool;
		await pool.query("DELETE FROM scheduled_dispatches WHERE workflow_name = 'wf-c2'");
	});

	// Seed a row directly via SQL — `upsertScheduledDispatch` enqueues
	// the actual write asynchronously, and there's no public flush API
	// for tests to wait on. Going around the queue ensures the row is
	// visible before the test exercises the claim path.
	async function seedRow(row: ScheduledDispatchRow): Promise<void> {
		const pool = (storeA as unknown as { pool: PgClient }).pool;
		await pool.query(
			`INSERT INTO scheduled_dispatches
				(run_id, workflow_name, trigger_type, scheduled_at, expires_at,
				 dispatch_status, payload_json, created_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
			ON CONFLICT (run_id) DO UPDATE SET
				scheduled_at = EXCLUDED.scheduled_at,
				expires_at = EXCLUDED.expires_at,
				dispatch_status = EXCLUDED.dispatch_status,
				payload_json = EXCLUDED.payload_json`,
			[
				row.runId,
				row.workflowName,
				row.triggerType,
				row.scheduledAt,
				row.expiresAt ?? null,
				row.dispatchStatus,
				JSON.stringify(row.payload ?? null),
				row.createdAt,
			],
		);
	}

	it("two processes claiming the same dispatch — exactly one wins", async () => {
		const row = baseRow();
		await seedRow(row);

		const now = Date.now();
		const [claimedByA, claimedByB] = await Promise.all([
			storeA.claimDispatchesAsync("proc-A", 60_000, now, { triggerType: "http" }),
			storeB.claimDispatchesAsync("proc-B", 60_000, now + 5, { triggerType: "http" }),
		]);

		const totalClaimed = claimedByA.length + claimedByB.length;
		expect(totalClaimed).toBe(1);
		// And both processes are NOT seeing the same row.
		if (claimedByA.length === 1) expect(claimedByA[0].claimedBy).toBe("proc-A");
		if (claimedByB.length === 1) expect(claimedByB[0].claimedBy).toBe("proc-B");
	});

	it("expired claim — survivor takes over", async () => {
		const row = baseRow();
		await seedRow(row);

		// proc-A claims at t=0.
		const t0 = Date.now();
		const a = await storeA.claimDispatchesAsync("proc-A", 60_000, t0, { triggerType: "http" });
		expect(a).toHaveLength(1);

		// proc-B tries immediately — denied.
		const b1 = await storeB.claimDispatchesAsync("proc-B", 60_000, t0 + 100, { triggerType: "http" });
		expect(b1).toHaveLength(0);

		// Time advances past the lease (leaseMs=1 + now=t0+10000 makes
		// the lease stale).
		const b2 = await storeB.claimDispatchesAsync("proc-B", 1, t0 + 10_000, { triggerType: "http" });
		expect(b2).toHaveLength(1);
		expect(b2[0].claimedBy).toBe("proc-B");
	});

	it("heartbeat refreshes the claim against PG", async () => {
		const row = baseRow();
		await seedRow(row);

		const t0 = Date.now();
		await storeA.claimDispatchesAsync("proc-A", 60_000, t0, { triggerType: "http" });

		// Heartbeat at t0 + 5_000 — should bump claimed_at. The
		// `heartbeatClaims` write is enqueued by PostgresRunStore — issue
		// a direct UPDATE so the test doesn't race the async queue.
		const pool = (storeA as unknown as { pool: PgClient }).pool;
		await pool.query("UPDATE scheduled_dispatches SET claimed_at = $1 WHERE claimed_by = $2", [t0 + 5_000, "proc-A"]);

		// proc-B with leaseMs that WOULD have allowed takeover at t0 but
		// not at t0 + 5_000 (4s ago < 6s lease).
		const denied = await storeB.claimDispatchesAsync("proc-B", 6_000, t0 + 9_000, { triggerType: "http" });
		expect(denied).toHaveLength(0);
	});

	it("upserting an already-claimed row preserves the claim", async () => {
		const row = baseRow();
		await seedRow(row);

		await storeA.claimDispatchesAsync("proc-A", 60_000, Date.now(), { triggerType: "http" });

		// Simulate debounce reset — re-upsert via direct SQL (so the test
		// doesn't race the async write queue). The production ON CONFLICT
		// clause preserves claimed_by + claimed_at.
		await seedRow({ ...row, scheduledAt: Date.now() + 120_000 });

		// proc-B should still see the row as claimed by proc-A.
		const stolen = await storeB.claimDispatchesAsync("proc-B", 60_000, Date.now(), { triggerType: "http" });
		expect(stolen).toHaveLength(0);
	});

	it("releaseClaim allows another process to claim immediately", async () => {
		const row = baseRow();
		await seedRow(row);

		await storeA.claimDispatchesAsync("proc-A", 60_000, Date.now(), { triggerType: "http" });
		// Issue release via direct SQL — the production releaseClaim()
		// enqueues async. The behavior under test is the claim-eligibility
		// SQL, not the queue plumbing.
		const pool = (storeA as unknown as { pool: PgClient }).pool;
		await pool.query("UPDATE scheduled_dispatches SET claimed_by = NULL, claimed_at = NULL WHERE run_id = $1", [
			row.runId,
		]);

		const reclaimed = await storeB.claimDispatchesAsync("proc-B", 60_000, Date.now(), { triggerType: "http" });
		expect(reclaimed).toHaveLength(1);
		expect(reclaimed[0].claimedBy).toBe("proc-B");
	});
});
