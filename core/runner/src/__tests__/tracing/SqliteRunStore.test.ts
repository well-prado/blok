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

// G2 follow-up (v0.6) — NodeRun.flags_json column (migration v16).
// Previously `wait`, `dispatch`, `subworkflowDepth`, `middleware`,
// `iterationIndex` rode only on the in-memory NodeRun and silently
// dropped on sqlite round-trip — the Studio rail badges (↳ async,
// ↳ sub, mw:<name>, iteration headers, http) disappeared after a
// browser refresh or process restart. The new `flags_json` JSON bag
// fixes the gap; this test pins the round-trip semantics across a
// store-close + reopen.
describe("SqliteRunStore: NodeRun flags_json (migration v16)", () => {
	it("round-trips every persisted flag across a process restart", () => {
		if (!existsSync(TEST_DB_DIR)) mkdirSync(TEST_DB_DIR, { recursive: true });
		const dbPath = join(TEST_DB_DIR, `flags-${Date.now()}.db`);

		const store1 = new SqliteRunStore(dbPath);
		store1.saveRun({
			id: "run_flags",
			workflowName: "wf",
			workflowPath: "/wf",
			triggerType: "http",
			triggerSummary: "POST /wf",
			status: "completed",
			startedAt: 1_000,
			nodeCount: 1,
			completedNodes: 1,
		});
		store1.saveNodeRun({
			id: "node_async_http",
			runId: "run_flags",
			nodeName: "send-receipt",
			nodeType: "subworkflow",
			status: "completed",
			startedAt: 1_000,
			depth: 0,
			stepIndex: 0,
			wait: false,
			dispatch: "http-self",
			subworkflowDepth: 2,
			middleware: "auth-check",
			iterationIndex: 3,
		});
		store1.close();

		const store2 = new SqliteRunStore(dbPath);
		const got = store2.getNodeRun("node_async_http");
		expect(got).toBeDefined();
		expect(got?.wait).toBe(false);
		expect(got?.dispatch).toBe("http-self");
		expect(got?.subworkflowDepth).toBe(2);
		expect(got?.middleware).toBe("auth-check");
		expect(got?.iterationIndex).toBe(3);
		store2.close();
	});

	it("leaves flags_json NULL when no flags are set + returns undefined for each field", () => {
		const store = createTestStore();
		store.saveRun({
			id: "run_no_flags",
			workflowName: "wf",
			workflowPath: "/wf",
			triggerType: "http",
			triggerSummary: "POST /wf",
			status: "completed",
			startedAt: 1_000,
			nodeCount: 1,
			completedNodes: 1,
		});
		store.saveNodeRun({
			id: "node_plain",
			runId: "run_no_flags",
			nodeName: "do-thing",
			nodeType: "module",
			status: "completed",
			startedAt: 1_000,
			depth: 0,
			stepIndex: 0,
		});

		const got = store.getNodeRun("node_plain");
		expect(got?.wait).toBeUndefined();
		expect(got?.dispatch).toBeUndefined();
		expect(got?.subworkflowDepth).toBeUndefined();
		expect(got?.middleware).toBeUndefined();
		expect(got?.iterationIndex).toBeUndefined();
		store.close();
	});

	it("partial flag set — `dispatch` only — round-trips without coercing siblings", () => {
		const store = createTestStore();
		store.saveRun({
			id: "run_partial",
			workflowName: "wf",
			workflowPath: "/wf",
			triggerType: "http",
			triggerSummary: "POST /wf",
			status: "completed",
			startedAt: 1_000,
			nodeCount: 1,
			completedNodes: 1,
		});
		store.saveNodeRun({
			id: "node_dispatch_only",
			runId: "run_partial",
			nodeName: "send-receipt",
			nodeType: "subworkflow",
			status: "completed",
			startedAt: 1_000,
			depth: 0,
			stepIndex: 0,
			dispatch: "in-process",
		});

		const got = store.getNodeRun("node_dispatch_only");
		expect(got?.dispatch).toBe("in-process");
		expect(got?.wait).toBeUndefined();
		expect(got?.subworkflowDepth).toBeUndefined();
		store.close();
	});
});

