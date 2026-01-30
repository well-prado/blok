import { EventEmitter } from "events";
import { v4 as uuid } from "uuid";
import type {
	NodeRun,
	RunEvent,
	RunEventType,
	StartNodeOptions,
	StartRunOptions,
	TraceLogEntry,
	WorkflowRun,
	WorkflowRunStatus,
	WorkflowSummary,
} from "./types";

export class RunTracker extends EventEmitter {
	private runs: Map<string, WorkflowRun> = new Map();
	private nodeRuns: Map<string, NodeRun[]> = new Map(); // runId → NodeRun[]
	private nodeRunIndex: Map<string, NodeRun> = new Map(); // nodeRunId → NodeRun
	private events: Map<string, RunEvent[]> = new Map(); // runId → RunEvent[]
	private logs: Map<string, TraceLogEntry[]> = new Map(); // runId → LogEntry[]
	private maxRuns: number;
	private enabled: boolean;

	private static instance: RunTracker | null = null;

	constructor(maxRuns?: number) {
		super();
		this.setMaxListeners(100);
		this.maxRuns = maxRuns ?? Number.parseInt(process.env.BLOK_TRACE_MAX_RUNS || "1000", 10);
		this.enabled = process.env.BLOK_TRACE_ENABLED !== "false";
	}

	static getInstance(): RunTracker {
		if (!RunTracker.instance) {
			RunTracker.instance = new RunTracker();
		}
		return RunTracker.instance;
	}

	static resetInstance(): void {
		RunTracker.instance = null;
	}

	/** Fast path: skip all work when tracing is disabled or no listeners */
	get active(): boolean {
		return this.enabled;
	}

	// === Workflow Lifecycle ===

	startRun(opts: StartRunOptions): WorkflowRun {
		const run: WorkflowRun = {
			id: `run_${uuid().replace(/-/g, "").slice(0, 12)}`,
			workflowName: opts.workflowName,
			workflowPath: opts.workflowPath,
			triggerType: opts.triggerType,
			triggerSummary: opts.triggerSummary,
			status: "running",
			startedAt: Date.now(),
			nodeCount: opts.nodeCount,
			completedNodes: 0,
			tags: opts.tags,
			metadata: opts.metadata,
		};

		this.runs.set(run.id, run);
		this.nodeRuns.set(run.id, []);
		this.events.set(run.id, []);
		this.logs.set(run.id, []);

		this.emitEvent(run.id, run.workflowName, "RUN_STARTED", undefined, undefined, {
			workflowName: run.workflowName,
			triggerType: run.triggerType,
			triggerSummary: run.triggerSummary,
			nodeCount: run.nodeCount,
		});

		this.evictOldRuns();
		return run;
	}

	completeRun(runId: string, data?: unknown): void {
		const run = this.runs.get(runId);
		if (!run) return;

		run.status = "completed";
		run.finishedAt = Date.now();
		run.durationMs = run.finishedAt - run.startedAt;

		this.emitEvent(runId, run.workflowName, "RUN_COMPLETED", undefined, undefined, {
			durationMs: run.durationMs,
			completedNodes: run.completedNodes,
			data,
		});
	}

	failRun(runId: string, error: Error): void {
		const run = this.runs.get(runId);
		if (!run) return;

		run.status = "failed";
		run.finishedAt = Date.now();
		run.durationMs = run.finishedAt - run.startedAt;
		run.error = {
			message: error.message,
			stack: error.stack,
		};

		this.emitEvent(runId, run.workflowName, "RUN_FAILED", undefined, undefined, {
			durationMs: run.durationMs,
			error: { message: error.message, stack: error.stack },
		});
	}

	// === Node Lifecycle ===

	startNode(runId: string, opts: StartNodeOptions): NodeRun {
		const nodeRun: NodeRun = {
			id: `node_${uuid().replace(/-/g, "").slice(0, 12)}`,
			runId,
			nodeName: opts.nodeName,
			nodeType: opts.nodeType,
			runtimeKind: opts.runtimeKind,
			status: "running",
			startedAt: Date.now(),
			inputs: opts.inputs,
			parentNodeId: opts.parentNodeId,
			depth: opts.depth,
			stepIndex: opts.stepIndex,
		};

		const nodes = this.nodeRuns.get(runId);
		if (nodes) nodes.push(nodeRun);
		this.nodeRunIndex.set(nodeRun.id, nodeRun);

		const run = this.runs.get(runId);
		this.emitEvent(runId, run?.workflowName || "", "NODE_STARTED", opts.nodeName, nodeRun.id, {
			nodeType: opts.nodeType,
			runtimeKind: opts.runtimeKind,
			stepIndex: opts.stepIndex,
			depth: opts.depth,
		});

		return nodeRun;
	}

