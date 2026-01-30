import { describe, it, expect, beforeEach } from "vitest";
import { RunTracker } from "../../tracing/RunTracker";
import type { StartRunOptions, StartNodeOptions, RunEvent } from "../../tracing/types";

function makeRunOpts(overrides?: Partial<StartRunOptions>): StartRunOptions {
	return {
		workflowName: "test-workflow",
		workflowPath: "/test",
		triggerType: "http",
		triggerSummary: "POST /api/test",
		nodeCount: 3,
		...overrides,
	};
}

function makeNodeOpts(overrides?: Partial<StartNodeOptions>): StartNodeOptions {
	return {
		nodeName: "node-1",
		nodeType: "module",
		depth: 0,
		stepIndex: 0,
		...overrides,
	};
}

describe("RunTracker", () => {
	let tracker: RunTracker;

	beforeEach(() => {
		RunTracker.resetInstance();
		tracker = new RunTracker(100);
	});

	// === Singleton ===

	describe("singleton", () => {
		it("should return the same instance", () => {
			const a = RunTracker.getInstance();
			const b = RunTracker.getInstance();
			expect(a).toBe(b);
		});

		it("should reset instance", () => {
			const a = RunTracker.getInstance();
			RunTracker.resetInstance();
			const b = RunTracker.getInstance();
			expect(a).not.toBe(b);
		});
	});

	// === Run Lifecycle ===

	describe("run lifecycle", () => {
		it("should start a run and assign an ID", () => {
			const run = tracker.startRun(makeRunOpts());
			expect(run.id).toMatch(/^run_/);
			expect(run.status).toBe("running");
			expect(run.workflowName).toBe("test-workflow");
			expect(run.nodeCount).toBe(3);
			expect(run.completedNodes).toBe(0);
		});

		it("should complete a run", () => {
			const run = tracker.startRun(makeRunOpts());
			tracker.completeRun(run.id, { result: "ok" });

			const fetched = tracker.getRun(run.id);
			expect(fetched?.status).toBe("completed");
			expect(fetched?.durationMs).toBeGreaterThanOrEqual(0);
			expect(fetched?.finishedAt).toBeDefined();
		});

		it("should fail a run", () => {
			const run = tracker.startRun(makeRunOpts());
			tracker.failRun(run.id, new Error("boom"));

			const fetched = tracker.getRun(run.id);
			expect(fetched?.status).toBe("failed");
			expect(fetched?.error?.message).toBe("boom");
		});

		it("should return undefined for unknown run ID", () => {
			expect(tracker.getRun("nonexistent")).toBeUndefined();
		});

		it("completeRun on unknown ID is a no-op", () => {
			expect(() => tracker.completeRun("nonexistent")).not.toThrow();
		});
	});

	// === Node Lifecycle ===

	describe("node lifecycle", () => {
		it("should start a node run", () => {
			const run = tracker.startRun(makeRunOpts());
			const node = tracker.startNode(run.id, makeNodeOpts());

			expect(node.id).toMatch(/^node_/);
			expect(node.status).toBe("running");
			expect(node.runId).toBe(run.id);
			expect(node.nodeName).toBe("node-1");
		});

		it("should complete a node run and increment completedNodes", () => {
			const run = tracker.startRun(makeRunOpts());
			const node = tracker.startNode(run.id, makeNodeOpts());
			tracker.completeNode(node.id, { data: "hello" });

			const fetched = tracker.getNodeRun(node.id);
			expect(fetched?.status).toBe("completed");
			expect(fetched?.outputs).toEqual({ data: "hello" });

			const updatedRun = tracker.getRun(run.id);
			expect(updatedRun?.completedNodes).toBe(1);
		});

		it("should fail a node run", () => {
			const run = tracker.startRun(makeRunOpts());
			const node = tracker.startNode(run.id, makeNodeOpts());
			tracker.failNode(node.id, new Error("node error"));

			const fetched = tracker.getNodeRun(node.id);
			expect(fetched?.status).toBe("failed");
			expect(fetched?.error?.message).toBe("node error");
		});

		it("should skip a node", () => {
			const run = tracker.startRun(makeRunOpts());
			tracker.skipNode(run.id, "skipped-node", 2, "inactive");

			const events = tracker.getEvents(run.id);
			const skipEvent = events.find((e) => e.type === "NODE_SKIPPED");
			expect(skipEvent).toBeDefined();
			expect(skipEvent?.nodeName).toBe("skipped-node");
		});

		it("should list node runs by run ID", () => {
			const run = tracker.startRun(makeRunOpts());
			tracker.startNode(run.id, makeNodeOpts({ nodeName: "a", stepIndex: 0 }));
			tracker.startNode(run.id, makeNodeOpts({ nodeName: "b", stepIndex: 1 }));

			const nodes = tracker.getNodeRuns(run.id);
			expect(nodes).toHaveLength(2);
			expect(nodes.map((n) => n.nodeName)).toEqual(["a", "b"]);
		});

		it("should return empty array for unknown run ID", () => {
			expect(tracker.getNodeRuns("nonexistent")).toEqual([]);
		});
	});

	// === Events ===

	describe("events", () => {
		it("should emit events for run lifecycle", () => {
			const captured: RunEvent[] = [];
			tracker.on("event", (e: RunEvent) => captured.push(e));

			const run = tracker.startRun(makeRunOpts());
			tracker.completeRun(run.id);

			const types = captured.map((e) => e.type);
			expect(types).toContain("RUN_STARTED");
			expect(types).toContain("RUN_COMPLETED");
		});

		it("should emit events for node lifecycle", () => {
			const captured: RunEvent[] = [];
			tracker.on("event", (e: RunEvent) => captured.push(e));

			const run = tracker.startRun(makeRunOpts());
			const node = tracker.startNode(run.id, makeNodeOpts());
			tracker.completeNode(node.id);

			const types = captured.map((e) => e.type);
			expect(types).toContain("NODE_STARTED");
			expect(types).toContain("NODE_COMPLETED");
		});

		it("should filter events by timestamp", () => {
			const run = tracker.startRun(makeRunOpts());
			const allEvents = tracker.getEvents(run.id);
			const startedAt = allEvents[0].timestamp;

			// Events since a future time should return nothing
			const future = tracker.getEvents(run.id, startedAt + 10000);
			expect(future).toHaveLength(0);
		});

		it("each event should have a unique ID", () => {
			const run = tracker.startRun(makeRunOpts());
			const node = tracker.startNode(run.id, makeNodeOpts());
			tracker.completeNode(node.id);
			tracker.completeRun(run.id);

			const events = tracker.getEvents(run.id);
			const ids = events.map((e) => e.id);
			expect(new Set(ids).size).toBe(ids.length);
		});
	});

	// === Logging ===

	describe("logging", () => {
		it("should add and retrieve log entries", () => {
			const run = tracker.startRun(makeRunOpts());
			tracker.addLog({ runId: run.id, level: "info", message: "hello" });
			tracker.addLog({ runId: run.id, level: "error", message: "boom" });

			const logs = tracker.getLogs(run.id);
			expect(logs).toHaveLength(2);
			expect(logs[0].message).toBe("hello");
			expect(logs[1].level).toBe("error");
		});

		it("should filter logs by nodeId", () => {
			const run = tracker.startRun(makeRunOpts());
			tracker.addLog({ runId: run.id, level: "info", message: "a", nodeId: "n1" });
			tracker.addLog({ runId: run.id, level: "info", message: "b", nodeId: "n2" });

			const filtered = tracker.getLogs(run.id, "n1");
			expect(filtered).toHaveLength(1);
			expect(filtered[0].message).toBe("a");
		});
	});

	// === Vars Tracking ===

	describe("vars tracking", () => {
		it("should emit VARS_UPDATED event", () => {
			const captured: RunEvent[] = [];
			tracker.on("event", (e: RunEvent) => captured.push(e));

			const run = tracker.startRun(makeRunOpts());
			tracker.trackVarsUpdate(run.id, "node-1", undefined, { foo: "bar" });

			const varsEvent = captured.find((e) => e.type === "VARS_UPDATED");
			expect(varsEvent).toBeDefined();
			expect(varsEvent?.nodeName).toBe("node-1");
		});
	});

	// === Queries ===

	describe("getRuns", () => {
		it("should list runs with pagination", () => {
			for (let i = 0; i < 5; i++) {
				tracker.startRun(makeRunOpts({ workflowName: `wf-${i}` }));
			}

			const { runs, total } = tracker.getRuns({ limit: 2, offset: 0 });
			expect(total).toBe(5);
			expect(runs).toHaveLength(2);
		});

		it("should filter by workflow name", () => {
			tracker.startRun(makeRunOpts({ workflowName: "alpha" }));
			tracker.startRun(makeRunOpts({ workflowName: "beta" }));
			tracker.startRun(makeRunOpts({ workflowName: "alpha" }));

			const { runs, total } = tracker.getRuns({ workflow: "alpha" });
			expect(total).toBe(2);
			expect(runs.every((r) => r.workflowName === "alpha")).toBe(true);
		});

		it("should filter by status", () => {
			const run1 = tracker.startRun(makeRunOpts());
			tracker.startRun(makeRunOpts());
			tracker.completeRun(run1.id);

			const { runs } = tracker.getRuns({ status: "completed" });
			expect(runs).toHaveLength(1);
			expect(runs[0].id).toBe(run1.id);
		});

		it("should sort ascending", () => {
			tracker.startRun(makeRunOpts({ workflowName: "first" }));
			tracker.startRun(makeRunOpts({ workflowName: "second" }));

			const { runs } = tracker.getRuns({ sort: "asc" });
			expect(runs[0].workflowName).toBe("first");
		});
	});

	// === Summaries ===

	describe("getWorkflowSummaries", () => {
		it("should aggregate workflow stats", () => {
			const run1 = tracker.startRun(makeRunOpts({ workflowName: "api" }));
			tracker.completeRun(run1.id);
			const run2 = tracker.startRun(makeRunOpts({ workflowName: "api" }));
			tracker.failRun(run2.id, new Error("fail"));

			const summaries = tracker.getWorkflowSummaries();
			expect(summaries).toHaveLength(1);

			const s = summaries[0];
			expect(s.name).toBe("api");
			expect(s.totalRuns).toBe(2);
			expect(s.errorRate).toBe(0.5);
			expect(s.avgDurationMs).toBeGreaterThanOrEqual(0);
		});

		it("should track multiple workflows separately", () => {
			tracker.startRun(makeRunOpts({ workflowName: "a" }));
			tracker.startRun(makeRunOpts({ workflowName: "b" }));

			const summaries = tracker.getWorkflowSummaries();
			expect(summaries).toHaveLength(2);
		});
	});

	// === Eviction ===

	describe("eviction", () => {
		it("should evict old runs when maxRuns exceeded", () => {
			const smallTracker = new RunTracker(3);

			const firstRun = smallTracker.startRun(makeRunOpts({ workflowName: "old" }));
			smallTracker.completeRun(firstRun.id);

			for (let i = 0; i < 3; i++) {
				smallTracker.startRun(makeRunOpts({ workflowName: `new-${i}` }));
			}

			// The first completed run should have been evicted
			expect(smallTracker.getRun(firstRun.id)).toBeUndefined();
		});

		it("should not evict running runs", () => {
			const smallTracker = new RunTracker(2);
			const running = smallTracker.startRun(makeRunOpts({ workflowName: "running" }));

			for (let i = 0; i < 3; i++) {
				const r = smallTracker.startRun(makeRunOpts({ workflowName: `other-${i}` }));
				smallTracker.completeRun(r.id);
			}

			// The running one should survive eviction
			expect(smallTracker.getRun(running.id)).toBeDefined();
		});
	});

	// === Utility ===

	describe("utility", () => {
		it("should count active runs", () => {
			tracker.startRun(makeRunOpts());
			const run2 = tracker.startRun(makeRunOpts());
			tracker.completeRun(run2.id);

			expect(tracker.getActiveRunCount()).toBe(1);
		});

		it("should clear all data", () => {
			tracker.startRun(makeRunOpts());
			tracker.startRun(makeRunOpts());

			const deleted = tracker.clearAll();
			expect(deleted).toBe(2);
			expect(tracker.getRuns().total).toBe(0);
		});

		it("active should be true by default", () => {
			expect(tracker.active).toBe(true);
		});
	});
});
