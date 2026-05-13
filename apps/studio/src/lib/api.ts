import type {
	AddTagResponse,
	ConfigResponse,
	DiffResponse,
	HealthResponse,
	MetricsResponse,
	RemoveTagResponse,
	RunDetail,
	RunEvent,
	RunListResponse,
	ScheduledDispatchesResponse,
	TagsResponse,
	Webhook,
	WebhooksResponse,
	WorkflowDetail,
	WorkflowSummary,
} from "@/types";

const BASE_URL = "/__blok";

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(`${BASE_URL}${path}`, {
		...init,
		headers: {
			Accept: "application/json",
			...init?.headers,
		},
	});
	if (!res.ok) {
		const body = await res.json().catch(() => ({}));
		throw new ApiError(res.status, (body as { error?: string }).error || res.statusText);
	}
	return res.json() as Promise<T>;
}

export class ApiError extends Error {
	constructor(
		public status: number,
		message: string,
	) {
		super(message);
		this.name = "ApiError";
	}
}

// === Health & Config ===

export function fetchHealth(): Promise<HealthResponse> {
	return fetchJson("/health");
}

export function fetchConfig(): Promise<ConfigResponse> {
	return fetchJson("/config");
}

// === Workflows ===

export function fetchWorkflows(): Promise<WorkflowSummary[]> {
	return fetchJson("/workflows");
}

export function fetchWorkflowDetail(name: string): Promise<WorkflowDetail> {
	return fetchJson(`/workflows/${encodeURIComponent(name)}`);
}

export function fetchWorkflowRuns(
	name: string,
	params?: { status?: string; limit?: number; offset?: number; sort?: string; env?: string },
): Promise<RunListResponse> {
	const query = new URLSearchParams();
	if (params?.status) query.set("status", params.status);
	if (params?.limit) query.set("limit", String(params.limit));
	if (params?.offset) query.set("offset", String(params.offset));
	if (params?.sort) query.set("sort", params.sort);
	if (params?.env) query.set("env", params.env);
	const qs = query.toString();
	return fetchJson(`/workflows/${encodeURIComponent(name)}/runs${qs ? `?${qs}` : ""}`);
}

// === Runs ===

export function fetchRuns(params?: {
	workflow?: string;
	status?: string;
	limit?: number;
	offset?: number;
	sort?: string;
	/**
	 * Phase 2.1 · environment scoping. When set, only runs whose
	 * `environment` matches are returned (legacy runs without the
	 * field default to `"production"`). Pass `"all"` or omit to
	 * disable scoping. Studio's hooks read `useEnvScope.current` and
	 * pass it here automatically.
	 */
	env?: string;
	/**
	 * Tier 2 quick-wins — filter by tags. AND semantics: all listed
	 * tags must be present on the run. Sent as `?tags=a,b,c`.
	 */
	tags?: string[];
	/**
	 * Filter by metadata. Accepts either:
	 *  - **`Record<string, string>`** (back-compat) — sent as
	 *    `?metadata.k1=v1&metadata.k2=v2`; equivalent to `op: "eq"` per key.
	 *  - **`MetadataFilterParam[]`** (F2, v0.5) — operator-aware filters.
	 *    Sent as `?metadata.<key>[__op]=<value>` with the operator as a
	 *    suffix. `in`/`nin` values are joined with commas; numeric
	 *    operators (`gt`/`lt`/`gte`/`lte`) accept any string the server
	 *    can coerce to a number.
	 *
	 * AND semantics across filters. Examples:
	 *   `[{key: "tier", op: "ne", value: "free"}]` → `?metadata.tier__ne=free`
	 *   `[{key: "region", op: "in", value: ["us", "eu"]}]` → `?metadata.region__in=us,eu`
	 */
	metadata?: Record<string, string> | MetadataFilterParam[];
}): Promise<RunListResponse> {
	const query = new URLSearchParams();
	if (params?.workflow) query.set("workflow", params.workflow);
	if (params?.status) query.set("status", params.status);
	if (params?.limit) query.set("limit", String(params.limit));
	if (params?.offset) query.set("offset", String(params.offset));
	if (params?.sort) query.set("sort", params.sort);
	if (params?.env) query.set("env", params.env);
	if (params?.tags && params.tags.length > 0) {
		query.set("tags", params.tags.join(","));
	}
	if (params?.metadata) {
		if (Array.isArray(params.metadata)) {
			for (const f of params.metadata) {
				const suffix = f.op === "eq" ? "" : `__${f.op}`;
				const value = Array.isArray(f.value) ? f.value.join(",") : f.value;
				query.set(`metadata.${f.key}${suffix}`, value);
			}
		} else {
			for (const [k, v] of Object.entries(params.metadata)) {
				query.set(`metadata.${k}`, v);
			}
		}
	}
	const qs = query.toString();
	return fetchJson(`/runs${qs ? `?${qs}` : ""}`);
}

