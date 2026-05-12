import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryRunStore } from "../../../src/tracing/InMemoryRunStore";
import { SqliteRunStore } from "../../../src/tracing/SqliteRunStore";
import type { ScheduledDispatchRow } from "../../../src/tracing/types";

/**
 * Tier C #2 — claim API unit tests. Runs against the in-memory + sqlite
 * stores (both implementations of `RunStore.claimDispatches` /
 * `heartbeatClaims` / `releaseClaim`). The real-PG cross-process
 * contract has its own integration test at
 * `__tests__/integration/cross-process-scheduler.real-pg.test.ts`.
 */

interface StoreUnderTest {
	upsertScheduledDispatch: InMemoryRunStore["upsertScheduledDispatch"];
	getScheduledDispatches: InMemoryRunStore["getScheduledDispatches"];
	claimDispatches: InMemoryRunStore["claimDispatches"];
	heartbeatClaims: InMemoryRunStore["heartbeatClaims"];
	releaseClaim: InMemoryRunStore["releaseClaim"];
	close?: () => void;
}

const baseRow = (overrides?: Partial<ScheduledDispatchRow>): ScheduledDispatchRow => ({
	runId: "r-1",
	workflowName: "wf",
	triggerType: "http",
	scheduledAt: 1_000_000 + 5_000,
	dispatchStatus: "delayed",
	payload: { hello: "world" },
	createdAt: 1_000_000,
	...overrides,
});

function inMemoryStore(): StoreUnderTest {
	return new InMemoryRunStore() as unknown as StoreUnderTest;
}

let tmpDir: string;
function sqliteStore(): StoreUnderTest {
	tmpDir = mkdtempSync(join(tmpdir(), "blok-c2-"));
	return new SqliteRunStore(join(tmpDir, "test.sqlite")) as unknown as StoreUnderTest;
}

