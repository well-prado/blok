import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteRunStore } from "../../tracing/SqliteRunStore";
import { runStoreTests } from "./RunStore.shared";

const TEST_DB_DIR = join(__dirname, ".test-dbs");
let dbCounter = 0;

function createTestStore(): SqliteRunStore {
	if (!existsSync(TEST_DB_DIR)) mkdirSync(TEST_DB_DIR, { recursive: true });
	const dbPath = join(TEST_DB_DIR, `test-${Date.now()}-${dbCounter++}.db`);
	return new SqliteRunStore(dbPath);
}

// Cleanup test databases after all tests
afterEach(() => {
	// Databases are closed when store.close() is called or gc'd
});

// Clean up dir after all tests in this file
import { afterAll } from "vitest";
afterAll(() => {
	if (existsSync(TEST_DB_DIR)) {
		rmSync(TEST_DB_DIR, { recursive: true, force: true });
	}
});

// Run shared store tests
runStoreTests("SqliteRunStore", createTestStore);

// SQLite-specific tests
describe("SqliteRunStore: persistence", () => {
	it("should persist data across store instances", () => {
		if (!existsSync(TEST_DB_DIR)) mkdirSync(TEST_DB_DIR, { recursive: true });
		const dbPath = join(TEST_DB_DIR, `persist-${Date.now()}.db`);

		// Write data
		const store1 = new SqliteRunStore(dbPath);
		store1.saveRun({
			id: "run_persist",
			workflowName: "persistent-wf",
			workflowPath: "/persistent",
			triggerType: "http",
			triggerSummary: "GET /test",
			status: "completed",
			startedAt: Date.now(),
			durationMs: 42,
			nodeCount: 1,
			completedNodes: 1,
		});
		store1.close();

		// Read data in new instance
		const store2 = new SqliteRunStore(dbPath);
		const run = store2.getRun("run_persist");
		expect(run).toBeDefined();
		expect(run?.workflowName).toBe("persistent-wf");
		expect(run?.durationMs).toBe(42);
		store2.close();
	});

	it("should auto-migrate schema", () => {
		if (!existsSync(TEST_DB_DIR)) mkdirSync(TEST_DB_DIR, { recursive: true });
		const dbPath = join(TEST_DB_DIR, `migrate-${Date.now()}.db`);

		// First instance creates schema
		const store1 = new SqliteRunStore(dbPath);
		store1.saveRun({
			id: "run_1",
			workflowName: "wf",
			workflowPath: "/wf",
			triggerType: "http",
			triggerSummary: "GET /",
			status: "running",
			startedAt: Date.now(),
			nodeCount: 0,
			completedNodes: 0,
		});
		store1.close();

		// Second instance re-opens — should not fail
		const store2 = new SqliteRunStore(dbPath);
		expect(store2.getRun("run_1")).toBeDefined();
		store2.close();
	});
});

describe("SqliteRunStore: cascade deletes", () => {
	it("should delete child rows when run is deleted", () => {
		const store = createTestStore();
		store.saveRun({
			id: "run_c",
			workflowName: "wf",
			workflowPath: "/wf",
			triggerType: "http",
			triggerSummary: "GET /",
			status: "completed",
			startedAt: 1000,
			nodeCount: 1,
			completedNodes: 1,
		});
		store.saveNodeRun({
			id: "node_c",
			runId: "run_c",
			nodeName: "n",
			nodeType: "module",
			status: "completed",
			startedAt: 1000,
			depth: 0,
			stepIndex: 0,
		});
		store.saveEvent({
			id: "evt_c",
			type: "RUN_STARTED",
			runId: "run_c",
			workflowName: "wf",
			timestamp: 1000,
		});
		store.saveLog({
			id: "log_c",
			runId: "run_c",
			level: "info",
			message: "hello",
			timestamp: 1000,
		});

		store.deleteRunsBefore(5000);

		expect(store.getRun("run_c")).toBeUndefined();
		expect(store.getNodeRuns("run_c")).toEqual([]);
		expect(store.getEvents("run_c")).toEqual([]);
		expect(store.getLogs("run_c")).toEqual([]);

		store.close();
	});
});

