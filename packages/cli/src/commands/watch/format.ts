import { createColors } from "picocolors";

/**
 * The subset of the runner's `RunEvent` (core/runner/src/tracing/types.ts) that
 * arrives over `/__blok/stream`. Declared locally so the CLI doesn't take a
 * runtime dependency on `@blokjs/runner` just to read JSON off the wire.
 */
export interface WatchRunEvent {
	id: string;
	type: string;
	runId: string;
	workflowName: string;
	timestamp: number;
	nodeName?: string;
	nodeId?: string;
	payload?: {
		durationMs?: number;
		error?: { message?: string; code?: number | string } | unknown;
		reason?: string;
		[k: string]: unknown;
	};
}

export interface FormatOptions {
	/** Emit ANSI colors (default true). Pass false for deterministic/piped output. */
	color?: boolean;
	/** Also render node-started / skipped / scheduling events (default false). */
	verbose?: boolean;
}

const NODE_INDENT = "  ";

function shortRun(runId: string): string {
	// Keep enough to disambiguate but stay compact: `run_8f3a12bc` → `run_8f3a12`.
	return runId.length > 12 ? runId.slice(0, 12) : runId;
}

function durationMs(payload: WatchRunEvent["payload"]): string {
	const d = payload?.durationMs;
	return typeof d === "number" && Number.isFinite(d) ? `${Math.round(d)}ms` : "";
}

function errorText(payload: WatchRunEvent["payload"]): string {
	const e = payload?.error as { message?: string; code?: number | string } | undefined;
	if (!e || typeof e !== "object") return "";
	const code = e.code !== undefined && e.code !== null ? `${e.code} ` : "";
	return `${code}${e.message ?? "error"}`.trim();
}

/**
 * Map one `RunEvent` to a single terminal line — or `null` to skip it. Pure +
 * deterministic (with `color:false`), so it is unit-tested directly. Noisy
 * event types (logs, vars, progress, heartbeats) return `null` by default.
 */
export function formatEvent(ev: WatchRunEvent, opts: FormatOptions = {}): string | null {
	const c = createColors(opts.color ?? true);
	const verbose = opts.verbose ?? false;
	const run = c.dim(shortRun(ev.runId));
	const wf = c.bold(ev.workflowName || "(workflow)");
	const node = ev.nodeName ?? "";
	const ms = durationMs(ev.payload);
	const err = errorText(ev.payload);

	switch (ev.type) {
		case "RUN_STARTED":
			return `${c.cyan("▶")} ${wf}  ${run}  ${c.dim("started")}`;
		case "NODE_STARTED":
			return verbose ? `${NODE_INDENT}${c.dim("·")} ${node} ${c.dim("…")}` : null;
		case "NODE_COMPLETED":
			return `${NODE_INDENT}${c.green("✓")} ${node}${ms ? `  ${c.dim(ms)}` : ""}`;
		case "NODE_CACHED":
			return `${NODE_INDENT}${c.blue("◆")} ${node}  ${c.dim("cached")}`;
		case "NODE_SKIPPED":
			return verbose ? `${NODE_INDENT}${c.dim("→")} ${node}  ${c.dim("skipped")}` : null;
		case "NODE_ATTEMPT_FAILED":
			return `${NODE_INDENT}${c.yellow("↻")} ${node}  ${c.yellow("attempt failed")}${err ? `  ${c.dim(err)}` : ""}`;
		case "NODE_FAILED":
			return `${NODE_INDENT}${c.red("✗")} ${node}  ${c.red("FAILED")}${err ? `  ${c.dim(err)}` : ""}`;
		case "RUN_COMPLETED":
			return `${c.green("■")} ${wf}  ${run}  ${c.green("completed")}${ms ? ` ${c.dim(`(${ms})`)}` : ""}`;
		case "RUN_FAILED":
			return `${c.red("■")} ${wf}  ${run}  ${c.red("FAILED")}${ms ? ` ${c.dim(`(${ms})`)}` : ""}${err ? ` ${c.red(`· ${err}`)}` : ""}`;
		case "RUN_CRASHED":
			return `${c.red("■")} ${wf}  ${run}  ${c.red("CRASHED")}${err ? ` ${c.red(`· ${err}`)}` : ""}`;
		case "RUN_TIMED_OUT":
			return `${c.red("■")} ${wf}  ${run}  ${c.red("TIMED OUT")}${ms ? ` ${c.dim(`(${ms})`)}` : ""}`;
		case "RUN_CANCELLED":
			return `${c.yellow("■")} ${wf}  ${run}  ${c.yellow("cancelled")}`;
		case "RUN_THROTTLED":
			return `${c.yellow("■")} ${wf}  ${run}  ${c.yellow("throttled")}`;
		case "RUN_QUEUED":
		case "RUN_DELAYED":
		case "RUN_DEBOUNCED":
		case "RUN_EXPIRED":
			return verbose ? `${c.dim("·")} ${wf}  ${run}  ${c.dim(ev.type.replace("RUN_", "").toLowerCase())}` : null;
		default:
			// LOG_ENTRY, VARS_UPDATED, NODE_PROGRESS, NODE_PARTIAL_RESULT, connected, …
			return null;
	}
}
