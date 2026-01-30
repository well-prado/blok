/**
 * Shared test suite for RunStore implementations.
 * Tests all interface methods against any RunStore backend.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { RunStore } from "../../tracing/RunStore";
import type { NodeRun, RunEvent, TraceLogEntry, WorkflowRun } from "../../tracing/types";

function makeRun(id: string, overrides?: Partial<WorkflowRun>): WorkflowRun {
	return {
		id,
		workflowName: "test-workflow",
		workflowPath: "/test",
		triggerType: "http",
		triggerSummary: "POST /api/test",
		status: "running",
		startedAt: Date.now(),
		nodeCount: 3,
		completedNodes: 0,
		...overrides,
	};
}

function makeNodeRun(id: string, runId: string, overrides?: Partial<NodeRun>): NodeRun {
	return {
		id,
		runId,
		nodeName: "node-1",
		nodeType: "module",
		status: "running",
		startedAt: Date.now(),
		depth: 0,
		stepIndex: 0,
		...overrides,
	};
}

function makeEvent(id: string, runId: string, overrides?: Partial<RunEvent>): RunEvent {
	return {
		id,
		type: "NODE_STARTED",
		runId,
		workflowName: "test-workflow",
		timestamp: Date.now(),
		...overrides,
	};
}

function makeLog(id: string, runId: string, overrides?: Partial<TraceLogEntry>): TraceLogEntry {
	return {
		id,
		runId,
		level: "info",
		message: "test message",
		timestamp: Date.now(),
		...overrides,
	};
}

export function runStoreTests(name: string, factory: () => RunStore) {
	describe(`RunStore: ${name}`, () => {
		let store: RunStore;

		beforeEach(() => {
			store = factory();
			store.clearAll();
		});

		// === Run CRUD ===

		describe("runs", () => {
			it("should save and retrieve a run", () => {
				const run = makeRun("run_1");
				store.saveRun(run);
				const fetched = store.getRun("run_1");
				expect(fetched).toBeDefined();
				expect(fetched?.id).toBe("run_1");
				expect(fetched?.workflowName).toBe("test-workflow");
				expect(fetched?.status).toBe("running");
			});

			it("should return undefined for unknown run", () => {
				expect(store.getRun("nonexistent")).toBeUndefined();
			});

			it("should update a run", () => {
				store.saveRun(makeRun("run_1"));
				store.updateRun("run_1", {
					status: "completed",
					finishedAt: Date.now(),
					durationMs: 42,
				});
				const fetched = store.getRun("run_1");
				expect(fetched?.status).toBe("completed");
				expect(fetched?.durationMs).toBe(42);
			});

			it("should update run error", () => {
				store.saveRun(makeRun("run_1"));
				store.updateRun("run_1", {
					status: "failed",
					error: { message: "boom", stack: "stack trace" },
				});
				const fetched = store.getRun("run_1");
				expect(fetched?.status).toBe("failed");
				expect(fetched?.error?.message).toBe("boom");
			});

			it("should update run tags", () => {
				store.saveRun(makeRun("run_1", { tags: ["a"] }));
				store.updateRun("run_1", { tags: ["a", "b", "c"] });
				const fetched = store.getRun("run_1");
				expect(fetched?.tags).toEqual(["a", "b", "c"]);
			});

			it("should update completedNodes", () => {
				store.saveRun(makeRun("run_1"));
				store.updateRun("run_1", { completedNodes: 2 });
				const fetched = store.getRun("run_1");
				expect(fetched?.completedNodes).toBe(2);
			});
		});

		// === Run Queries ===

		describe("getRuns", () => {
			it("should list all runs", () => {
				store.saveRun(makeRun("run_1"));
				store.saveRun(makeRun("run_2"));
				const { runs, total } = store.getRuns();
				expect(total).toBe(2);
				expect(runs).toHaveLength(2);
			});

			it("should filter by workflow", () => {
				store.saveRun(makeRun("run_1", { workflowName: "alpha" }));
				store.saveRun(makeRun("run_2", { workflowName: "beta" }));
				store.saveRun(makeRun("run_3", { workflowName: "alpha" }));

				const { runs, total } = store.getRuns({ workflow: "alpha" });
				expect(total).toBe(2);
				expect(runs.every((r) => r.workflowName === "alpha")).toBe(true);
			});

			it("should filter by status", () => {
				store.saveRun(makeRun("run_1", { status: "completed" }));
				store.saveRun(makeRun("run_2", { status: "running" }));
				store.saveRun(makeRun("run_3", { status: "failed" }));

				const { runs } = store.getRuns({ status: "completed" });
				expect(runs).toHaveLength(1);
				expect(runs[0].id).toBe("run_1");
			});

			it("should paginate", () => {
				for (let i = 0; i < 10; i++) {
					store.saveRun(makeRun(`run_${i}`, { startedAt: Date.now() + i }));
				}
				const { runs, total } = store.getRuns({ limit: 3, offset: 0 });
				expect(total).toBe(10);
				expect(runs).toHaveLength(3);
			});

			it("should sort ascending", () => {
				store.saveRun(makeRun("run_old", { startedAt: 1000, workflowName: "first" }));
				store.saveRun(makeRun("run_new", { startedAt: 2000, workflowName: "second" }));

				const { runs } = store.getRuns({ sort: "asc" });
				expect(runs[0].workflowName).toBe("first");
			});

			it("should sort descending by default", () => {
				store.saveRun(makeRun("run_old", { startedAt: 1000, workflowName: "first" }));
				store.saveRun(makeRun("run_new", { startedAt: 2000, workflowName: "second" }));

				const { runs } = store.getRuns();
				expect(runs[0].workflowName).toBe("second");
			});

			it("should filter by tags", () => {
				store.saveRun(makeRun("run_1", { tags: ["env:prod", "region:us"] }));
				store.saveRun(makeRun("run_2", { tags: ["env:dev"] }));
				store.saveRun(makeRun("run_3", { tags: ["env:prod", "region:eu"] }));

				const { runs } = store.getRuns({ tags: ["env:prod"] });
				expect(runs).toHaveLength(2);
			});
		});

		// === Node Runs ===

		describe("node runs", () => {
			it("should save and list node runs", () => {
				store.saveRun(makeRun("run_1"));
				store.saveNodeRun(makeNodeRun("node_1", "run_1", { nodeName: "a", stepIndex: 0 }));
				store.saveNodeRun(makeNodeRun("node_2", "run_1", { nodeName: "b", stepIndex: 1 }));

				const nodes = store.getNodeRuns("run_1");
				expect(nodes).toHaveLength(2);
			});

			it("should get single node run", () => {
				store.saveRun(makeRun("run_1"));
				store.saveNodeRun(makeNodeRun("node_1", "run_1"));

				const node = store.getNodeRun("node_1");
				expect(node).toBeDefined();
				expect(node?.nodeName).toBe("node-1");
			});

			it("should update node run", () => {
				store.saveRun(makeRun("run_1"));
				store.saveNodeRun(makeNodeRun("node_1", "run_1"));

				store.updateNodeRun("node_1", {
					status: "completed",
					finishedAt: Date.now(),
					durationMs: 15,
					outputs: { result: "ok" },
				});

				const node = store.getNodeRun("node_1");
				expect(node?.status).toBe("completed");
				expect(node?.durationMs).toBe(15);
				expect(node?.outputs).toEqual({ result: "ok" });
			});

			it("should update node error", () => {
				store.saveRun(makeRun("run_1"));
				store.saveNodeRun(makeNodeRun("node_1", "run_1"));

				store.updateNodeRun("node_1", {
					status: "failed",
					error: { message: "node error" },
				});

				const node = store.getNodeRun("node_1");
				expect(node?.status).toBe("failed");
				expect(node?.error?.message).toBe("node error");
			});

			it("should return empty array for unknown run", () => {
				expect(store.getNodeRuns("nonexistent")).toEqual([]);
			});

			it("should return undefined for unknown node", () => {
				expect(store.getNodeRun("nonexistent")).toBeUndefined();
			});
		});

		// === Events ===

		describe("events", () => {
			it("should save and retrieve events", () => {
				store.saveRun(makeRun("run_1"));
				store.saveEvent(makeEvent("evt_1", "run_1", { timestamp: 1000 }));
				store.saveEvent(makeEvent("evt_2", "run_1", { timestamp: 2000 }));

				const events = store.getEvents("run_1");
				expect(events).toHaveLength(2);
			});

			it("should filter events by since", () => {
				store.saveRun(makeRun("run_1"));
				store.saveEvent(makeEvent("evt_1", "run_1", { timestamp: 1000 }));
				store.saveEvent(makeEvent("evt_2", "run_1", { timestamp: 2000 }));
				store.saveEvent(makeEvent("evt_3", "run_1", { timestamp: 3000 }));

				const events = store.getEvents("run_1", 1500);
				expect(events).toHaveLength(2);
				expect(events[0].id).toBe("evt_2");
			});

			it("should return empty array for unknown run", () => {
				expect(store.getEvents("nonexistent")).toEqual([]);
			});
		});

		// === Logs ===

		describe("logs", () => {
			it("should save and retrieve logs", () => {
				store.saveRun(makeRun("run_1"));
				store.saveLog(makeLog("log_1", "run_1", { message: "hello" }));
				store.saveLog(makeLog("log_2", "run_1", { message: "world" }));

				const logs = store.getLogs("run_1");
				expect(logs).toHaveLength(2);
			});

			it("should filter logs by nodeId", () => {
				store.saveRun(makeRun("run_1"));
				store.saveLog(makeLog("log_1", "run_1", { nodeId: "n1", message: "a" }));
				store.saveLog(makeLog("log_2", "run_1", { nodeId: "n2", message: "b" }));

				const logs = store.getLogs("run_1", "n1");
				expect(logs).toHaveLength(1);
				expect(logs[0].message).toBe("a");
			});

			it("should return empty array for unknown run", () => {
				expect(store.getLogs("nonexistent")).toEqual([]);
			});
		});

		// === Aggregations ===

		describe("getWorkflowSummaries", () => {
			it("should aggregate by workflow", () => {
				store.saveRun(makeRun("run_1", { workflowName: "api", status: "completed", durationMs: 10 }));
				store.saveRun(makeRun("run_2", { workflowName: "api", status: "failed", durationMs: 20 }));
				store.saveRun(makeRun("run_3", { workflowName: "cron", status: "completed", durationMs: 5 }));

				const summaries = store.getWorkflowSummaries();
				expect(summaries).toHaveLength(2);

				const api = summaries.find((s) => s.name === "api");
				expect(api?.totalRuns).toBe(2);
				expect(api?.errorRate).toBe(0.5);
			});
		});

		describe("getAllTags", () => {
			it("should collect all unique tags", () => {
				store.saveRun(makeRun("run_1", { tags: ["a", "b"] }));
				store.saveRun(makeRun("run_2", { tags: ["b", "c"] }));

				const tags = store.getAllTags();
				expect(tags).toEqual(["a", "b", "c"]);
			});

			it("should return empty array when no tags", () => {
				store.saveRun(makeRun("run_1"));
				expect(store.getAllTags()).toEqual([]);
			});
		});

		describe("getActiveRunCount", () => {
			it("should count running runs", () => {
				store.saveRun(makeRun("run_1", { status: "running" }));
				store.saveRun(makeRun("run_2", { status: "completed" }));
				store.saveRun(makeRun("run_3", { status: "running" }));

				expect(store.getActiveRunCount()).toBe(2);
			});
		});

		describe("getMetrics", () => {
			it("should return basic metrics", () => {
				store.saveRun(makeRun("run_1", { status: "completed", durationMs: 10 }));
				store.saveRun(makeRun("run_2", { status: "failed", durationMs: 20 }));

				const metrics = store.getMetrics();
				expect(metrics.totalRuns).toBe(2);
				expect(metrics.completedRuns).toBe(1);
				expect(metrics.failedRuns).toBe(1);
				expect(metrics.avgDurationMs).toBe(15);
			});

			it("should filter by workflow", () => {
				store.saveRun(makeRun("run_1", { workflowName: "api", status: "completed" }));
				store.saveRun(makeRun("run_2", { workflowName: "cron", status: "completed" }));

				const metrics = store.getMetrics("api");
				expect(metrics.totalRuns).toBe(1);
			});

			it("should include node performance", () => {
				store.saveRun(makeRun("run_1"));
				store.saveNodeRun(
					makeNodeRun("node_1", "run_1", {
						nodeName: "fetch",
						status: "completed",
						durationMs: 25,
					}),
				);
				store.saveNodeRun(
					makeNodeRun("node_2", "run_1", {
						nodeName: "transform",
						status: "completed",
						durationMs: 5,
					}),
				);

				const metrics = store.getMetrics();
				expect(metrics.nodePerformance).toHaveLength(2);
				const fetchNode = metrics.nodePerformance.find((n) => n.nodeName === "fetch");
				expect(fetchNode?.avgDurationMs).toBe(25);
			});
		});

		// === Cleanup ===

		describe("clearAll", () => {
			it("should delete all data", () => {
				store.saveRun(makeRun("run_1"));
				store.saveRun(makeRun("run_2"));
				store.saveNodeRun(makeNodeRun("node_1", "run_1"));
				store.saveEvent(makeEvent("evt_1", "run_1"));
				store.saveLog(makeLog("log_1", "run_1"));

				const deleted = store.clearAll();
				expect(deleted).toBe(2);
				expect(store.getRuns().total).toBe(0);
			});
		});

		describe("deleteRunsBefore", () => {
			it("should delete old runs", () => {
				store.saveRun(makeRun("run_old", { startedAt: 1000, status: "completed" }));
				store.saveRun(makeRun("run_new", { startedAt: Date.now() }));

				const deleted = store.deleteRunsBefore(5000);
				expect(deleted).toBe(1);
				expect(store.getRun("run_old")).toBeUndefined();
				expect(store.getRun("run_new")).toBeDefined();
			});

			it("should not delete running runs", () => {
				store.saveRun(makeRun("run_1", { startedAt: 1000, status: "running" }));
				const deleted = store.deleteRunsBefore(Date.now());
				expect(deleted).toBe(0);
				expect(store.getRun("run_1")).toBeDefined();
			});
		});

		describe("evictOldRuns", () => {
			it("should evict oldest non-running runs", () => {
				store.saveRun(makeRun("run_1", { startedAt: 1000, status: "completed" }));
				store.saveRun(makeRun("run_2", { startedAt: 2000, status: "completed" }));
				store.saveRun(makeRun("run_3", { startedAt: 3000, status: "running" }));

				store.evictOldRuns(2);
				expect(store.getRun("run_1")).toBeUndefined();
				expect(store.getRun("run_2")).toBeDefined();
				expect(store.getRun("run_3")).toBeDefined();
			});

			it("should preserve running runs during eviction", () => {
				store.saveRun(makeRun("run_1", { startedAt: 1000, status: "running" }));
				store.saveRun(makeRun("run_2", { startedAt: 2000, status: "completed" }));
				store.saveRun(makeRun("run_3", { startedAt: 3000, status: "completed" }));

				store.evictOldRuns(1);
				// Running run should survive
				expect(store.getRun("run_1")).toBeDefined();
			});
		});
	});
}
