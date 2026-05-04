import type { RunStore } from "./RunStore";
import type {
	CachedStepResult,
	ConcurrencySlotResult,
	Dashboard,
	MetricsResult,
	NodeRun,
	RunEvent,
	RunQuery,
	ScheduledDispatchRow,
	TraceLogEntry,
	WorkflowRun,
	WorkflowRunStatus,
	WorkflowSummary,
} from "./types";

/**
 * In-memory implementation of RunStore using Maps.
 * Zero dependencies, fastest possible reads/writes.
 * Data is lost on process restart.
 */
export class InMemoryRunStore implements RunStore {
	private runs: Map<string, WorkflowRun> = new Map();
	private nodeRuns: Map<string, NodeRun[]> = new Map(); // runId → NodeRun[]
	private nodeRunIndex: Map<string, NodeRun> = new Map(); // nodeRunId → NodeRun
	private events: Map<string, RunEvent[]> = new Map(); // runId → RunEvent[]
	private logs: Map<string, TraceLogEntry[]> = new Map(); // runId → LogEntry[]
	private dashboards: Map<string, Dashboard> = new Map();
	private idempotencyCache: Map<string, CachedStepResult> = new Map();
	private concurrencyLocks: Map<string, Map<string, number>> = new Map();
	private scheduledDispatches: Map<string, ScheduledDispatchRow> = new Map();

	private idemKey(workflowName: string, stepId: string, key: string): string {
		// US (\x1f) is non-printable and never appears in identifiers, so it
		// cannot collide with characters in workflow / step / key strings.
		return `${workflowName}\x1f${stepId}\x1f${key}`;
	}

	private concurrencyBucketKey(workflowName: string, concurrencyKey: string): string {
		return `${workflowName}\x1f${concurrencyKey}`;
	}

	// === Writes ===

	saveRun(run: WorkflowRun): void {
		this.runs.set(run.id, run);
		if (!this.nodeRuns.has(run.id)) this.nodeRuns.set(run.id, []);
		if (!this.events.has(run.id)) this.events.set(run.id, []);
		if (!this.logs.has(run.id)) this.logs.set(run.id, []);
	}

	updateRun(runId: string, updates: Partial<WorkflowRun>): void {
		const run = this.runs.get(runId);
		if (!run) return;
		Object.assign(run, updates);
	}

	saveNodeRun(nodeRun: NodeRun): void {
		const nodes = this.nodeRuns.get(nodeRun.runId);
		if (nodes) nodes.push(nodeRun);
		this.nodeRunIndex.set(nodeRun.id, nodeRun);
	}

	updateNodeRun(nodeRunId: string, updates: Partial<NodeRun>): void {
		const nodeRun = this.nodeRunIndex.get(nodeRunId);
		if (!nodeRun) return;
		Object.assign(nodeRun, updates);
	}

	saveEvent(event: RunEvent): void {
		const events = this.events.get(event.runId);
		if (events) events.push(event);
	}

	saveLog(entry: TraceLogEntry): void {
		const logs = this.logs.get(entry.runId);
		if (logs) logs.push(entry);
	}

	// === Reads ===

	getRun(runId: string): WorkflowRun | undefined {
		return this.runs.get(runId);
	}

