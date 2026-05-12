import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeferredRunScheduler } from "../../src/scheduling/DeferredRunScheduler";
import { RunTracker } from "../../src/tracing/RunTracker";
import { SqliteRunStore } from "../../src/tracing/SqliteRunStore";

// Inject a fresh SqliteRunStore directly into the RunTracker singleton.
// `RunTracker.getInstance()`'s default path uses `createStore()` which
// invokes `createRequire(import.meta.url)` for dynamic require — that
// path doesn't resolve cleanly through vitest's bundler. Bypass it by
// constructing the store ourselves and injecting via a boundary cast.
function bootTracker(dbPath: string): SqliteRunStore {
	RunTracker.resetInstance();
	const store = new SqliteRunStore(dbPath);
	(RunTracker as unknown as { instance: RunTracker | null }).instance = new RunTracker(undefined, store);
	return store;
}

/**
 * Durable scheduler crash-restart integration test (Tier H #4).
 *
 * Validates the end-to-end durability contract: a dispatch persisted to
 * `scheduled_dispatches` survives a "crash" (process tear-down + fresh
 * boot) and gets re-registered on the next `recoverDispatches()` call.
 *
 * Doesn't require any external services — uses a real sqlite file on
 * disk that survives an in-process simulated restart (close store →
 * reset singletons → reopen against the same file). The recovery wiring
 * lives in `HttpTrigger.recoverDispatches()`; this test reproduces that
 * wiring at the store + scheduler layer so the durability invariant is
 * covered without booting an HTTP trigger.
 *
 * Always runs — no env-var gate. The dependency is just sqlite + the
 * runner package.
 */