	completeNode(nodeRunId: string, outputs?: unknown, nodeMetrics?: NodeRun["metrics"]): void {
		const nodeRun = this.nodeRunIndex.get(nodeRunId);
		if (!nodeRun) return;

		nodeRun.status = "completed";
		nodeRun.finishedAt = Date.now();
		nodeRun.durationMs = nodeRun.finishedAt - nodeRun.startedAt;
		nodeRun.outputs = outputs;
		nodeRun.metrics = nodeMetrics;

		const run = this.runs.get(nodeRun.runId);
		if (run) run.completedNodes++;

		this.emitEvent(nodeRun.runId, run?.workflowName || "", "NODE_COMPLETED", nodeRun.nodeName, nodeRunId, {
			durationMs: nodeRun.durationMs,
			metrics: nodeMetrics,
		});
	}

	failNode(nodeRunId: string, error: Error): void {
		const nodeRun = this.nodeRunIndex.get(nodeRunId);
		if (!nodeRun) return;

		nodeRun.status = "failed";
		nodeRun.finishedAt = Date.now();
		nodeRun.durationMs = nodeRun.finishedAt - nodeRun.startedAt;
		nodeRun.error = {
			message: error.message,
			stack: error.stack,
		};

		const run = this.runs.get(nodeRun.runId);
		this.emitEvent(nodeRun.runId, run?.workflowName || "", "NODE_FAILED", nodeRun.nodeName, nodeRunId, {
			durationMs: nodeRun.durationMs,
			error: { message: error.message, stack: error.stack },
		});
	}

	skipNode(runId: string, nodeName: string, stepIndex: number, reason?: string): void {
		const run = this.runs.get(runId);
		this.emitEvent(runId, run?.workflowName || "", "NODE_SKIPPED", nodeName, undefined, {
			reason,
			stepIndex,
		});
	}

	// === Logging ===

	addLog(entry: Omit<TraceLogEntry, "id" | "timestamp">): void {
		const log: TraceLogEntry = {
			id: `log_${uuid().replace(/-/g, "").slice(0, 12)}`,
			...entry,
			timestamp: Date.now(),
		};

		const logs = this.logs.get(entry.runId);
		if (logs) logs.push(log);

		const run = this.runs.get(entry.runId);
		this.emitEvent(entry.runId, run?.workflowName || "", "LOG_ENTRY", entry.nodeName, entry.nodeId, {
			level: entry.level,
			message: entry.message,
			data: entry.data,
		});
	}

	// === Vars Updated ===

	trackVarsUpdate(runId: string, nodeName: string, nodeId: string | undefined, vars: Record<string, unknown>): void {
		const run = this.runs.get(runId);
		this.emitEvent(runId, run?.workflowName || "", "VARS_UPDATED", nodeName, nodeId, { vars });
	}

	// === Queries ===

	getRun(runId: string): WorkflowRun | undefined {
		return this.runs.get(runId);
	}

	getRuns(opts?: {
		workflow?: string;
		status?: WorkflowRunStatus;
		limit?: number;
		offset?: number;
		sort?: "asc" | "desc";
	}): { runs: WorkflowRun[]; total: number } {
		let runs = Array.from(this.runs.values());

		if (opts?.workflow) {
			runs = runs.filter((r) => r.workflowName === opts.workflow);
		}
		if (opts?.status) {
			runs = runs.filter((r) => r.status === opts.status);
		}

		// Sort by startedAt (default desc = most recent first)
		const sortDir = opts?.sort === "asc" ? 1 : -1;
		runs.sort((a, b) => sortDir * (b.startedAt - a.startedAt));

		const total = runs.length;
		const offset = opts?.offset ?? 0;
		const limit = opts?.limit ?? 50;
		runs = runs.slice(offset, offset + limit);

		return { runs, total };
	}

	getNodeRuns(runId: string): NodeRun[] {
		return this.nodeRuns.get(runId) || [];
	}

	getNodeRun(nodeRunId: string): NodeRun | undefined {
		return this.nodeRunIndex.get(nodeRunId);
	}

