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

			// Tier 2 quick-wins — metadata filter tests
			it("should filter by single metadata key=value", () => {
				store.saveRun(makeRun("run_1", { metadata: { tier: "premium", region: "us" } }));
				store.saveRun(makeRun("run_2", { metadata: { tier: "free" } }));
				store.saveRun(makeRun("run_3", { metadata: { tier: "premium", region: "eu" } }));

				const { runs } = store.getRuns({ metadata: { tier: "premium" } });
				expect(runs).toHaveLength(2);
			});

			it("should filter by multiple metadata keys (AND semantics)", () => {
				store.saveRun(makeRun("run_1", { metadata: { tier: "premium", region: "us" } }));
				store.saveRun(makeRun("run_2", { metadata: { tier: "premium", region: "eu" } }));
				store.saveRun(makeRun("run_3", { metadata: { tier: "free", region: "us" } }));

				const { runs } = store.getRuns({ metadata: { tier: "premium", region: "us" } });
				expect(runs).toHaveLength(1);
				expect(runs[0].id).toBe("run_1");
			});

			it("should return empty when metadata key doesn't exist", () => {
				store.saveRun(makeRun("run_1", { metadata: { tier: "premium" } }));
				const { runs } = store.getRuns({ metadata: { tier: "enterprise" } });
				expect(runs).toHaveLength(0);
			});

			it("metadata filter combines with status + tags", () => {
				store.saveRun(
					makeRun("run_1", {
						status: "completed",
						tags: ["env:prod"],
						metadata: { tier: "premium" },
					}),
				);
				store.saveRun(
					makeRun("run_2", {
						status: "running",
						tags: ["env:prod"],
						metadata: { tier: "premium" },
					}),
				);
				store.saveRun(
					makeRun("run_3", {
						status: "completed",
						tags: ["env:dev"],
						metadata: { tier: "premium" },
					}),
				);

				const { runs } = store.getRuns({
					status: "completed",
					tags: ["env:prod"],
					metadata: { tier: "premium" },
				});
				expect(runs).toHaveLength(1);
				expect(runs[0].id).toBe("run_1");
			});

			// F2 (v0.5) — operator-aware metadata filters
			describe("metadata operators (F2)", () => {
				it("ne — not equal (and matches runs with the key absent)", () => {
					store.saveRun(makeRun("run_1", { metadata: { tier: "premium" } }));
					store.saveRun(makeRun("run_2", { metadata: { tier: "free" } }));
					store.saveRun(makeRun("run_3", { metadata: { other: "x" } })); // tier absent — `ne` matches
					const { runs } = store.getRuns({
						metadata: [{ key: "tier", op: "ne", value: "free" }],
					});
					expect(runs.map((r) => r.id).sort()).toEqual(["run_1", "run_3"]);
				});

				it("gt / gte / lt / lte — numeric comparisons against JSON-stored numbers", () => {
					store.saveRun(makeRun("run_1", { metadata: { count: "5" } }));
					store.saveRun(makeRun("run_2", { metadata: { count: "10" } }));
					store.saveRun(makeRun("run_3", { metadata: { count: "20" } }));

					expect(store.getRuns({ metadata: [{ key: "count", op: "gt", value: "10" }] }).runs.map((r) => r.id)).toEqual([
						"run_3",
					]);
					expect(
						store
							.getRuns({ metadata: [{ key: "count", op: "gte", value: "10" }] })
							.runs.map((r) => r.id)
							.sort(),
					).toEqual(["run_2", "run_3"]);
					expect(store.getRuns({ metadata: [{ key: "count", op: "lt", value: "10" }] }).runs.map((r) => r.id)).toEqual([
						"run_1",
					]);
					expect(
						store
							.getRuns({ metadata: [{ key: "count", op: "lte", value: "10" }] })
							.runs.map((r) => r.id)
							.sort(),
					).toEqual(["run_1", "run_2"]);
				});

				it("in / nin — set membership", () => {
					store.saveRun(makeRun("run_1", { metadata: { region: "us" } }));
					store.saveRun(makeRun("run_2", { metadata: { region: "eu" } }));
					store.saveRun(makeRun("run_3", { metadata: { region: "ap" } }));
					store.saveRun(makeRun("run_4", { metadata: { other: "x" } })); // region absent

					const inResult = store.getRuns({
						metadata: [{ key: "region", op: "in", value: ["us", "eu"] }],
					}).runs;
					expect(inResult.map((r) => r.id).sort()).toEqual(["run_1", "run_2"]);

					// `nin` parallels `ne` — absent keys satisfy the filter.
					const ninResult = store.getRuns({
						metadata: [{ key: "region", op: "nin", value: ["us", "eu"] }],
					}).runs;
					expect(ninResult.map((r) => r.id).sort()).toEqual(["run_3", "run_4"]);
				});

				it("like — SQL-style pattern with % and _ wildcards", () => {
					store.saveRun(makeRun("run_1", { metadata: { name: "test-alpha" } }));
					store.saveRun(makeRun("run_2", { metadata: { name: "test-beta" } }));
					store.saveRun(makeRun("run_3", { metadata: { name: "prod-alpha" } }));

					const result = store.getRuns({
						metadata: [{ key: "name", op: "like", value: "test-%" }],
					}).runs;
					expect(result.map((r) => r.id).sort()).toEqual(["run_1", "run_2"]);
				});

				it("multiple operator filters combine with AND", () => {
					store.saveRun(makeRun("run_1", { metadata: { tier: "premium", count: "5" } }));
					store.saveRun(makeRun("run_2", { metadata: { tier: "premium", count: "20" } }));
					store.saveRun(makeRun("run_3", { metadata: { tier: "free", count: "20" } }));

					const result = store.getRuns({
						metadata: [
							{ key: "tier", op: "eq", value: "premium" },
							{ key: "count", op: "gt", value: "10" },
						],
					}).runs;
					expect(result.map((r) => r.id)).toEqual(["run_2"]);
				});

				it("back-compat — Record<string, string> still works and is equivalent to `op: 'eq'`", () => {
					store.saveRun(makeRun("run_1", { metadata: { tier: "premium" } }));
					store.saveRun(makeRun("run_2", { metadata: { tier: "free" } }));

					const legacyResult = store.getRuns({ metadata: { tier: "premium" } }).runs;
					const operatorResult = store.getRuns({
						metadata: [{ key: "tier", op: "eq", value: "premium" }],
					}).runs;
					expect(legacyResult.map((r) => r.id)).toEqual(operatorResult.map((r) => r.id));
				});

				it("invalid keys silently drop (JSON-path injection guard)", () => {
					store.saveRun(makeRun("run_1", { metadata: { tier: "premium" } }));
					// Key with single-quote — would break JSON-path syntax.
					const result = store.getRuns({
						metadata: [{ key: "tier'; DROP TABLE", op: "eq", value: "premium" }],
					}).runs;
					// Invalid key dropped → no metadata filter → all rows returned.
					expect(result).toHaveLength(1);
				});
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

			// G2 follow-up (v0.6) — Studio rail badges (↳ async, ↳ sub,
			// http, mw:<name>, iteration headers) need these flag fields
			// to survive round-trip; pre-fix they rode only on the
			// in-memory NodeRun and vanished on persistent reads.
			it("round-trips wait + dispatch + subworkflowDepth + middleware + iterationIndex (Studio rail flags)", () => {
				store.saveRun(makeRun("run_1"));
				store.saveNodeRun(
					makeNodeRun("node_flags", "run_1", {
						nodeType: "subworkflow",
						wait: false,
						dispatch: "http-self",
						subworkflowDepth: 2,
						middleware: "auth-check",
						iterationIndex: 3,
					}),
				);

				const got = store.getNodeRun("node_flags");
				expect(got?.wait).toBe(false);
				expect(got?.dispatch).toBe("http-self");
				expect(got?.subworkflowDepth).toBe(2);
				expect(got?.middleware).toBe("auth-check");
				expect(got?.iterationIndex).toBe(3);
			});

			it("leaves rail flags undefined when not set on the in-memory NodeRun", () => {
				store.saveRun(makeRun("run_1"));
				store.saveNodeRun(makeNodeRun("node_plain", "run_1"));

				const got = store.getNodeRun("node_plain");
				expect(got?.wait).toBeUndefined();
				expect(got?.dispatch).toBeUndefined();
				expect(got?.subworkflowDepth).toBeUndefined();
				expect(got?.middleware).toBeUndefined();
				expect(got?.iterationIndex).toBeUndefined();
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

		// === Concurrency gating (Tier 2 #6) ===

		describe("concurrency gating", () => {
			const FAR_FUTURE = Date.now() + 60 * 60 * 1000;

			it("grants slots up to the limit", () => {
				const a = store.acquireConcurrencySlot("wf", "tenant-x", 2, "run_1", FAR_FUTURE);
				expect(a.acquired).toBe(true);
				expect(a.currentInFlight).toBe(1);

				const b = store.acquireConcurrencySlot("wf", "tenant-x", 2, "run_2", FAR_FUTURE);
				expect(b.acquired).toBe(true);
				expect(b.currentInFlight).toBe(2);
			});

			it("denies the next acquire once the limit is hit", () => {
				store.acquireConcurrencySlot("wf", "tenant-x", 2, "run_1", FAR_FUTURE);
				store.acquireConcurrencySlot("wf", "tenant-x", 2, "run_2", FAR_FUTURE);
				const denied = store.acquireConcurrencySlot("wf", "tenant-x", 2, "run_3", FAR_FUTURE);
				expect(denied.acquired).toBe(false);
				expect(denied.currentInFlight).toBe(2);
			});

			it("releases slots so the next acquire succeeds", () => {
				store.acquireConcurrencySlot("wf", "tenant-x", 1, "run_1", FAR_FUTURE);
				store.releaseConcurrencySlot("wf", "tenant-x", "run_1");
				const next = store.acquireConcurrencySlot("wf", "tenant-x", 1, "run_2", FAR_FUTURE);
				expect(next.acquired).toBe(true);
				expect(next.currentInFlight).toBe(1);
			});

			it("releasing an unknown runId is a no-op", () => {
				store.acquireConcurrencySlot("wf", "tenant-x", 1, "run_1", FAR_FUTURE);
				expect(() => store.releaseConcurrencySlot("wf", "tenant-x", "run_unknown")).not.toThrow();
				const denied = store.acquireConcurrencySlot("wf", "tenant-x", 1, "run_2", FAR_FUTURE);
				expect(denied.acquired).toBe(false);
			});

			it("re-acquiring with the same runId refreshes the lease without growing the count", () => {
				store.acquireConcurrencySlot("wf", "tenant-x", 1, "run_1", FAR_FUTURE);
				const reacquire = store.acquireConcurrencySlot("wf", "tenant-x", 1, "run_1", FAR_FUTURE + 1000);
				expect(reacquire.acquired).toBe(true);
				expect(reacquire.currentInFlight).toBe(1);
			});

			it("isolates buckets across workflows", () => {
				store.acquireConcurrencySlot("wf-A", "k", 1, "run_a", FAR_FUTURE);
				const b = store.acquireConcurrencySlot("wf-B", "k", 1, "run_b", FAR_FUTURE);
				expect(b.acquired).toBe(true);
			});

			it("isolates buckets across keys", () => {
				store.acquireConcurrencySlot("wf", "key-A", 1, "run_a", FAR_FUTURE);
				const b = store.acquireConcurrencySlot("wf", "key-B", 1, "run_b", FAR_FUTURE);
				expect(b.acquired).toBe(true);
			});

			it("lazy-purges expired leases on the next acquire to the same bucket", () => {
				const past = Date.now() - 1000;
				store.acquireConcurrencySlot("wf", "tenant-x", 1, "run_dead", past);

				// New acquire on the same bucket sees the expired lease and reclaims its slot.
				const fresh = store.acquireConcurrencySlot("wf", "tenant-x", 1, "run_alive", FAR_FUTURE);
				expect(fresh.acquired).toBe(true);
				expect(fresh.currentInFlight).toBe(1);
			});

			it("purgeExpiredConcurrencySlots removes only expired entries", () => {
				// Use distinct buckets so the per-bucket lazy-purge inside
				// `acquireConcurrencySlot` doesn't preempt our global purge.
				const past = Date.now() - 1000;
				store.acquireConcurrencySlot("wf", "bucket-dead", 5, "run_dead", past);
				store.acquireConcurrencySlot("wf", "bucket-alive", 5, "run_alive", FAR_FUTURE);

				const removed = store.purgeExpiredConcurrencySlots(Date.now());
				expect(removed).toBe(1);

				// The alive bucket is untouched: a new acquire there sees the
				// existing slot and currentInFlight grows to 2.
				const next = store.acquireConcurrencySlot("wf", "bucket-alive", 5, "run_new", FAR_FUTURE);
				expect(next.acquired).toBe(true);
				expect(next.currentInFlight).toBe(2);
			});

			it("clearAll removes all concurrency locks", () => {
				store.acquireConcurrencySlot("wf", "k", 1, "run_1", FAR_FUTURE);
				store.clearAll();
				const fresh = store.acquireConcurrencySlot("wf", "k", 1, "run_2", FAR_FUTURE);
				expect(fresh.acquired).toBe(true);
				expect(fresh.currentInFlight).toBe(1);
			});

			it("respects concurrencyLimit changes between acquires (snapshot semantics)", () => {
				// Simulate a config change mid-run: first acquire with limit 5,
				// then attempt with limit 1. The second sees 1 in-flight (>=
				// limit 1) and is denied.
				store.acquireConcurrencySlot("wf", "k", 5, "run_1", FAR_FUTURE);
				const denied = store.acquireConcurrencySlot("wf", "k", 1, "run_2", FAR_FUTURE);
				expect(denied.acquired).toBe(false);
				expect(denied.currentInFlight).toBe(1);
			});
		});

		// === Durable scheduling (Tier 2 #5+#7 follow-up) ===

		describe("scheduled dispatches", () => {
			it("upsertScheduledDispatch persists a row and getScheduledDispatches returns it", () => {
				const now = Date.now();
				store.upsertScheduledDispatch({
					runId: "run_1",
					workflowName: "send-welcome",
					triggerType: "http",
					scheduledAt: now + 60_000,
					expiresAt: now + 120_000,
					dispatchStatus: "delayed",
					payload: { method: "POST", path: "/welcome", body: { email: "u@x.com" } },
					createdAt: now,
				});
				const rows = store.getScheduledDispatches();
				expect(rows.length).toBe(1);
				expect(rows[0].runId).toBe("run_1");
				expect(rows[0].dispatchStatus).toBe("delayed");
				expect((rows[0].payload as { body: { email: string } }).body.email).toBe("u@x.com");
			});

			it("upsertScheduledDispatch with same runId replaces the row (re-defer)", () => {
				const now = Date.now();
				store.upsertScheduledDispatch({
					runId: "run_1",
					workflowName: "wf",
					triggerType: "http",
					scheduledAt: now + 1000,
					dispatchStatus: "queued",
					payload: { v: 1 },
					createdAt: now,
				});
				store.upsertScheduledDispatch({
					runId: "run_1",
					workflowName: "wf",
					triggerType: "http",
					scheduledAt: now + 5000,
					dispatchStatus: "queued",
					payload: { v: 2 },
					createdAt: now,
				});
				const rows = store.getScheduledDispatches();
				expect(rows.length).toBe(1);
				expect(rows[0].scheduledAt).toBe(now + 5000);
				expect((rows[0].payload as { v: number }).v).toBe(2);
			});

			it("deleteScheduledDispatch removes the row and is idempotent", () => {
				const now = Date.now();
				store.upsertScheduledDispatch({
					runId: "run_1",
					workflowName: "wf",
					triggerType: "http",
					scheduledAt: now,
					dispatchStatus: "delayed",
					payload: null,
					createdAt: now,
				});
				expect(store.deleteScheduledDispatch("run_1")).toBe(true);
				expect(store.deleteScheduledDispatch("run_1")).toBe(false);
				expect(store.getScheduledDispatches().length).toBe(0);
			});

			it("purgeExpiredScheduledDispatches deletes rows whose expires_at < now; leaves untimed rows untouched", () => {
				const past = Date.now() - 1000;
				const future = Date.now() + 60_000;

				store.upsertScheduledDispatch({
					runId: "expired",
					workflowName: "wf",
					triggerType: "http",
					scheduledAt: past,
					expiresAt: past,
					dispatchStatus: "delayed",
					payload: null,
					createdAt: past,
				});
				store.upsertScheduledDispatch({
					runId: "still_alive",
					workflowName: "wf",
					triggerType: "http",
					scheduledAt: future,
					expiresAt: future,
					dispatchStatus: "delayed",
					payload: null,
					createdAt: Date.now(),
				});
				store.upsertScheduledDispatch({
					runId: "untimed",
					workflowName: "wf",
					triggerType: "http",
					scheduledAt: future,
					dispatchStatus: "delayed",
					payload: null,
					createdAt: Date.now(),
				});

				const purged = store.purgeExpiredScheduledDispatches(Date.now());
				expect(purged).toBe(1);

				const remaining = store.getScheduledDispatches().map((r) => r.runId);
				expect(remaining.sort()).toEqual(["still_alive", "untimed"]);
			});

			it("getScheduledDispatches filters by triggerType + status; returns rows sorted by scheduledAt ASC", () => {
				const now = Date.now();
				store.upsertScheduledDispatch({
					runId: "h_q",
					workflowName: "wf",
					triggerType: "http",
					scheduledAt: now + 5000,
					dispatchStatus: "queued",
					payload: null,
					createdAt: now,
				});
				store.upsertScheduledDispatch({
					runId: "h_d",
					workflowName: "wf",
					triggerType: "http",
					scheduledAt: now + 1000,
					dispatchStatus: "delayed",
					payload: null,
					createdAt: now,
				});
				store.upsertScheduledDispatch({
					runId: "w_d",
					workflowName: "wf",
					triggerType: "worker",
					scheduledAt: now + 1000,
					dispatchStatus: "delayed",
					payload: null,
					createdAt: now,
				});
				expect(store.getScheduledDispatches().length).toBe(3);
				expect(store.getScheduledDispatches({ triggerType: "http" }).length).toBe(2);
				expect(store.getScheduledDispatches({ status: "queued" }).length).toBe(1);
				const httpRows = store.getScheduledDispatches({ triggerType: "http" });
				expect(httpRows[0].runId).toBe("h_d");
				expect(httpRows[1].runId).toBe("h_q");
			});
		});

		// E2 · saved filters. UNIQUE(name) constraint → upsert semantics
		// must preserve id + createdAt on overwrite, bump updatedAt, and
		// match exactly across all backends so the cross-browser behaviour
		// is identical regardless of which store backs the deployment.
		describe("saved filters (E2)", () => {
			function sampleFilter(
				name: string,
				status = "running",
			): {
				id: string;
				name: string;
				status: string;
				tagsInput: string;
				metadataInput: string;
				createdAt: number;
				updatedAt: number;
			} {
				const now = Date.now();
				return {
					id: `sf_${now}_${name}`,
					name,
					status,
					tagsInput: "",
					metadataInput: "",
					createdAt: now,
					updatedAt: now,
				};
			}

			it("listSavedFilters returns an empty array on a fresh store", () => {
				expect(store.listSavedFilters()).toEqual([]);
			});

			it("upsertSavedFilter persists and the listing surfaces the row", () => {
				const filter = sampleFilter("premium");
				const persisted = store.upsertSavedFilter(filter);
				expect(persisted.name).toBe("premium");
				const list = store.listSavedFilters();
				expect(list).toHaveLength(1);
				expect(list[0]?.name).toBe("premium");
			});

			it("re-upserting an existing name OVERWRITES the row in place (preserves id + createdAt)", () => {
				const original = sampleFilter("premium", "running");
				const first = store.upsertSavedFilter(original);
				const updated = {
					...original,
					id: "sf_NEW_THROWAWAY_ID", // server-side should ignore this on conflict
					status: "failed",
					updatedAt: original.updatedAt + 1000,
				};
				const second = store.upsertSavedFilter(updated);
				expect(second.id).toBe(first.id);
				expect(second.createdAt).toBe(first.createdAt);
				expect(second.updatedAt).toBe(original.updatedAt + 1000);
				expect(second.status).toBe("failed");
				const list = store.listSavedFilters();
				expect(list).toHaveLength(1);
				expect(list[0]?.status).toBe("failed");
			});

			it("listSavedFilters sorts by updatedAt DESC (most recently changed first)", () => {
				const base = Date.now();
				store.upsertSavedFilter({ ...sampleFilter("a"), updatedAt: base });
				store.upsertSavedFilter({ ...sampleFilter("b"), updatedAt: base + 1000 });
				store.upsertSavedFilter({ ...sampleFilter("c"), updatedAt: base + 500 });
				const list = store.listSavedFilters();
				expect(list.map((f) => f.name)).toEqual(["b", "c", "a"]);
			});

			it("deleteSavedFilter by name removes the row and returns true", () => {
				store.upsertSavedFilter(sampleFilter("premium"));
				expect(store.deleteSavedFilter("premium")).toBe(true);
				expect(store.listSavedFilters()).toHaveLength(0);
			});

			it("deleteSavedFilter returns false when the name doesn't exist", () => {
				expect(store.deleteSavedFilter("nonexistent")).toBe(false);
			});
		});

		// Sample-body recording (option C follow-up to #100). First-
		// record-wins semantic — each workflow has at most one row,
		// captured on its first successful run. Re-recording is a no-op
		// so the operator-visible curl example stays stable.
		describe("workflow samples (option C)", () => {
			function sampleAt(
				name: string,
				body: unknown,
				recordedAt = Date.now(),
			): {
				workflowName: string;
				body: unknown;
				sourceRunId: string;
				recordedAt: number;
			} {
				return { workflowName: name, body, sourceRunId: `run_${recordedAt}`, recordedAt };
			}

			it("getWorkflowSample returns undefined for a workflow with no recording", () => {
				expect(store.getWorkflowSample("never-run")).toBeUndefined();
			});

			it("recordWorkflowSample persists the body + source run id", () => {
				const body = { event: { id: "evt_1" }, count: 3 };
				const persisted = store.recordWorkflowSample(sampleAt("orders", body, 1000));
				expect(persisted.workflowName).toBe("orders");
				expect(persisted.body).toEqual(body);
				expect(persisted.sourceRunId).toBe("run_1000");
				expect(store.getWorkflowSample("orders")?.body).toEqual(body);
			});

			it("re-recording the SAME workflow is a no-op (first-record-wins)", () => {
				const first = store.recordWorkflowSample(sampleAt("orders", { v: 1 }, 1000));
				const second = store.recordWorkflowSample(sampleAt("orders", { v: 2 }, 2000));
				// The second recordWorkflowSample returns the EXISTING
				// row, not the new one. The stored body is still v:1.
				expect(second.body).toEqual({ v: 1 });
				expect(second.recordedAt).toBe(first.recordedAt);
				expect(store.getWorkflowSample("orders")?.body).toEqual({ v: 1 });
			});

			it("different workflows record independently", () => {
				store.recordWorkflowSample(sampleAt("orders", { o: 1 }, 1000));
				store.recordWorkflowSample(sampleAt("users", { u: 1 }, 1001));
				expect(store.getWorkflowSample("orders")?.body).toEqual({ o: 1 });
				expect(store.getWorkflowSample("users")?.body).toEqual({ u: 1 });
			});

			it("deleteWorkflowSample removes the row and returns true", () => {
				store.recordWorkflowSample(sampleAt("orders", { o: 1 }, 1000));
				expect(store.deleteWorkflowSample("orders")).toBe(true);
				expect(store.getWorkflowSample("orders")).toBeUndefined();
			});

			it("deleteWorkflowSample returns false when no row exists", () => {
				expect(store.deleteWorkflowSample("nothing-to-delete")).toBe(false);
			});

			it("after delete, re-recording captures a NEW body (escape hatch path)", () => {
				store.recordWorkflowSample(sampleAt("orders", { v: 1 }, 1000));
				store.deleteWorkflowSample("orders");
				const reRecord = store.recordWorkflowSample(sampleAt("orders", { v: 2 }, 2000));
				expect(reRecord.body).toEqual({ v: 2 });
			});

			it("records non-primitive bodies (arrays, nested objects) verbatim", () => {
				const body = {
					event: { type: "order.created", payload: { items: [{ sku: "A", qty: 2 }] } },
					meta: { ip: "127.0.0.1" },
				};
				store.recordWorkflowSample(sampleAt("complex", body, 1000));
				expect(store.getWorkflowSample("complex")?.body).toEqual(body);
			});
		});
	});
}
