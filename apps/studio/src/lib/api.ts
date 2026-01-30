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
	params?: { status?: string; limit?: number; offset?: number; sort?: string },
): Promise<RunListResponse> {
	const query = new URLSearchParams();
	if (params?.status) query.set("status", params.status);
	if (params?.limit) query.set("limit", String(params.limit));
	if (params?.offset) query.set("offset", String(params.offset));
	if (params?.sort) query.set("sort", params.sort);
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
}): Promise<RunListResponse> {
	const query = new URLSearchParams();
	if (params?.workflow) query.set("workflow", params.workflow);
	if (params?.status) query.set("status", params.status);
	if (params?.limit) query.set("limit", String(params.limit));
	if (params?.offset) query.set("offset", String(params.offset));
	if (params?.sort) query.set("sort", params.sort);
	const qs = query.toString();
	return fetchJson(`/runs${qs ? `?${qs}` : ""}`);
}

export function fetchRunDetail(runId: string): Promise<RunDetail> {
	return fetchJson(`/runs/${encodeURIComponent(runId)}`);
}

export function fetchRunEvents(runId: string, since?: number): Promise<RunEvent[]> {
	const qs = since ? `?since=${since}` : "";
	return fetchJson(`/runs/${encodeURIComponent(runId)}/events${qs}`);
}

export function clearRuns(): Promise<{ deleted: number }> {
	return fetchJson("/runs", { method: "DELETE" });
}

// === Replay ===

export interface ReplayResponse {
	newRunId: string;
	originalRunId: string;
	workflowName: string;
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