/**
 * Studio-side shape of a single F2 metadata filter. Mirrors the
 * `MetadataFilter` type in `core/runner/src/tracing/types.ts` but with
 * a slightly looser typing — Studio doesn't import the runner's types
 * directly to keep the dep graph one-way.
 */
export interface MetadataFilterParam {
	key: string;
	op: "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "like" | "in" | "nin";
	value: string | string[];
}

export function fetchRunDetail(runId: string): Promise<RunDetail> {
	return fetchJson(`/runs/${encodeURIComponent(runId)}`);
}

export function fetchRunEvents(runId: string, since?: number): Promise<RunEvent[]> {
	const qs = since ? `?since=${since}` : "";
	return fetchJson(`/runs/${encodeURIComponent(runId)}/events${qs}`);
}

/**
 * Tier 2 · sub-workflow lineage. Returns runs that were started by a
 * `subworkflow:` step inside the given parent run, sorted oldest-first.
 * Returns `[]` when the run has no children.
 */
export function fetchSubRuns(runId: string): Promise<import("@/types").WorkflowRun[]> {
	return fetchJson(`/runs/${encodeURIComponent(runId)}/subruns`);
}

// === Logs (cross-run) ===
export interface LogsResponse {
	logs: Array<{
		id: string;
		runId: string;
		workflowName: string;
		workflowPath: string;
		nodeId?: string;
		nodeName?: string;
		level: "debug" | "info" | "warn" | "error";
		message: string;
		timestamp: number;
		data?: unknown;
	}>;
	total: number;
	truncated: boolean;
	query: { workflow?: string; level?: string; q?: string; since?: number; limit: number };
}

// === Queues (Phase 5) ===
export interface QueueSummary {
	id: string;
	name: string;
	triggerType: string;
	triggerTypes: string[];
	depth: number | null;
	runs24h: number;
	totalRuns: number;
	lastRunAt?: number;
	lastRunStatus?: string;
	avgDurationMs: number;
	errorRate: number;
}

export function fetchQueues(params?: { env?: string }): Promise<{
	queues: QueueSummary[];
	total: number;
	env: string | null;
}> {
	const qs = params?.env ? `?env=${encodeURIComponent(params.env)}` : "";
	return fetchJson(`/queues${qs}`);
}

// === Deployments (Phase 5) ===
export interface DeploymentSummary {
	workflowName: string;
	version: string;
	environment: string;
	runs: number;
	succeeded: number;
	failed: number;
	lastRunAt: number;
	firstRunAt: number;
	avgDurationMs: number;
	successRate: number;
}

export function fetchDeployments(params?: { env?: string; limit?: number }): Promise<{
	deployments: DeploymentSummary[];
	total: number;
	env: string | null;
}> {
	const query = new URLSearchParams();
	if (params?.env) query.set("env", params.env);
	if (params?.limit) query.set("limit", String(params.limit));
	const qs = query.toString();
	return fetchJson(`/deployments${qs ? `?${qs}` : ""}`);
}

export function fetchLogs(params?: {
	workflow?: string;
	level?: string;
	q?: string;
	since?: number;
	limit?: number;
	/** Phase 2.1 · environment scoping; see `fetchRuns` doc. */
	env?: string;
}): Promise<LogsResponse> {
	const query = new URLSearchParams();
	if (params?.workflow) query.set("workflow", params.workflow);
	if (params?.level) query.set("level", params.level);
	if (params?.q) query.set("q", params.q);
	if (params?.since !== undefined) query.set("since", String(params.since));
	if (params?.limit !== undefined) query.set("limit", String(params.limit));
	if (params?.env) query.set("env", params.env);
	const qs = query.toString();
	return fetchJson(`/logs${qs ? `?${qs}` : ""}`);
}

export function clearRuns(): Promise<{ deleted: number }> {
	return fetchJson("/runs", { method: "DELETE" });
}

// === Replay ===

export interface ReplayResponse {
	newRunId: string;
	originalRunId: string;
	workflowName: string;
	/**
	 * Tier 1 explicit replay lineage — same value as `originalRunId`,
	 * surfaced under the field name the new run's WorkflowRun will carry
	 * so callers don't need separate paths for "from response" vs
	 * "from a fetched run record".
	 */
	replayOf: string;
}

