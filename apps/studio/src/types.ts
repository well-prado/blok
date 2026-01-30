/** Mirror of backend tracing types for the Studio frontend. */

export type WorkflowRunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface WorkflowRun {
  id: string;
  workflowName: string;
  workflowPath: string;
  triggerType: string;
  triggerSummary: string;
  status: WorkflowRunStatus;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  error?: {
    message: string;
    code?: string;
    stack?: string;
  };
  tags?: string[];
  metadata?: Record<string, unknown>;
  nodeCount: number;
  completedNodes: number;
}

export type NodeRunStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export interface NodeRun {
  id: string;
  runId: string;
  nodeName: string;
  nodeType: string;
  runtimeKind?: string;
  status: NodeRunStatus;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  inputs?: unknown;
  outputs?: unknown;
  error?: {
    message: string;
    code?: string;
    stack?: string;
  };
  parentNodeId?: string;
  depth: number;
  stepIndex: number;
  metrics?: {
    duration_ms?: number;
    cpu_ms?: number;
    memory_bytes?: number;
  };
}

export type RunEventType =
  | "RUN_STARTED"
  | "RUN_COMPLETED"
  | "RUN_FAILED"
  | "NODE_STARTED"
  | "NODE_COMPLETED"
  | "NODE_FAILED"
  | "NODE_SKIPPED"
  | "VARS_UPDATED"
  | "LOG_ENTRY";

export interface RunEvent {
  id: string;
  type: RunEventType;
  runId: string;
  workflowName: string;
  timestamp: number;
  nodeName?: string;
  nodeId?: string;
  payload?: unknown;
}

export interface TraceLogEntry {
  id: string;
  runId: string;
  nodeId?: string;
  nodeName?: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  timestamp: number;
  data?: Record<string, unknown>;
}

export interface WorkflowSummary {
  name: string;
  path: string;
  triggerTypes: string[];
  totalRuns: number;
  recentRuns: number;
  lastRunAt?: number;
  lastRunStatus?: WorkflowRunStatus;
  errorRate: number;
  avgDurationMs: number;
  p95DurationMs: number;
}

export interface WorkflowDetail extends WorkflowSummary {
  definition?: unknown;
  nodeNames: string[];
  runtimes: string[];
}

export interface RunDetail {
  run: WorkflowRun;
  nodes: NodeRun[];
  logs: TraceLogEntry[];
}

export interface RunListResponse {
  runs: WorkflowRun[];
  total: number;
  page: number;
}

export interface HealthResponse {
  status: string;
  version: string;
  uptime: number;
  activeRuns: number;
}

export interface ConfigResponse {
  workflows: string[];
  triggers: string[];
}