// F1 (v0.5) — indexed metadata generated columns + indexes.
describe("SqliteRunStore: indexed metadata keys (F1)", () => {
	function makeRun(id: string, metadata: Record<string, unknown>) {
		return {
			id,
			workflowName: "wf",
			workflowPath: "/wf",
			triggerType: "http" as const,
			triggerSummary: "POST /wf",
			status: "completed" as const,
			startedAt: Date.now(),
			nodeCount: 1,
			completedNodes: 1,
			metadata,
		};
	}

	/**
	 * Narrow shape of the bits of `better-sqlite3` / `bun:sqlite` we
	 * read here — just enough to introspect the schema via PRAGMAs.
	 * Stays on the safe `as unknown as <T>` boundary-cast path required
	 * by the repo's no-`any`-in-tests rule.
	 */
	interface SqliteIntrospectDb {
		prepare(sql: string): { all(): unknown[] };
	}

	function pragmaColumns(store: SqliteRunStore): string[] {
		const db = (store as unknown as { db: SqliteIntrospectDb }).db;
		// `table_xinfo` reports both visible AND hidden columns.
		// Virtual generated columns (the F1 indexed metadata columns)
		// are hidden columns under SQLite's classification, so the
		// shorter `table_info` would silently skip them.
		return db
			.prepare("PRAGMA table_xinfo(workflow_runs)")
			.all()
			.map((r) => (r as { name: string }).name);
	}

	function pragmaIndexes(store: SqliteRunStore): string[] {
		const db = (store as unknown as { db: SqliteIntrospectDb }).db;
		return db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'workflow_runs'")
			.all()
			.map((r) => (r as { name: string }).name);
	}

	function withStore<T>(opts: { indexedMetadataKeys?: string[] }, fn: (store: SqliteRunStore, dbPath: string) => T): T {
		if (!existsSync(TEST_DB_DIR)) mkdirSync(TEST_DB_DIR, { recursive: true });
		const dbPath = join(TEST_DB_DIR, `indexed-${Date.now()}-${dbCounter++}.db`);
		const store = new SqliteRunStore(dbPath, opts);
		try {
			return fn(store, dbPath);
		} finally {
			store.close();
		}
	}

	it("creates a generated column + index for each declared key", () => {
		withStore({ indexedMetadataKeys: ["tier", "region"] }, (store) => {
			const cols = pragmaColumns(store);
			expect(cols).toContain("metadata_tier_idx");
			expect(cols).toContain("metadata_region_idx");
			const idxs = pragmaIndexes(store);
			expect(idxs).toContain("idx_workflow_runs_metadata_tier");
			expect(idxs).toContain("idx_workflow_runs_metadata_region");
		});
	});

	it("no-ops when the keys list is empty (no schema change)", () => {
		withStore({ indexedMetadataKeys: [] }, (store) => {
			const cols = pragmaColumns(store);
			expect(cols).not.toContain("metadata_tier_idx");
			const idxs = pragmaIndexes(store);
			expect(idxs.filter((i) => i.startsWith("idx_workflow_runs_metadata_"))).toHaveLength(0);
		});
	});

	it("indexed columns return the same row set as the non-indexed filter (semantic parity)", () => {
		// Same data + same filter via two stores (one indexed, one not).
		// Both must return identical results — F1 is a performance hint,
		// not a semantic change.
		const dbPath = join(TEST_DB_DIR, `parity-${Date.now()}-${dbCounter++}.db`);
		if (!existsSync(TEST_DB_DIR)) mkdirSync(TEST_DB_DIR, { recursive: true });

		const indexed = new SqliteRunStore(dbPath, { indexedMetadataKeys: ["tier"] });
		indexed.saveRun(makeRun("run_1", { tier: "premium" }));
		indexed.saveRun(makeRun("run_2", { tier: "free" }));
		indexed.saveRun(makeRun("run_3", { tier: "premium" }));

		const indexedResult = indexed
			.getRuns({ metadata: { tier: "premium" } })
			.runs.map((r) => r.id)
			.sort();
		indexed.close();

		const dbPath2 = join(TEST_DB_DIR, `parity-noidx-${Date.now()}-${dbCounter++}.db`);
		const nonIndexed = new SqliteRunStore(dbPath2, { indexedMetadataKeys: [] });
		nonIndexed.saveRun(makeRun("run_1", { tier: "premium" }));
		nonIndexed.saveRun(makeRun("run_2", { tier: "free" }));
		nonIndexed.saveRun(makeRun("run_3", { tier: "premium" }));

		const nonIndexedResult = nonIndexed
			.getRuns({ metadata: { tier: "premium" } })
			.runs.map((r) => r.id)
			.sort();
		nonIndexed.close();

		expect(indexedResult).toEqual(nonIndexedResult);
		expect(indexedResult).toEqual(["run_1", "run_3"]);
	});

	it("operator filters work against indexed columns", () => {
		withStore({ indexedMetadataKeys: ["count"] }, (store) => {
			store.saveRun(makeRun("run_1", { count: 5 }));
			store.saveRun(makeRun("run_2", { count: 10 }));
			store.saveRun(makeRun("run_3", { count: 20 }));

			const gt = store.getRuns({ metadata: [{ key: "count", op: "gt", value: "10" }] }).runs.map((r) => r.id);
			expect(gt).toEqual(["run_3"]);
		});
	});

	it("opening an existing db with a new key adds the column + index without losing data", () => {
		// First boot: index only `tier`.
		const dbPath = join(TEST_DB_DIR, `evolve-${Date.now()}-${dbCounter++}.db`);
		if (!existsSync(TEST_DB_DIR)) mkdirSync(TEST_DB_DIR, { recursive: true });
		const first = new SqliteRunStore(dbPath, { indexedMetadataKeys: ["tier"] });
		first.saveRun(makeRun("run_1", { tier: "premium", region: "us" }));
		first.close();

		// Second boot: add `region` to the indexed-keys list. The
		// generated column + index should be created without losing the
		// existing row.
		const second = new SqliteRunStore(dbPath, { indexedMetadataKeys: ["tier", "region"] });
		const cols = pragmaColumns(second);
		expect(cols).toContain("metadata_tier_idx");
		expect(cols).toContain("metadata_region_idx");
		const fetched = second.getRun("run_1");
		expect(fetched?.metadata).toEqual({ tier: "premium", region: "us" });
		second.close();
	});

	it("declared keys outside ^[a-zA-Z0-9_-]+$ are silently dropped", () => {
		// Don't blow up the store boot if an operator misconfigures the
		// env var with a JSON-path-unsafe key. Filter at construction.
		withStore({ indexedMetadataKeys: ["tier", "bad'; DROP", "region"] }, (store) => {
			const cols = pragmaColumns(store);
			expect(cols).toContain("metadata_tier_idx");
			expect(cols).toContain("metadata_region_idx");
			expect(cols.some((c) => c.includes("DROP"))).toBe(false);
		});
	});
});
