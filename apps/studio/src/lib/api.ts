import type {
  WorkflowSummary,
  WorkflowDetail,
  RunListResponse,
  RunDetail,
  RunEvent,
  HealthResponse,
  ConfigResponse,
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