describe("SqliteRunStore: state_snapshot column (migration v11)", () => {
	it("round-trips stateSnapshot through saveRun + getRun", () => {
		const store = createTestStore();
		const snapshot = JSON.stringify({ orderId: "abc", items: [1, 2, 3], step: "checkout" });

		store.saveRun({
			id: "run_snap_1",
			workflowName: "wf-with-wait",
			workflowPath: "/wait",
			triggerType: "http",
			triggerSummary: "POST /checkout",
			status: "delayed",
			startedAt: Date.now(),
			nodeCount: 5,
			completedNodes: 2,
			stateSnapshot: snapshot,
		});

		const got = store.getRun("run_snap_1");
		expect(got).toBeDefined();
		expect(got?.stateSnapshot).toBe(snapshot);

		// JSON.parse round-trip yields the original object
		const parsed = got?.stateSnapshot ? (JSON.parse(got.stateSnapshot) as Record<string, unknown>) : undefined;
		expect(parsed).toEqual({ orderId: "abc", items: [1, 2, 3], step: "checkout" });

		store.close();
	});

	it("returns undefined stateSnapshot when no snapshot was set", () => {
		const store = createTestStore();
		store.saveRun({
			id: "run_no_snap",
			workflowName: "wf",
			workflowPath: "/x",
			triggerType: "http",
			triggerSummary: "GET /x",
			status: "completed",
			startedAt: Date.now(),
			nodeCount: 0,
			completedNodes: 0,
		});

		const got = store.getRun("run_no_snap");
		expect(got).toBeDefined();
		expect(got?.stateSnapshot).toBeUndefined();

		store.close();
	});

	it("updateRun can set stateSnapshot independently of other fields", () => {
		const store = createTestStore();
		store.saveRun({
			id: "run_update",
			workflowName: "wf",
			workflowPath: "/x",
			triggerType: "http",
			triggerSummary: "POST /wait",
			status: "running",
			startedAt: Date.now(),
			nodeCount: 0,
			completedNodes: 0,
		});

		const snapshot = JSON.stringify({ resumeFrom: 3 });
		store.updateRun("run_update", { stateSnapshot: snapshot });

		const got = store.getRun("run_update");
		expect(got?.stateSnapshot).toBe(snapshot);
		// Other fields untouched
		expect(got?.status).toBe("running");
		expect(got?.workflowName).toBe("wf");

		store.close();
	});

	it("survives store-close + reopen — proves cross-process recovery path", () => {
		// Same pattern as the existing persistence test above. Critical
		// invariant for v0.6 prerequisite (a) — the snapshot column must
		// outlive the JS process so `recoverDispatches → restoreDispatch`
		// on a fresh boot can rehydrate state into the rebuilt ctx.
		if (!existsSync(TEST_DB_DIR)) mkdirSync(TEST_DB_DIR, { recursive: true });
		const dbPath = join(TEST_DB_DIR, `snap-persist-${Date.now()}.db`);

		const store1 = new SqliteRunStore(dbPath);
		const snapshot = JSON.stringify({ user: { id: "u-1", role: "admin" }, cart: [{ sku: "abc" }] });
		store1.saveRun({
			id: "run_persist_snap",
			workflowName: "wf",
			workflowPath: "/wait",
			triggerType: "http",
			triggerSummary: "POST /wait",
			status: "delayed",
			startedAt: Date.now(),
			nodeCount: 4,
			completedNodes: 1,
			lastCompletedStepIndex: 0,
			stateSnapshot: snapshot,
		});
		store1.close();

		// Fresh process — open from disk
		const store2 = new SqliteRunStore(dbPath);
		const got = store2.getRun("run_persist_snap");
		expect(got?.stateSnapshot).toBe(snapshot);
		expect(got?.lastCompletedStepIndex).toBe(0);
		store2.close();
	});
});
