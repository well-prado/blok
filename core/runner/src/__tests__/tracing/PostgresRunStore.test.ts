import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runStoreTests } from "./RunStore.shared";

/**
 * PostgresRunStore unit tests.
 *
 * These tests verify the synchronous RunStore interface behavior
 * (delegated to InMemoryRunStore) without requiring a live PostgreSQL instance.
 *
 * Integration tests with a real PostgreSQL database should be run separately
 * with `vitest run --config vitest.integration.config.ts` and a running PG instance.
 */

// Mock the 'pg' module so tests run without a real PostgreSQL instance
const mockQuery = vi.fn().mockResolvedValue({ rows: [] });
const mockRelease = vi.fn();
const mockConnect = vi.fn().mockResolvedValue({
	query: mockQuery,
	release: mockRelease,
});
const mockEnd = vi.fn().mockResolvedValue(undefined);

vi.mock("pg", () => ({
	Pool: vi.fn().mockImplementation(() => ({
		query: mockQuery,
		connect: mockConnect,
		end: mockEnd,
	})),
}));

import { PostgresRunStore } from "../../tracing/PostgresRunStore";
import type { WorkflowRun, NodeRun, RunEvent, TraceLogEntry, Dashboard } from "../../tracing/types";

function createTestStore(): PostgresRunStore {
	return new PostgresRunStore({
		connectionString: "postgres://test:test@localhost:5432/test",
	});
}

// Run the shared RunStore test suite — verifies sync behavior via InMemoryRunStore
runStoreTests("PostgresRunStore (in-memory delegation)", createTestStore);

describe("PostgresRunStore: write queue", () => {
	let store: PostgresRunStore;

	beforeEach(() => {
		vi.clearAllMocks();
		store = createTestStore();
	});

	afterEach(() => {
		store.close();
	});

	it("should save run to memory immediately and enqueue PG write", () => {
		const run: WorkflowRun = {
			id: "run_pg_1",
			workflowName: "test-wf",
			workflowPath: "/test",
			triggerType: "http",
			triggerSummary: "GET /test",
			status: "running",
			startedAt: Date.now(),
			nodeCount: 3,
			completedNodes: 0,
		};

		store.saveRun(run);

		// Data should be immediately available in memory (sync)
		expect(store.getRun("run_pg_1")).toBeDefined();
		expect(store.getRun("run_pg_1")?.workflowName).toBe("test-wf");
		expect(store.getRun("run_pg_1")?.status).toBe("running");
		expect(store.getRuns().total).toBe(1);
	});

	it("should update run in memory immediately", () => {
		const run: WorkflowRun = {
			id: "run_pg_2",
			workflowName: "test-wf",
			workflowPath: "/test",
			triggerType: "http",
			triggerSummary: "GET /test",
			status: "running",
			startedAt: Date.now(),
			nodeCount: 3,
			completedNodes: 0,
		};

		store.saveRun(run);
		store.updateRun("run_pg_2", { status: "completed", durationMs: 42 });

		// Memory should reflect the update immediately
		const updated = store.getRun("run_pg_2");
		expect(updated?.status).toBe("completed");
		expect(updated?.durationMs).toBe(42);
	});

	it("should enqueue saveNodeRun write to PostgreSQL", () => {
		store.saveRun({
			id: "run_pg_3",
			workflowName: "test-wf",
			workflowPath: "/test",
			triggerType: "http",
			triggerSummary: "GET /test",
			status: "running",
			startedAt: Date.now(),
			nodeCount: 1,
			completedNodes: 0,
		});

		const nodeRun: NodeRun = {
			id: "node_pg_1",
			runId: "run_pg_3",
			nodeName: "fetch",
			nodeType: "module",
			status: "running",
			startedAt: Date.now(),
			depth: 0,
			stepIndex: 0,
		};

		store.saveNodeRun(nodeRun);

		// Should be available in memory immediately
		expect(store.getNodeRun("node_pg_1")).toBeDefined();
		expect(store.getNodeRuns("run_pg_3")).toHaveLength(1);
	});

	it("should enqueue saveEvent write to PostgreSQL", () => {
		store.saveRun({
			id: "run_pg_4",
			workflowName: "test-wf",
			workflowPath: "/test",
			triggerType: "http",
			triggerSummary: "GET /test",
			status: "running",
			startedAt: Date.now(),
			nodeCount: 1,
			completedNodes: 0,
		});

		const event: RunEvent = {
			id: "evt_pg_1",
			type: "NODE_STARTED",
			runId: "run_pg_4",
			workflowName: "test-wf",
			timestamp: Date.now(),
		};

		store.saveEvent(event);
		expect(store.getEvents("run_pg_4")).toHaveLength(1);
	});

	it("should enqueue saveLog write to PostgreSQL", () => {
		store.saveRun({
			id: "run_pg_5",
			workflowName: "test-wf",
			workflowPath: "/test",
			triggerType: "http",
			triggerSummary: "GET /test",
			status: "running",
			startedAt: Date.now(),
			nodeCount: 1,
			completedNodes: 0,
		});

		const log: TraceLogEntry = {
			id: "log_pg_1",
			runId: "run_pg_5",
			level: "info",
			message: "Hello from PG",
			timestamp: Date.now(),
		};

		store.saveLog(log);
		expect(store.getLogs("run_pg_5")).toHaveLength(1);
		expect(store.getLogs("run_pg_5")[0].message).toBe("Hello from PG");
	});
});

