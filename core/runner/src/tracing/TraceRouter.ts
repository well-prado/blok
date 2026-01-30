import type { RunEvent } from "./types";
import { RunTracker } from "./RunTracker";

/**
 * Minimal interfaces matching the Express API surface used by trace routes.
 * This avoids a hard dependency on express in the runner package.
 */
interface TraceRequest {
	method: string;
	params: Record<string, string>;
	query: Record<string, string | undefined>;
	headers: Record<string, string | string[] | undefined>;
	on(event: string, listener: () => void): void;
}

interface TraceResponse {
	setHeader(name: string, value: string): void;
	status(code: number): TraceResponse;
	json(body: unknown): void;
	write(chunk: string): boolean;
	end(): void;
	sendStatus(code: number): void;
	flushHeaders(): void;
}

interface TraceRouter {
	use(handler: (req: TraceRequest, res: TraceResponse, next: () => void) => void): void;
	get(path: string, handler: (req: TraceRequest, res: TraceResponse) => void): void;
	delete(path: string, handler: (req: TraceRequest, res: TraceResponse) => void): void;
}

/**
 * Register trace API routes on an Express-compatible router.
 *
 * This function avoids importing express directly so the runner package
 * doesn't need express as a dependency. The caller passes in a Router
 * instance and the function registers all /__blok/* routes on it.
 *
 * Usage (in HttpTrigger.ts):
 * ```ts
 * import { Router } from "express";
 * import { registerTraceRoutes } from "@nanoservice-ts/runner";
 * const traceRouter = Router();
 * registerTraceRoutes(traceRouter);
 * app.use("/__blok", traceRouter);
 * ```
 */