export function replayRun(
	runId: string,
	overrides?: { method?: string; path?: string; headers?: Record<string, string>; body?: unknown },
): Promise<ReplayResponse> {
	return fetchJson(`/runs/${encodeURIComponent(runId)}/replay`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: overrides ? JSON.stringify(overrides) : undefined,
	});
}

// === Cancellation ===

export interface CancelRunResponse {
	cancelled: boolean;
	runId: string;
	previousStatus: string;
	newStatus: "cancelled";
}

/**
 * Cancel a pending (delayed / debounced / queued) or running run.
 * Backend: `POST /__blok/runs/:runId/cancel`. The endpoint flips the
 * run's status to `"cancelled"` AND cancels the underlying scheduler
 * entry (`DeferredRunScheduler` / `DebounceCoordinator`) so the timer
 * doesn't fire later. Terminal states (completed / failed / expired /
 * crashed / timedOut) are non-cancellable — the endpoint returns 400.
 */
export function cancelRun(runId: string): Promise<CancelRunResponse> {
	return fetchJson(`/runs/${encodeURIComponent(runId)}/cancel`, {
		method: "POST",
	});
}

// === Scheduled dispatches (E1) ===

/**
 * List pending scheduled dispatches — rows from `scheduled_dispatches`
 * that haven't fired yet. Powers Studio's "Scheduled" page so operators
 * can see + cancel inbound dispatches before they execute. Fired
 * runs are pruned from this table immediately; expired runs are pruned
 * by the Janitor. To see those, use the regular `/runs` view filtered
 * by `status=completed` / `status=expired` / etc.
 */
export function fetchScheduledDispatches(params?: {
	status?: string[];
	workflowName?: string;
	limit?: number;
	offset?: number;
}): Promise<ScheduledDispatchesResponse> {
	const query = new URLSearchParams();
	if (params?.status && params.status.length > 0) query.set("status", params.status.join(","));
	if (params?.workflowName) query.set("workflowName", params.workflowName);
	if (params?.limit) query.set("limit", String(params.limit));
	if (params?.offset) query.set("offset", String(params.offset));
	const qs = query.toString();
	return fetchJson(`/scheduled${qs ? `?${qs}` : ""}`);
}

// === Routing diagnostics (E4 follow-up) ===

/**
 * Mirror of `RoutingDiagnostic` from the runner. Surfaces boot-time
 * route-build problems (collisions, missing explicit paths, scan
 * errors) so Studio can render a banner on the Workflows page rather
 * than burying the issue in terminal logs.
 */
export interface RoutingDiagnostic {
	kind: "duplicate" | "any-shadows-specific" | "missing-path" | "scan-error";
	method?: string;
	path?: string;
	winnerSource?: string;
	droppedSource?: string;
	message: string;
	recordedAt: number;
}

export interface RoutingDiagnosticsResponse {
	diagnostics: RoutingDiagnostic[];
	count: number;
	now: number;
}

export function fetchRoutingDiagnostics(): Promise<RoutingDiagnosticsResponse> {
	return fetchJson("/routing");
}

// === Search ===

export interface SearchResponse {
	workflows: WorkflowSummary[];
	runs: import("@/types").WorkflowRun[];
}

export function searchTraces(query: string): Promise<SearchResponse> {
	return fetchJson(`/search?q=${encodeURIComponent(query)}`);
}

// === Diff ===

export function fetchRunDiff(runIdA: string, runIdB: string): Promise<DiffResponse> {
	return fetchJson(`/runs/diff?a=${encodeURIComponent(runIdA)}&b=${encodeURIComponent(runIdB)}`);
}

// === Tags ===

export function fetchTags(): Promise<TagsResponse> {
	return fetchJson("/tags");
}

export function addRunTags(runId: string, tags: string[]): Promise<AddTagResponse> {
	return fetchJson(`/runs/${encodeURIComponent(runId)}/tags`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ tags }),
	});
}

export function removeRunTag(runId: string, tag: string): Promise<RemoveTagResponse> {
	return fetchJson(`/runs/${encodeURIComponent(runId)}/tags/${encodeURIComponent(tag)}`, { method: "DELETE" });
}

// === Metrics ===

export function fetchMetrics(workflow?: string): Promise<MetricsResponse> {
	const qs = workflow ? `?workflow=${encodeURIComponent(workflow)}` : "";
	return fetchJson(`/metrics${qs}`);
}

// === Send Request (Request Builder) ===