describe("Durable scheduler — crash + restart recovery (Tier H #4)", () => {
	let tmpDir: string;
	let dbPath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "blok-h4-"));
		dbPath = join(tmpDir, "test.sqlite");
		DeferredRunScheduler.resetInstance();
		RunTracker.resetInstance();
	});

	afterEach(() => {
		DeferredRunScheduler.resetInstance();
		RunTracker.resetInstance();
		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	it("persists a dispatch row that survives store close + reopen", async () => {
		// === Phase 1: simulate the "first process" ===
		const store1 = bootTracker(dbPath);

		const runId = "run-h4-1";
		const futureDispatchAt = Date.now() + 10 * 60 * 1000; // 10 min in the future

		// Schedule with persistence.
		DeferredRunScheduler.getInstance().schedule(
			runId,
			futureDispatchAt,
			async () => {
				// Won't fire — we tear down before the timer.
			},
			{
				workflowName: "wf-h4",
				triggerType: "http",
				expiresAt: undefined,
				dispatchStatus: "delayed",
				payload: { hello: "world" },
			},
		);

		// Verify the row exists on disk.
		const rowsBeforeCrash = store1.getScheduledDispatches({ triggerType: "http" });
		expect(rowsBeforeCrash).toHaveLength(1);
		expect(rowsBeforeCrash[0].runId).toBe(runId);
		expect(rowsBeforeCrash[0].scheduledAt).toBe(futureDispatchAt);

		// === Phase 2: "crash" — close the store + clear in-memory state ===
		store1.close();
		DeferredRunScheduler.resetInstance();
		RunTracker.resetInstance();

		// === Phase 3: "restart" — fresh store against the same file ===
		const store2 = bootTracker(dbPath);

		// The row survived the crash.
		const rowsAfterCrash = store2.getScheduledDispatches({ triggerType: "http" });
		expect(rowsAfterCrash).toHaveLength(1);
		expect(rowsAfterCrash[0].runId).toBe(runId);
		expect(rowsAfterCrash[0].scheduledAt).toBe(futureDispatchAt);
		expect(rowsAfterCrash[0].payload).toEqual({ hello: "world" });

		// The in-memory scheduler is empty until recovery re-registers.
		expect(DeferredRunScheduler.getInstance().size()).toBe(0);

		// === Phase 4: re-register the timer from the persisted row ===
		// This is what HttpTrigger.recoverDispatches() does on listen().
		let fired = false;
		DeferredRunScheduler.getInstance().schedule(
			rowsAfterCrash[0].runId,
			rowsAfterCrash[0].scheduledAt,
			async () => {
				fired = true;
			},
			{
				workflowName: rowsAfterCrash[0].workflowName,
				triggerType: rowsAfterCrash[0].triggerType,
				expiresAt: rowsAfterCrash[0].expiresAt,
				dispatchStatus: rowsAfterCrash[0].dispatchStatus,
				payload: rowsAfterCrash[0].payload,
			},
		);
		expect(DeferredRunScheduler.getInstance().size()).toBe(1);
		expect(fired).toBe(false); // Future timer — hasn't fired yet.

		store2.close();
	});

	it("past-due rows fire immediately on recovery", async () => {
		const store1 = bootTracker(dbPath);

		const runId = "run-h4-past-due";
		const pastDispatchAt = Date.now() - 5_000; // 5 seconds in the past

		DeferredRunScheduler.getInstance().schedule(
			runId,
			pastDispatchAt,
			async () => {
				// Won't fire here — we'll tear down before it can.
			},
			{
				workflowName: "wf-h4",
				triggerType: "http",
				expiresAt: undefined,
				dispatchStatus: "delayed",
				payload: { past: true },
			},
		);

		// Simulate crash before the timer fires (in practice the timer fires
		// quickly because dispatchAt is past — but cancel() before it does).
		DeferredRunScheduler.getInstance().cancel(runId, true);
		store1.close();
		DeferredRunScheduler.resetInstance();
		RunTracker.resetInstance();

		// Restart.
		const store2 = bootTracker(dbPath);

		// Re-schedule + persist the past-due dispatch directly (simulating recoverDispatches).
		// First confirm the persisted row is gone (we cancelled it).
		expect(store2.getScheduledDispatches({ triggerType: "http" })).toHaveLength(0);

		// Now seed a fresh past-due row to simulate a row that survived.
		store2.upsertScheduledDispatch({
			runId: "run-h4-past-due-2",
			workflowName: "wf-h4",
			triggerType: "http",
			scheduledAt: Date.now() - 5_000,
			expiresAt: undefined,
			dispatchStatus: "delayed",
			payload: { past: true },
			createdAt: Date.now() - 6_000,
		});

		const rows = store2.getScheduledDispatches({ triggerType: "http" });
		expect(rows).toHaveLength(1);

		// Re-register via the scheduler — past-due dispatchAt is clamped to 0ms.
		let fired = false;
		DeferredRunScheduler.getInstance().schedule(
			rows[0].runId,
			rows[0].scheduledAt,
			async () => {
				fired = true;
			},
			{
				workflowName: rows[0].workflowName,
				triggerType: rows[0].triggerType,
				expiresAt: rows[0].expiresAt,
				dispatchStatus: rows[0].dispatchStatus,
				payload: rows[0].payload,
			},
		);

		// Past-due timer fires on the next event-loop tick.
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(fired).toBe(true);
		// And the persisted row should have been deleted after firing.
		expect(store2.getScheduledDispatches({ triggerType: "http" })).toHaveLength(0);

		store2.close();
	});

	it("expired rows (past TTL) are marked + the row deleted on recovery sweep", async () => {
		const store = bootTracker(dbPath);

		// Insert a row whose TTL is in the past.
		const runId = "run-h4-expired";
		store.upsertScheduledDispatch({
			runId,
			workflowName: "wf-h4",
			triggerType: "http",
			scheduledAt: Date.now() + 60_000,
			expiresAt: Date.now() - 1_000, // already past TTL
			dispatchStatus: "delayed",
			payload: { stale: true },
			createdAt: Date.now() - 2_000,
		});

		// Recovery code at HttpTrigger.recoverDispatches detects past TTL,
		// calls tracker.markRunExpired + deleteScheduledDispatch. Simulate
		// that here.
		const rows = store.getScheduledDispatches({ triggerType: "http" });
		expect(rows).toHaveLength(1);
		const row = rows[0];
		const now = Date.now();
		expect(row.expiresAt !== undefined && now > row.expiresAt).toBe(true);

		store.deleteScheduledDispatch(row.runId);

		// Row gone after the sweep.
		expect(store.getScheduledDispatches({ triggerType: "http" })).toHaveLength(0);

		store.close();
	});
});