export function registerTraceRoutes(router: TraceRouter, tracker?: RunTracker): void {
	const t = tracker || RunTracker.getInstance();

	// --- CORS for cross-origin Studio UI ---
	router.use((req: TraceRequest, res: TraceResponse, next: () => void) => {
		res.setHeader("Access-Control-Allow-Origin", "*");
		res.setHeader("Access-Control-Allow-Methods", "GET, DELETE, OPTIONS");
		res.setHeader("Access-Control-Allow-Headers", "Content-Type, Last-Event-ID");
		if (req.method === "OPTIONS") {
			res.sendStatus(204);
			return;
		}
		next();
	});

	// === Utility Endpoints ===

	router.get("/health", (_req: TraceRequest, res: TraceResponse) => {
		res.json({
			status: "ok",
			version: process.env.npm_package_version || "0.0.0",
			uptime: process.uptime(),
			activeRuns: t.getActiveRunCount(),
		});
	});

	router.get("/config", (_req: TraceRequest, res: TraceResponse) => {
		const summaries = t.getWorkflowSummaries();
		const workflows = summaries.map((s) => s.name);
		const triggers = [...new Set(summaries.flatMap((s) => s.triggerTypes))];
		res.json({ workflows, triggers });
	});

	// === Workflow Endpoints ===

	router.get("/workflows", (_req: TraceRequest, res: TraceResponse) => {
		const summaries = t.getWorkflowSummaries();
		res.json(summaries);
	});

	router.get("/workflows/:name", (req: TraceRequest, res: TraceResponse) => {
		const { name } = req.params;
		const summaries = t.getWorkflowSummaries();
		const summary = summaries.find((s) => s.name === name);

		if (!summary) {
			res.status(404).json({ error: `Workflow '${name}' not found` });
			return;
		}

		// Collect node names and runtimes from recent runs
		const { runs } = t.getRuns({ workflow: name, limit: 10 });
		const nodeNames = new Set<string>();
		const runtimes = new Set<string>();

		for (const run of runs) {
			const nodes = t.getNodeRuns(run.id);
			for (const node of nodes) {
				nodeNames.add(node.nodeName);
				if (node.runtimeKind) runtimes.add(node.runtimeKind);
			}
		}

		res.json({
			...summary,
			nodeNames: Array.from(nodeNames),
			runtimes: Array.from(runtimes),
		});
	});

	router.get("/workflows/:name/runs", (req: TraceRequest, res: TraceResponse) => {
		const { name } = req.params;
		const status = req.query.status;
		const limit = Number.parseInt(req.query.limit || "50", 10);
		const offset = Number.parseInt(req.query.offset || "0", 10);
		const sort = (req.query.sort as "asc" | "desc") || "desc";

		const result = t.getRuns({
			workflow: name,
			status: status as "running" | "completed" | "failed" | undefined,
			limit,
			offset,
			sort,
		});

		res.json({
			runs: result.runs,
			total: result.total,
			page: Math.floor(offset / limit) + 1,
		});
	});

	// === Run Endpoints ===

	router.get("/runs", (req: TraceRequest, res: TraceResponse) => {
		const workflow = req.query.workflow;
		const status = req.query.status;
		const limit = Number.parseInt(req.query.limit || "50", 10);
		const offset = Number.parseInt(req.query.offset || "0", 10);
		const sort = (req.query.sort as "asc" | "desc") || "desc";

		const result = t.getRuns({
			workflow,
			status: status as "running" | "completed" | "failed" | undefined,
			limit,
			offset,
			sort,
		});

		res.json({
			runs: result.runs,
			total: result.total,
			page: Math.floor(offset / limit) + 1,
		});
	});

	router.get("/runs/:runId", (req: TraceRequest, res: TraceResponse) => {
		const { runId } = req.params;
		const run = t.getRun(runId);

		if (!run) {
			res.status(404).json({ error: `Run '${runId}' not found` });
			return;
		}

		const nodes = t.getNodeRuns(runId);
		const logs = t.getLogs(runId);

		res.json({ run, nodes, logs });
	});

	router.get("/runs/:runId/events", (req: TraceRequest, res: TraceResponse) => {
		const { runId } = req.params;
		const since = req.query.since ? Number.parseInt(req.query.since, 10) : undefined;

		const run = t.getRun(runId);
		if (!run) {
			res.status(404).json({ error: `Run '${runId}' not found` });
			return;
		}

		const events = t.getEvents(runId, since);
		res.json(events);
	});

	router.delete("/runs", (_req: TraceRequest, res: TraceResponse) => {
		const deleted = t.clearAll();
		res.json({ deleted });
	});

	// === SSE Endpoints ===

	/**
	 * SSE stream for a specific run.
	 * Sends all past events as a replay, then streams new events live.
	 * Auto-closes when the run finishes.
	 */
	router.get("/runs/:runId/stream", (req: TraceRequest, res: TraceResponse) => {
		const { runId } = req.params;
		const run = t.getRun(runId);

		if (!run) {
			res.status(404).json({ error: `Run '${runId}' not found` });
			return;
		}

		// Set SSE headers
		res.setHeader("Content-Type", "text/event-stream");
		res.setHeader("Cache-Control", "no-cache");
		res.setHeader("Connection", "keep-alive");
		res.setHeader("X-Accel-Buffering", "no"); // Disable nginx buffering
		res.flushHeaders();

		// Replay past events (respecting Last-Event-ID for reconnection)
		const lastEventId = req.headers["last-event-id"] as string | undefined;
		const existingEvents = t.getEvents(runId);

		if (lastEventId) {
			const idx = existingEvents.findIndex((e) => e.id === lastEventId);
			const eventsToReplay = idx >= 0 ? existingEvents.slice(idx + 1) : existingEvents;
			for (const event of eventsToReplay) {
				writeSSE(res, event);
			}
		} else {
			for (const event of existingEvents) {
				writeSSE(res, event);
			}
		}

		// If run already finished, close stream
		if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
			res.write("event: stream-end\ndata: {\"reason\":\"run_finished\"}\n\n");
			res.end();
			return;
		}

		// Stream live events
		const onEvent = (event: RunEvent) => {
			if (event.runId !== runId) return;
			writeSSE(res, event);

			// Auto-close when run finishes
			if (event.type === "RUN_COMPLETED" || event.type === "RUN_FAILED") {
				res.write("event: stream-end\ndata: {\"reason\":\"run_finished\"}\n\n");
				res.end();
			}
		};

		t.on("event", onEvent);

		// Heartbeat to keep connection alive
		const heartbeat = setInterval(() => {
			res.write(":heartbeat\n\n");
		}, 15000);

		// Cleanup on disconnect
		req.on("close", () => {
			t.removeListener("event", onEvent);
			clearInterval(heartbeat);
		});
	});

	/**
	 * Global SSE stream for all run events (dashboard live feed).
	 * Optionally filtered by workflow names.
	 */
	router.get("/stream", (req: TraceRequest, res: TraceResponse) => {
		const workflowFilter = req.query.workflows
			? req.query.workflows.split(",").map((w: string) => w.trim())
			: null;

		// Set SSE headers
		res.setHeader("Content-Type", "text/event-stream");
		res.setHeader("Cache-Control", "no-cache");
		res.setHeader("Connection", "keep-alive");
		res.setHeader("X-Accel-Buffering", "no");
		res.flushHeaders();

		const onEvent = (event: RunEvent) => {
			if (workflowFilter && !workflowFilter.includes(event.workflowName)) return;
			writeSSE(res, event);
		};

		t.on("event", onEvent);

		// Heartbeat
		const heartbeat = setInterval(() => {
			res.write(":heartbeat\n\n");
		}, 15000);

		req.on("close", () => {
			t.removeListener("event", onEvent);
			clearInterval(heartbeat);
		});
	});
}

function writeSSE(res: TraceResponse, event: RunEvent): void {
	res.write(`event: ${event.type}\n`);
	res.write(`id: ${event.id}\n`);
	res.write(`data: ${JSON.stringify(event)}\n\n`);
}