export async function sendWorkflowRequest(opts: {
	method: string;
	path: string;
	headers?: Record<string, string>;
	body?: string;
}): Promise<{ status: number; headers: Record<string, string>; body: string }> {
	const res = await fetch(opts.path, {
		method: opts.method,
		headers: {
			"Content-Type": "application/json",
			...opts.headers,
		},
		body: opts.method !== "GET" && opts.method !== "HEAD" ? opts.body : undefined,
	});

	const responseHeaders: Record<string, string> = {};
	res.headers.forEach((value, key) => {
		responseHeaders[key] = value;
	});

	const text = await res.text();
	return { status: res.status, headers: responseHeaders, body: text };
}

// === Export ===

/**
 * Download an export file (JSON or CSV) by triggering a browser download.
 */
export function downloadExport(url: string, filename: string): void {
	const a = document.createElement("a");
	a.href = `${BASE_URL}${url}`;
	a.download = filename;
	a.style.display = "none";
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
}

export function exportRunJson(runId: string): void {
	downloadExport(`/runs/${encodeURIComponent(runId)}/export?format=json`, `blok-run-${runId}.json`);
}

export function exportRunCsv(runId: string): void {
	downloadExport(`/runs/${encodeURIComponent(runId)}/export?format=csv`, `blok-run-${runId}.csv`);
}

export function exportRunsJson(params?: { workflow?: string; status?: string }): void {
	const query = new URLSearchParams();
	query.set("format", "json");
	if (params?.workflow) query.set("workflow", params.workflow);
	if (params?.status) query.set("status", params.status);
	downloadExport(`/runs/export?${query.toString()}`, `blok-runs-${Date.now()}.json`);
}

export function exportRunsCsv(params?: { workflow?: string; status?: string }): void {
	const query = new URLSearchParams();
	query.set("format", "csv");
	if (params?.workflow) query.set("workflow", params.workflow);
	if (params?.status) query.set("status", params.status);
	downloadExport(`/runs/export?${query.toString()}`, `blok-runs-${Date.now()}.csv`);
}

// === Webhooks ===

export function fetchWebhooks(): Promise<WebhooksResponse> {
	return fetchJson("/webhooks");
}

export function createWebhook(opts: {
	url: string;
	events?: string[];
	secret?: string;
}): Promise<Webhook> {
	return fetchJson("/webhooks", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(opts),
	});
}

export function deleteWebhook(id: string): Promise<{ removed: boolean }> {
	return fetchJson(`/webhooks/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// === Custom Dashboards ===

export function fetchDashboards(): Promise<import("@/types").DashboardsResponse> {
	return fetchJson("/dashboards");
}

export function fetchDashboard(id: string): Promise<import("@/types").Dashboard> {
	return fetchJson(`/dashboards/${encodeURIComponent(id)}`);
}

export function createDashboard(data: {
	name: string;
	description?: string;
	widgets?: import("@/types").DashboardWidget[];
	isDefault?: boolean;
}): Promise<import("@/types").Dashboard> {
	return fetchJson("/dashboards", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(data),
	});
}

export function updateDashboard(
	id: string,
	data: Partial<import("@/types").Dashboard>,
): Promise<import("@/types").Dashboard> {
	return fetchJson(`/dashboards/${encodeURIComponent(id)}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(data),
	});
}

export function deleteDashboard(id: string): Promise<{ deleted: boolean }> {
	return fetchJson(`/dashboards/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function duplicateDashboard(id: string): Promise<import("@/types").Dashboard> {
	return fetchJson(`/dashboards/${encodeURIComponent(id)}/duplicate`, {
		method: "POST",
	});
}

// === AI Error Explanation ===

export function explainRunError(runId: string, nodeId?: string): Promise<import("@/types").ExplainResponse> {
	return fetchJson(`/runs/${encodeURIComponent(runId)}/explain`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(nodeId ? { nodeId } : {}),
	});
}

// === Concurrency observability (Tier 2 follow-up) ===

export interface ConcurrencyHealth {
	backend: string;
	disabled: boolean;
	leaseMs: number;
}

export interface ConcurrencyBucket {
	workflowName: string;
	concurrencyKey: string;
	inFlight: number;
	leases: Array<{ runId: string; expiresAt: number }>;
}

export interface ConcurrencyState {
	totalBuckets: number;
	totalLeases: number;
	buckets: ConcurrencyBucket[];
}

export function fetchConcurrencyHealth(): Promise<ConcurrencyHealth> {
	return fetchJson("/concurrency/health");
}

export function fetchConcurrencyState(): Promise<ConcurrencyState> {
	return fetchJson("/concurrency/state");
}