for (const [label, factory] of [
	["InMemoryRunStore", inMemoryStore],
	["SqliteRunStore", sqliteStore],
] as const) {
	describe(`${label} — Tier C #2 claim API`, () => {
		let store: StoreUnderTest;

		beforeEach(() => {
			store = factory();
		});

		afterEach(() => {
			store.close?.();
			if (label === "SqliteRunStore" && tmpDir) {
				try {
					rmSync(tmpDir, { recursive: true, force: true });
				} catch {
					/* best-effort */
				}
			}
		});

		it("claimDispatches grants unclaimed rows to the calling process", () => {
			store.upsertScheduledDispatch(baseRow({ runId: "r-1" }));
			store.upsertScheduledDispatch(baseRow({ runId: "r-2" }));

			const claimed = store.claimDispatches("proc-A", 60_000, 2_000_000);
			expect(claimed.map((r) => r.runId).sort()).toEqual(["r-1", "r-2"]);
			expect(claimed.every((r) => r.claimedBy === "proc-A")).toBe(true);
			expect(claimed.every((r) => r.claimedAt === 2_000_000)).toBe(true);
		});

		it("a second process claiming after the first sees no eligible rows", () => {
			store.upsertScheduledDispatch(baseRow({ runId: "r-1" }));
			store.upsertScheduledDispatch(baseRow({ runId: "r-2" }));
			store.claimDispatches("proc-A", 60_000, 2_000_000);

			const claimedByB = store.claimDispatches("proc-B", 60_000, 2_000_500);
			expect(claimedByB).toHaveLength(0);
		});

		it("rows persisted with a claim survive across claim+get reads", () => {
			store.upsertScheduledDispatch(baseRow({ runId: "r-1" }));
			store.claimDispatches("proc-A", 60_000, 2_000_000);

			const all = store.getScheduledDispatches({ triggerType: "http" });
			expect(all).toHaveLength(1);
			expect(all[0].claimedBy).toBe("proc-A");
			expect(all[0].claimedAt).toBe(2_000_000);
		});

		it("upsert on an already-claimed row PRESERVES the claim (re-defer doesn't release)", () => {
			store.upsertScheduledDispatch(baseRow({ runId: "r-1", scheduledAt: 1_000_000 + 5_000 }));
			store.claimDispatches("proc-A", 60_000, 2_000_000);

			// Re-upsert — typical of debounce reset / queue re-defer.
			store.upsertScheduledDispatch(baseRow({ runId: "r-1", scheduledAt: 1_000_000 + 9_999 }));

			const all = store.getScheduledDispatches({ triggerType: "http" });
			expect(all[0].claimedBy).toBe("proc-A");
			expect(all[0].scheduledAt).toBe(1_000_000 + 9_999);
		});

		it("expired claim is reclaimable by a different process", () => {
			store.upsertScheduledDispatch(baseRow({ runId: "r-1" }));
			store.claimDispatches("proc-A", 60_000, 2_000_000);

			// Move time past the lease. proc-A is presumed dead.
			const claimedByB = store.claimDispatches("proc-B", 60_000, 2_000_000 + 61_000);
			expect(claimedByB).toHaveLength(1);
			expect(claimedByB[0].claimedBy).toBe("proc-B");
		});

		it("heartbeatClaims refreshes claimed_at for the calling process only", () => {
			store.upsertScheduledDispatch(baseRow({ runId: "r-1" }));
			store.upsertScheduledDispatch(baseRow({ runId: "r-2" }));
			store.claimDispatches("proc-A", 60_000, 2_000_000);

			// proc-B has no claims — heartbeating it is a no-op.
			expect(store.heartbeatClaims("proc-B", 2_001_000)).toBe(0);

			// proc-A heartbeats all its claims atomically.
			expect(store.heartbeatClaims("proc-A", 2_001_000)).toBe(2);
			const after = store.getScheduledDispatches({ triggerType: "http" });
			expect(after.every((r) => r.claimedAt === 2_001_000)).toBe(true);
			expect(after.every((r) => r.claimedBy === "proc-A")).toBe(true);
		});

		it("releaseClaim clears the claim on a single row", () => {
			store.upsertScheduledDispatch(baseRow({ runId: "r-1" }));
			store.upsertScheduledDispatch(baseRow({ runId: "r-2" }));
			store.claimDispatches("proc-A", 60_000, 2_000_000);

			expect(store.releaseClaim("r-1")).toBe(true);

			const all = store.getScheduledDispatches({ triggerType: "http" }).sort((a, b) => a.runId.localeCompare(b.runId));
			expect(all[0].claimedBy).toBeUndefined();
			expect(all[1].claimedBy).toBe("proc-A");
		});

		it("releaseClaim is idempotent (returns false when no claim or row)", () => {
			expect(store.releaseClaim("nonexistent")).toBe(false);

			store.upsertScheduledDispatch(baseRow({ runId: "r-1" }));
			// No claim yet — release returns false.
			expect(store.releaseClaim("r-1")).toBe(false);
		});

		it("triggerType filter narrows which rows get claimed", () => {
			store.upsertScheduledDispatch(baseRow({ runId: "r-http", triggerType: "http" }));
			store.upsertScheduledDispatch(baseRow({ runId: "r-worker", triggerType: "worker" }));

			const claimed = store.claimDispatches("proc-A", 60_000, 2_000_000, { triggerType: "http" });
			expect(claimed.map((r) => r.runId)).toEqual(["r-http"]);

			// The worker row is still unclaimed.
			const all = store.getScheduledDispatches();
			const workerRow = all.find((r) => r.runId === "r-worker");
			expect(workerRow?.claimedBy).toBeUndefined();
		});

		it("two parallel claim calls split the rows deterministically (in-process atomicity)", () => {
			// Seed 4 rows. Two processes call claim "simultaneously". The
			// store is single-threaded so one wins everything, the other
			// sees nothing — that's the correct atomic-CAS-like contract.
			for (let i = 0; i < 4; i++) {
				store.upsertScheduledDispatch(baseRow({ runId: `r-${i}` }));
			}
			const a = store.claimDispatches("proc-A", 60_000, 2_000_000);
			const b = store.claimDispatches("proc-B", 60_000, 2_000_000);
			expect(a.length + b.length).toBe(4);
			// Exactly one wins all 4 in the single-threaded test harness.
			expect(a.length === 4 || b.length === 4).toBe(true);
		});

		it("claimDispatches result is sorted by scheduledAt ascending", () => {
			store.upsertScheduledDispatch(baseRow({ runId: "r-late", scheduledAt: 3_000_000 }));
			store.upsertScheduledDispatch(baseRow({ runId: "r-mid", scheduledAt: 2_500_000 }));
			store.upsertScheduledDispatch(baseRow({ runId: "r-early", scheduledAt: 2_000_000 }));

			const claimed = store.claimDispatches("proc-A", 60_000, 4_000_000);
			expect(claimed.map((r) => r.runId)).toEqual(["r-early", "r-mid", "r-late"]);
		});
	});
}