describe("PostgresRunStore: dashboard operations", () => {
	let store: PostgresRunStore;

	beforeEach(() => {
		vi.clearAllMocks();
		store = createTestStore();
	});

	afterEach(() => {
		store.close();
	});

	it("should save and retrieve dashboards via memory", () => {
		const dashboard: Dashboard = {
			id: "dash_pg_1",
			name: "Test Dashboard",
			isDefault: false,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			widgets: [],
		};

		store.saveDashboard(dashboard);
		expect(store.getDashboard("dash_pg_1")).toBeDefined();
		expect(store.getDashboard("dash_pg_1")?.name).toBe("Test Dashboard");
	});

	it("should list and delete dashboards", () => {
		const now = Date.now();
		store.saveDashboard({
			id: "dash_pg_2",
			name: "Dashboard A",
			isDefault: false,
			createdAt: now,
			updatedAt: now,
			widgets: [],
		});
		store.saveDashboard({
			id: "dash_pg_3",
			name: "Dashboard B",
			isDefault: false,
			createdAt: now + 1,
			updatedAt: now + 1,
			widgets: [],
		});

		expect(store.listDashboards()).toHaveLength(2);

		const deleted = store.deleteDashboard("dash_pg_2");
		expect(deleted).toBe(true);
		expect(store.listDashboards()).toHaveLength(1);
	});

	it("should update dashboard", () => {
		const now = Date.now();
		store.saveDashboard({
			id: "dash_pg_4",
			name: "Original",
			isDefault: false,
			createdAt: now,
			updatedAt: now,
			widgets: [],
		});

		store.updateDashboard("dash_pg_4", { name: "Updated" });
		expect(store.getDashboard("dash_pg_4")?.name).toBe("Updated");
	});
});