	getEvents(runId: string, since?: number): RunEvent[] {
		const events = this.events.get(runId) || [];
		if (since) {
			return events.filter((e) => e.timestamp > since);
		}
		return events;
	}

	getLogs(runId: string, nodeId?: string): TraceLogEntry[] {
		const logs = this.logs.get(runId) || [];
		if (nodeId) {
			return logs.filter((l) => l.nodeId === nodeId);
		}
		return logs;
	}

	// === Metadata ===

	getWorkflowSummaries(): WorkflowSummary[] {
		const summaries = new Map<string, {
			name: string;
			path: string;
			triggerTypes: Set<string>;
			totalRuns: number;
			recentRuns: number;
			lastRunAt?: number;
			lastRunStatus?: WorkflowRunStatus;
			errorCount: number;
			totalDuration: number;
			durations: number[];
		}>();

		const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;

		for (const run of this.runs.values()) {
			let summary = summaries.get(run.workflowName);
			if (!summary) {
				summary = {
					name: run.workflowName,
					path: run.workflowPath,
					triggerTypes: new Set(),
					totalRuns: 0,
					recentRuns: 0,
					errorCount: 0,
					totalDuration: 0,
					durations: [],
				};
				summaries.set(run.workflowName, summary);
			}

			summary.triggerTypes.add(run.triggerType);
			summary.totalRuns++;

			if (run.startedAt >= oneDayAgo) summary.recentRuns++;
			if (!summary.lastRunAt || run.startedAt > summary.lastRunAt) {
				summary.lastRunAt = run.startedAt;
				summary.lastRunStatus = run.status;
			}
			if (run.status === "failed") summary.errorCount++;
			if (run.durationMs !== undefined) {
				summary.totalDuration += run.durationMs;
				summary.durations.push(run.durationMs);
			}
		}

		return Array.from(summaries.values()).map((s) => {
			const sortedDurations = s.durations.sort((a, b) => a - b);
			const p95Index = Math.floor(sortedDurations.length * 0.95);

			return {
				name: s.name,
				path: s.path,
				triggerTypes: Array.from(s.triggerTypes),
				totalRuns: s.totalRuns,
				recentRuns: s.recentRuns,
				lastRunAt: s.lastRunAt,
				lastRunStatus: s.lastRunStatus,
				errorRate: s.totalRuns > 0 ? s.errorCount / s.totalRuns : 0,
				avgDurationMs: s.durations.length > 0 ? s.totalDuration / s.durations.length : 0,
				p95DurationMs: sortedDurations.length > 0 ? sortedDurations[p95Index] || sortedDurations[sortedDurations.length - 1] : 0,
			};
		});
	}

	// === Utility ===

	getActiveRunCount(): number {
		let count = 0;
		for (const run of this.runs.values()) {
			if (run.status === "running") count++;
		}
		return count;
	}

	clearAll(): number {
		const count = this.runs.size;
		this.runs.clear();
		this.nodeRuns.clear();
		this.nodeRunIndex.clear();
		this.events.clear();
		this.logs.clear();
		return count;
	}

	// === Internal ===

	private emitEvent(
		runId: string,
		workflowName: string,
		type: RunEventType,
		nodeName?: string,
		nodeId?: string,
		payload?: unknown,
	): void {
		const event: RunEvent = {
			id: `evt_${uuid().replace(/-/g, "").slice(0, 12)}`,
			type,
			runId,
			workflowName,
			timestamp: Date.now(),
			nodeName,
			nodeId,
			payload,
		};

		const events = this.events.get(runId);
		if (events) events.push(event);

		this.emit("event", event);
		this.emit(type, event);
	}

	private evictOldRuns(): void {
		if (this.runs.size <= this.maxRuns) return;

		// Find oldest runs
		const sorted = Array.from(this.runs.entries()).sort((a, b) => a[1].startedAt - b[1].startedAt);

		const toRemove = sorted.slice(0, this.runs.size - this.maxRuns);
		for (const [runId] of toRemove) {
			// Don't evict running runs
			const run = this.runs.get(runId);
			if (run?.status === "running") continue;

			this.runs.delete(runId);
			// Clean up node run index entries
			const nodes = this.nodeRuns.get(runId);
			if (nodes) {
				for (const node of nodes) {
					this.nodeRunIndex.delete(node.id);
				}
			}
			this.nodeRuns.delete(runId);
			this.events.delete(runId);
			this.logs.delete(runId);
		}
	}
}
