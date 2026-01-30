import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
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