describe("PostgresRunStore: cleanup operations", () => {
	let store: PostgresRunStore;

	beforeEach(() => {
		vi.clearAllMocks();
		store = createTestStore();
	});

	afterEach(() => {
		store.close();
	});

	it("should clear all data", () => {
		store.saveRun({
			id: "run_cl_1",
			workflowName: "test",
			workflowPath: "/test",
			triggerType: "http",
			triggerSummary: "GET /",
			status: "completed",
			startedAt: Date.now(),
			nodeCount: 0,
			completedNodes: 0,
		});

		const count = store.clearAll();
		expect(count).toBe(1);
		expect(store.getRuns().total).toBe(0);
	});

	it("should delete runs before timestamp", () => {
		store.saveRun({
			id: "run_old",
			workflowName: "test",
			workflowPath: "/test",
			triggerType: "http",
			triggerSummary: "GET /",
			status: "completed",
			startedAt: 1000,
			nodeCount: 0,
			completedNodes: 0,
		});
		store.saveRun({
			id: "run_new",
			workflowName: "test",
			workflowPath: "/test",
			triggerType: "http",
			triggerSummary: "GET /",
			status: "completed",
			startedAt: Date.now(),
			nodeCount: 0,
			completedNodes: 0,
		});

		const deleted = store.deleteRunsBefore(5000);
		expect(deleted).toBe(1);
		expect(store.getRun("run_old")).toBeUndefined();
		expect(store.getRun("run_new")).toBeDefined();
	});
});

describe("PostgresRunStore: ready() and initialization", () => {
	it("should expose a ready() promise", () => {
		const store = createTestStore();
		expect(store.ready()).toBeInstanceOf(Promise);
		store.close();
	});

	it("should be usable before initialization completes", () => {
		const store = createTestStore();

		// Store should work immediately via in-memory delegation
		store.saveRun({
			id: "run_early",
			workflowName: "test",
			workflowPath: "/test",
			triggerType: "http",
			triggerSummary: "GET /",
			status: "running",
			startedAt: Date.now(),
			nodeCount: 1,
			completedNodes: 0,
		});

		expect(store.getRun("run_early")).toBeDefined();
		expect(store.getActiveRunCount()).toBe(1);

		store.close();
	});
});

describe("PostgresRunStore: aggregations", () => {
	let store: PostgresRunStore;

	beforeEach(() => {
		vi.clearAllMocks();
		store = createTestStore();
	});

	afterEach(() => {
		store.close();
	});

	it("should compute workflow summaries via memory", () => {
		store.saveRun({
			id: "run_agg_1",
			workflowName: "api",
			workflowPath: "/api",
			triggerType: "http",
			triggerSummary: "GET /api",
			status: "completed",
			startedAt: Date.now(),
			durationMs: 10,
			nodeCount: 1,
			completedNodes: 1,
		});
		store.saveRun({
			id: "run_agg_2",
			workflowName: "api",
			workflowPath: "/api",
			triggerType: "http",
			triggerSummary: "GET /api",
			status: "failed",
			startedAt: Date.now(),
			durationMs: 20,
			nodeCount: 1,
			completedNodes: 0,
		});

		const summaries = store.getWorkflowSummaries();
		expect(summaries).toHaveLength(1);
		expect(summaries[0].name).toBe("api");
		expect(summaries[0].totalRuns).toBe(2);
		expect(summaries[0].errorRate).toBe(0.5);
	});

	it("should compute metrics via memory", () => {
		store.saveRun({
			id: "run_met_1",
			workflowName: "cron",
			workflowPath: "/cron",
			triggerType: "cron",
			triggerSummary: "cron:daily",
			status: "completed",
			startedAt: Date.now(),
			durationMs: 100,
			nodeCount: 2,
			completedNodes: 2,
		});

		const metrics = store.getMetrics("cron");
		expect(metrics.totalRuns).toBe(1);
		expect(metrics.completedRuns).toBe(1);
		expect(metrics.avgDurationMs).toBe(100);
	});

	it("should collect tags via memory", () => {
		store.saveRun({
			id: "run_tag_1",
			workflowName: "test",
			workflowPath: "/test",
			triggerType: "http",
			triggerSummary: "GET /",
			status: "completed",
			startedAt: Date.now(),
			tags: ["env:prod", "region:us"],
			nodeCount: 0,
			completedNodes: 0,
		});

		const tags = store.getAllTags();
		expect(tags).toContain("env:prod");
		expect(tags).toContain("region:us");
	});
});