	getRuns(opts?: RunQuery): { runs: WorkflowRun[]; total: number } {
		let runs = Array.from(this.runs.values());

		if (opts?.workflow) {
			runs = runs.filter((r) => r.workflowName === opts.workflow);
		}
		if (opts?.status) {
			runs = runs.filter((r) => r.status === opts.status);
		}
		if (opts?.tags && opts.tags.length > 0) {
			const filterTags = opts.tags;
			runs = runs.filter((r) => r.tags && filterTags.every((tag) => r.tags?.includes(tag)));
		}
		if (opts?.metadata) {
			const entries = Object.entries(opts.metadata);
			if (entries.length > 0) {
				runs = runs.filter(
					(r) =>
						r.metadata != null &&
						entries.every(([k, v]) => r.metadata?.[k] !== undefined && String(r.metadata[k]) === v),
				);
			}
		}

		// asc = oldest first (a.startedAt - b.startedAt), desc = newest first
		const sortDir = opts?.sort === "asc" ? 1 : -1;
		runs.sort((a, b) => sortDir * (a.startedAt - b.startedAt));

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

	getRunsByParent(parentRunId: string): WorkflowRun[] {
		const matches: WorkflowRun[] = [];
		for (const run of this.runs.values()) {
			if (run.parentRunId === parentRunId) matches.push(run);
		}
		matches.sort((a, b) => a.startedAt - b.startedAt);
		return matches;
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

	// === Aggregations ===

	getWorkflowSummaries(): WorkflowSummary[] {
		const summaries = new Map<
			string,
			{
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
			}
		>();

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
				p95DurationMs:
					sortedDurations.length > 0 ? sortedDurations[p95Index] || sortedDurations[sortedDurations.length - 1] : 0,
			};
		});
	}

	getAllTags(): string[] {
		const tags = new Set<string>();
		for (const run of this.runs.values()) {
			if (run.tags) {
				for (const tag of run.tags) tags.add(tag);
			}
		}
		return Array.from(tags).sort();
	}

	getActiveRunCount(): number {
		let count = 0;
		for (const run of this.runs.values()) {
			if (run.status === "running") count++;
		}
		return count;
	}

	getMetrics(workflow?: string): MetricsResult {
		let allRuns = Array.from(this.runs.values());
		if (workflow) {
			allRuns = allRuns.filter((r) => r.workflowName === workflow);
		}

		const durations = allRuns
			.filter((r) => r.durationMs !== undefined)
			.map((r) => r.durationMs as number)
			.sort((a, b) => a - b);

		const completedRuns = allRuns.filter((r) => r.status === "completed").length;
		const failedRuns = allRuns.filter((r) => r.status === "failed").length;

		const percentile = (arr: number[], p: number) => {
			if (arr.length === 0) return 0;
			const idx = Math.floor(arr.length * p);
			return arr[Math.min(idx, arr.length - 1)];
		};

		// Execution timeline — hourly buckets for last 24h
		const now = Date.now();
		const bucketSize = 60 * 60 * 1000;
		const bucketCount = 24;
		const executionTimeline: MetricsResult["executionTimeline"] = [];

		for (let i = bucketCount - 1; i >= 0; i--) {
			const bucketStart = now - (i + 1) * bucketSize;
			const bucketEnd = now - i * bucketSize;
			const bucketRuns = allRuns.filter((r) => r.startedAt >= bucketStart && r.startedAt < bucketEnd);
			executionTimeline.push({
				bucket: new Date(bucketStart).toISOString(),
				total: bucketRuns.length,
				completed: bucketRuns.filter((r) => r.status === "completed").length,
				failed: bucketRuns.filter((r) => r.status === "failed").length,
			});
		}

		// Duration distribution
		const ranges = [
			{ range: "0-10ms", min: 0, max: 10 },
			{ range: "10-50ms", min: 10, max: 50 },
			{ range: "50-100ms", min: 50, max: 100 },
			{ range: "100-500ms", min: 100, max: 500 },
			{ range: "500ms-1s", min: 500, max: 1000 },
			{ range: "1-5s", min: 1000, max: 5000 },
			{ range: "5s+", min: 5000, max: Number.POSITIVE_INFINITY },
		];
		const durationDistribution = ranges.map(({ range, min, max }) => ({
			range,
			count: durations.filter((d) => d >= min && d < max).length,
		}));

		// Workflow breakdown
		const wfMap = new Map<string, { total: number; failed: number; durations: number[] }>();
		for (const run of allRuns) {
			let wf = wfMap.get(run.workflowName);
			if (!wf) {
				wf = { total: 0, failed: 0, durations: [] };
				wfMap.set(run.workflowName, wf);
			}
			wf.total++;
			if (run.status === "failed") wf.failed++;
			if (run.durationMs !== undefined) wf.durations.push(run.durationMs);
		}

		const workflowBreakdown = Array.from(wfMap.entries()).map(([name, data]) => ({
			name,
			totalRuns: data.total,
			errorRate: data.total > 0 ? data.failed / data.total : 0,
			avgDurationMs: data.durations.length > 0 ? data.durations.reduce((a, b) => a + b, 0) / data.durations.length : 0,
		}));

		// Node performance
		const nodeMap = new Map<string, { durations: number[]; failed: number; total: number }>();
		for (const run of allRuns) {
			const nodes = this.nodeRuns.get(run.id);
			if (!nodes) continue;
			for (const node of nodes) {
				let nd = nodeMap.get(node.nodeName);
				if (!nd) {
					nd = { durations: [], failed: 0, total: 0 };
					nodeMap.set(node.nodeName, nd);
				}
				nd.total++;
				if (node.status === "failed") nd.failed++;
				if (node.durationMs !== undefined) nd.durations.push(node.durationMs);
			}
		}

		const nodePerformance = Array.from(nodeMap.entries()).map(([nodeName, data]) => ({
			nodeName,
			avgDurationMs: data.durations.length > 0 ? data.durations.reduce((a, b) => a + b, 0) / data.durations.length : 0,
			maxDurationMs: data.durations.length > 0 ? Math.max(...data.durations) : 0,
			errorRate: data.total > 0 ? data.failed / data.total : 0,
			executionCount: data.total,
		}));

		return {
			totalRuns: allRuns.length,
			completedRuns,
			failedRuns,
			avgDurationMs: durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0,
			p50DurationMs: percentile(durations, 0.5),
			p95DurationMs: percentile(durations, 0.95),
			p99DurationMs: percentile(durations, 0.99),
			executionTimeline,
			durationDistribution,
			workflowBreakdown,
			nodePerformance,
		};
	}

	// === Dashboards ===

	saveDashboard(dashboard: Dashboard): void {
		this.dashboards.set(dashboard.id, dashboard);
	}

	getDashboard(dashboardId: string): Dashboard | undefined {
		return this.dashboards.get(dashboardId);
	}

	listDashboards(): Dashboard[] {
		return Array.from(this.dashboards.values()).sort((a, b) => b.updatedAt - a.updatedAt);
	}

	deleteDashboard(dashboardId: string): boolean {
		return this.dashboards.delete(dashboardId);
	}

	updateDashboard(dashboardId: string, updates: Partial<Dashboard>): void {
		const dashboard = this.dashboards.get(dashboardId);
		if (!dashboard) return;
		Object.assign(dashboard, updates, { updatedAt: Date.now() });
	}

	// === Cleanup ===

	clearAll(): number {
		const count = this.runs.size;
		this.runs.clear();
		this.nodeRuns.clear();
		this.nodeRunIndex.clear();
		this.events.clear();
		this.logs.clear();
		this.dashboards.clear();
		this.idempotencyCache.clear();
		this.concurrencyLocks.clear();
		return count;
	}

	deleteRunsBefore(timestamp: number): number {
		let deleted = 0;
		for (const [runId, run] of this.runs.entries()) {
			if (run.startedAt < timestamp && run.status !== "running") {
				this.deleteRun(runId);
				deleted++;
			}
		}
		return deleted;
	}

	evictOldRuns(maxRuns: number): void {
		if (this.runs.size <= maxRuns) return;

		const sorted = Array.from(this.runs.entries()).sort((a, b) => a[1].startedAt - b[1].startedAt);
		const toRemove = sorted.slice(0, this.runs.size - maxRuns);

		for (const [runId] of toRemove) {
			const run = this.runs.get(runId);
			if (run?.status === "running") continue;
			this.deleteRun(runId);
		}
	}

	// === Idempotency cache ===

	getIdempotencyCache(workflowName: string, stepId: string, key: string): CachedStepResult | null {
		const k = this.idemKey(workflowName, stepId, key);
		const entry = this.idempotencyCache.get(k);
		if (!entry) return null;
		if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
			this.idempotencyCache.delete(k);
			return null;
		}
		return entry;
	}

	setIdempotencyCache(workflowName: string, stepId: string, key: string, entry: CachedStepResult): void {
		this.idempotencyCache.set(this.idemKey(workflowName, stepId, key), entry);
	}

	purgeExpiredIdempotencyCache(now: number): number {
		let removed = 0;
		for (const [k, entry] of this.idempotencyCache.entries()) {
			if (entry.expiresAt !== null && entry.expiresAt <= now) {
				this.idempotencyCache.delete(k);
				removed++;
			}
		}
		return removed;
	}

	// === Concurrency gating (Tier 2 #6) ===

	acquireConcurrencySlot(
		workflowName: string,
		concurrencyKey: string,
		concurrencyLimit: number,
		runId: string,
		leaseExpiresAt: number,
	): ConcurrencySlotResult {
		const bucketKey = this.concurrencyBucketKey(workflowName, concurrencyKey);
		let bucket = this.concurrencyLocks.get(bucketKey);
		if (!bucket) {
			bucket = new Map();
			this.concurrencyLocks.set(bucketKey, bucket);
		}

		// Lazy-purge expired leases for THIS bucket so we don't deny based
		// on a slot held by a process that crashed mid-run.
		const now = Date.now();
		for (const [otherRunId, expiresAt] of bucket) {
			if (expiresAt <= now) bucket.delete(otherRunId);
		}

		// Idempotent re-acquire — if the same runId already holds a slot,
		// refresh its lease and report success without growing the count.
		if (bucket.has(runId)) {
			bucket.set(runId, leaseExpiresAt);
			return { acquired: true, currentInFlight: bucket.size };
		}

		if (bucket.size >= concurrencyLimit) {
			return { acquired: false, currentInFlight: bucket.size };
		}

		bucket.set(runId, leaseExpiresAt);
		return { acquired: true, currentInFlight: bucket.size };
	}

	releaseConcurrencySlot(workflowName: string, concurrencyKey: string, runId: string): void {
		const bucketKey = this.concurrencyBucketKey(workflowName, concurrencyKey);
		const bucket = this.concurrencyLocks.get(bucketKey);
		if (!bucket) return;
		bucket.delete(runId);
		if (bucket.size === 0) this.concurrencyLocks.delete(bucketKey);
	}

	purgeExpiredConcurrencySlots(now: number): number {
		let removed = 0;
		for (const [bucketKey, bucket] of this.concurrencyLocks.entries()) {
			for (const [runId, expiresAt] of bucket) {
				if (expiresAt <= now) {
					bucket.delete(runId);
					removed++;
				}
			}
			if (bucket.size === 0) this.concurrencyLocks.delete(bucketKey);
		}
		return removed;
	}

	// === Durable scheduling (Tier 2 #5+#7 follow-up) ===

	upsertScheduledDispatch(row: ScheduledDispatchRow): void {
		// Clone to avoid external mutations bleeding into the store.
		this.scheduledDispatches.set(row.runId, { ...row });
	}

	deleteScheduledDispatch(runId: string): boolean {
		return this.scheduledDispatches.delete(runId);
	}

	getScheduledDispatches(opts?: { triggerType?: string; status?: string }): ScheduledDispatchRow[] {
		const triggerType = opts?.triggerType;
		const status = opts?.status;
		const out: ScheduledDispatchRow[] = [];
		for (const row of this.scheduledDispatches.values()) {
			if (triggerType && row.triggerType !== triggerType) continue;
			if (status && row.dispatchStatus !== status) continue;
			out.push({ ...row });
		}
		out.sort((a, b) => a.scheduledAt - b.scheduledAt);
		return out;
	}

	close(): void {
		// No-op for in-memory store
	}

	// === Internal ===

	private deleteRun(runId: string): void {
		const nodes = this.nodeRuns.get(runId);
		if (nodes) {
			for (const node of nodes) {
				this.nodeRunIndex.delete(node.id);
			}
		}
		this.runs.delete(runId);
		this.nodeRuns.delete(runId);
		this.events.delete(runId);
		this.logs.delete(runId);
	}
}
