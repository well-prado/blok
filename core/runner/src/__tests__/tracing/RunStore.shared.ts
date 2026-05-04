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
	});
}
