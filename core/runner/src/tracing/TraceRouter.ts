import http from "node:http";
import { RunTracker } from "./RunTracker";
import type { NodeRun, RunEvent, TraceLogEntry, WorkflowRun } from "./types";

/**
 * Minimal interfaces matching the Express API surface used by trace routes.
 * This avoids a hard dependency on express in the runner package.
 */
interface TraceRequest {
	method: string;
	params: Record<string, string>;
	query: Record<string, string | undefined>;
	headers: Record<string, string | string[] | undefined>;
	body?: unknown;
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
	post(path: string, handler: (req: TraceRequest, res: TraceResponse) => void): void;
	put(path: string, handler: (req: TraceRequest, res: TraceResponse) => void): void;
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
 * import { registerTraceRoutes } from "@blok/runner";
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
		res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
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

	// === Diff (before /runs/:runId to avoid param collision) ===

	/**
	 * Compare two runs side-by-side.
	 * Returns both runs with their nodes for diff view.
	 */
	router.get("/runs/diff", (req: TraceRequest, res: TraceResponse) => {
		const runIdA = req.query.a;
		const runIdB = req.query.b;

		if (!runIdA || !runIdB) {
			res.status(400).json({ error: "Both query params 'a' and 'b' are required" });
			return;
		}

		const runA = t.getRun(runIdA);
		const runB = t.getRun(runIdB);

		if (!runA) {
			res.status(404).json({ error: `Run '${runIdA}' not found` });
			return;
		}
		if (!runB) {
			res.status(404).json({ error: `Run '${runIdB}' not found` });
			return;
		}

		res.json({
			runA: { run: runA, nodes: t.getNodeRuns(runIdA), logs: t.getLogs(runIdA) },
			runB: { run: runB, nodes: t.getNodeRuns(runIdB), logs: t.getLogs(runIdB) },
		});
	});

	// === Tags ===

	router.get("/tags", (_req: TraceRequest, res: TraceResponse) => {
		res.json({ tags: t.getAllTags() });
	});

	router.post("/runs/:runId/tags", (req: TraceRequest, res: TraceResponse) => {
		const { runId } = req.params;
		const run = t.getRun(runId);

		if (!run) {
			res.status(404).json({ error: `Run '${runId}' not found` });
			return;
		}

		const body = req.body as { tag?: string; tags?: string[] } | undefined;
		const tagsToAdd: string[] = [];

		if (body?.tag) tagsToAdd.push(body.tag);
		if (body?.tags) tagsToAdd.push(...body.tags);

		if (tagsToAdd.length === 0) {
			res.status(400).json({ error: "Provide 'tag' or 'tags' in request body" });
			return;
		}

		const added: string[] = [];
		for (const tag of tagsToAdd) {
			if (t.addTag(runId, tag.trim())) {
				added.push(tag.trim());
			}
		}

		res.json({ added, tags: run.tags || [] });
	});

	router.delete("/runs/:runId/tags/:tag", (req: TraceRequest, res: TraceResponse) => {
		const { runId, tag } = req.params;
		const run = t.getRun(runId);

		if (!run) {
			res.status(404).json({ error: `Run '${runId}' not found` });
			return;
		}

		const removed = t.removeTag(runId, tag);
		res.json({ removed, tags: run.tags || [] });
	});

	// === Metrics ===

	router.get("/metrics", (req: TraceRequest, res: TraceResponse) => {
		const workflow = req.query.workflow;
		const metrics = t.getMetrics(workflow);
		res.json(metrics);
	});

	// === Export ===

	/**
	 * Export runs as JSON or CSV.
	 * Bulk export: GET /__blok/runs/export?format=json|csv&workflow=...&status=...&limit=1000
	 * Must be registered before /runs/:runId to avoid param collision.
	 */
	router.get("/runs/export", (req: TraceRequest, res: TraceResponse) => {
		const format = (req.query.format || "json") as "json" | "csv";
		const workflow = req.query.workflow;
		const status = req.query.status;
		const limit = Number.parseInt(req.query.limit || "1000", 10);

		const result = t.getRuns({
			workflow,
			status: status as "running" | "completed" | "failed" | undefined,
			limit,
			sort: "desc",
		});

		if (format === "csv") {
			const csv = runsToCsv(result.runs);
			res.setHeader("Content-Type", "text/csv");
			res.setHeader("Content-Disposition", `attachment; filename="blok-runs-${Date.now()}.csv"`);
			res.write(csv);
			res.end();
			return;
		}

		// JSON export — include full detail for each run
		const exportData = {
			exportedAt: new Date().toISOString(),
			format: "json",
			total: result.runs.length,
			runs: result.runs.map((run) => ({
				run,
				nodes: t.getNodeRuns(run.id),
				events: t.getEvents(run.id),
				logs: t.getLogs(run.id),
			})),
		};

		res.setHeader("Content-Type", "application/json");
		res.setHeader("Content-Disposition", `attachment; filename="blok-runs-${Date.now()}.json"`);
		res.json(exportData);
	});

	/**
	 * Export a single run as JSON or CSV.
	 * GET /__blok/runs/:runId/export?format=json|csv
	 */
	router.get("/runs/:runId/export", (req: TraceRequest, res: TraceResponse) => {
		const { runId } = req.params;
		const format = (req.query.format || "json") as "json" | "csv";
		const run = t.getRun(runId);

		if (!run) {
			res.status(404).json({ error: `Run '${runId}' not found` });
			return;
		}

		const nodes = t.getNodeRuns(runId);
		const events = t.getEvents(runId);
		const logs = t.getLogs(runId);

		if (format === "csv") {
			const csv = singleRunToCsv(run, nodes, logs);
			res.setHeader("Content-Type", "text/csv");
			res.setHeader("Content-Disposition", `attachment; filename="blok-run-${runId}.csv"`);
			res.write(csv);
			res.end();
			return;
		}

		const exportData = {
			exportedAt: new Date().toISOString(),
			format: "json",
			run,
			nodes,
			events,
			logs,
		};

		res.setHeader("Content-Type", "application/json");
		res.setHeader("Content-Disposition", `attachment; filename="blok-run-${runId}.json"`);
		res.json(exportData);
	});

	// === Webhooks ===

	/**
	 * List registered webhooks.
	 */
	router.get("/webhooks", (_req: TraceRequest, res: TraceResponse) => {
		res.json({ webhooks: t.getWebhooks() });
	});

	/**
	 * Register a webhook.
	 * Body: { url: string, events?: string[], secret?: string }
	 */
	router.post("/webhooks", (req: TraceRequest, res: TraceResponse) => {
		const body = (req.body || {}) as { url?: string; events?: string[]; secret?: string };

		if (!body.url) {
			res.status(400).json({ error: "Missing required field 'url'" });
			return;
		}

		try {
			new URL(body.url);
		} catch {
			res.status(400).json({ error: "Invalid URL" });
			return;
		}

		const webhook = t.registerWebhook({
			url: body.url,
			events: body.events || ["run.completed", "run.failed"],
			secret: body.secret,
		});

		res.status(201).json(webhook);
	});

	/**
	 * Remove a webhook.
	 */
	router.delete("/webhooks/:id", (req: TraceRequest, res: TraceResponse) => {
		const { id } = req.params;
		const removed = t.removeWebhook(id);

		if (!removed) {
			res.status(404).json({ error: `Webhook '${id}' not found` });
			return;
		}

		res.json({ removed: true });
	});

	// === Run Endpoints ===

	router.get("/runs", (req: TraceRequest, res: TraceResponse) => {
		const workflow = req.query.workflow;
		const status = req.query.status;
		const tags = req.query.tags ? req.query.tags.split(",").map((t: string) => t.trim()) : undefined;
		const limit = Number.parseInt(req.query.limit || "50", 10);
		const offset = Number.parseInt(req.query.offset || "0", 10);
		const sort = (req.query.sort as "asc" | "desc") || "desc";

		const result = t.getRuns({
			workflow,
			status: status as "running" | "completed" | "failed" | undefined,
			tags,
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

	// === Replay ===

	/**
	 * Re-trigger a workflow by replaying a previous run.
	 * Makes an HTTP request to the original workflow endpoint.
	 */
	router.post("/runs/:runId/replay", (req: TraceRequest, res: TraceResponse) => {
		const { runId } = req.params;
		const run = t.getRun(runId);

		if (!run) {
			res.status(404).json({ error: `Run '${runId}' not found` });
			return;
		}

		if (run.triggerType !== "http") {
			res.status(400).json({ error: `Replay is only supported for HTTP triggers (got '${run.triggerType}')` });
			return;
		}

		// Parse method and path from triggerSummary (e.g. "GET /countries")
		const parts = run.triggerSummary.split(" ");
		const method = (parts[0] || "GET").toUpperCase();
		const path = parts[1] || "/";

		// Determine the host to call (use the incoming request's Host header)
		const host = (req.headers.host as string) || "localhost:4000";
		const protocol = "http";
		const url = `${protocol}://${host}${path}`;

		// Allow overriding method, path, headers, and body via request body
		const overrides = (req.body || {}) as Record<string, unknown>;
		const finalMethod = ((overrides.method as string) || method).toUpperCase();
		const finalUrl = overrides.path ? `${protocol}://${host}${overrides.path}` : url;
		const customHeaders: Record<string, string> = {
			"Content-Type": "application/json",
			...((overrides.headers as Record<string, string>) || {}),
		};
		const body = overrides.body !== undefined ? JSON.stringify(overrides.body) : undefined;

		// Listen for the next RUN_STARTED event matching this workflow
		const timeout = setTimeout(() => {
			cleanup();
			res.status(504).json({ error: "Replay timed out waiting for new run" });
		}, 10000);

		const cleanup = () => {
			clearTimeout(timeout);
			t.removeListener("RUN_STARTED", onRunStarted);
		};

		const onRunStarted = (event: RunEvent) => {
			if (event.workflowName !== run.workflowName) return;
			cleanup();
			res.json({
				newRunId: event.runId,
				originalRunId: runId,
				workflowName: run.workflowName,
			});
		};

		t.on("RUN_STARTED", onRunStarted);

		// Make the HTTP request to re-trigger the workflow
		const parsedUrl = new URL(finalUrl);

		const reqOpts: import("node:http").RequestOptions = {
			hostname: parsedUrl.hostname,
			port: parsedUrl.port,
			path: parsedUrl.pathname + parsedUrl.search,
			method: finalMethod,
			headers: customHeaders,
		};

		const httpReq = http.request(reqOpts, (httpRes) => {
			// Consume response body to prevent memory leaks
			const chunks: Buffer[] = [];
			httpRes.on("data", (chunk: Buffer) => chunks.push(chunk));
			httpRes.on("end", () => {
				// If we haven't already responded (via onRunStarted), respond now
				// The RUN_STARTED listener should have fired before the response ends
			});
		});

		httpReq.on("error", (err: Error) => {
			cleanup();
			res.status(502).json({ error: `Replay request failed: ${err.message}` });
		});

		if (body) {
			httpReq.write(body);
		}
		httpReq.end();

		// Cleanup if client disconnects
		req.on("close", cleanup);
	});

	// === AI Error Explanation ===

	/**
	 * Explain a run or node error using an LLM.
	 * Requires OPENAI_API_KEY environment variable.
	 *
	 * POST /__blok/runs/:runId/explain
	 * Body: { nodeId?: string }
	 * Returns: { explanation: string, model: string }
	 */
	router.post("/runs/:runId/explain", async (req: TraceRequest, res: TraceResponse) => {
		const { runId } = req.params;
		const run = t.getRun(runId);

		if (!run) {
			res.status(404).json({ error: `Run '${runId}' not found` });
			return;
		}

		const apiKey = process.env.OPENAI_API_KEY;
		if (!apiKey) {
			res.status(503).json({
				error: "AI explanation unavailable — set OPENAI_API_KEY environment variable",
			});
			return;
		}

		const body = (req.body || {}) as { nodeId?: string };
		const nodes = t.getNodeRuns(runId);
		const logs = t.getLogs(runId);

		// Build context for the LLM
		let errorContext: string;
		if (body.nodeId) {
			const node = nodes.find((n) => n.id === body.nodeId);
			if (!node) {
				res.status(404).json({ error: `Node '${body.nodeId}' not found in run` });
				return;
			}
			if (!node.error) {
				res.status(400).json({ error: `Node '${node.nodeName}' has no error` });
				return;
			}
			const nodeLogs = logs.filter((l) => l.nodeId === node.id || l.nodeName === node.nodeName);
			errorContext = buildNodeErrorContext(run, node, nodes, nodeLogs);
		} else {
			if (!run.error) {
				res.status(400).json({ error: "This run has no error to explain" });
				return;
			}
			const failedNodes = nodes.filter((n) => n.status === "failed");
			errorContext = buildRunErrorContext(run, nodes, failedNodes, logs);
		}

		try {
			const model = process.env.BLOK_AI_MODEL || "gpt-4o-mini";
			const explanation = await callOpenAI(apiKey, model, errorContext);
			res.json({ explanation, model });
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : "Unknown AI API error";
			res.status(502).json({ error: `AI explanation failed: ${msg}` });
		}
	});

	// === Search ===

	/**
	 * Search across workflows and runs.
	 * Used by the command palette (Cmd+K).
	 */
	router.get("/search", (req: TraceRequest, res: TraceResponse) => {
		const query = (req.query.q || "").toLowerCase().trim();

		if (!query) {
			res.json({ workflows: [], runs: [] });
			return;
		}

		// Search workflows
		const allWorkflows = t.getWorkflowSummaries();
		const matchedWorkflows = allWorkflows.filter(
			(w) =>
				w.name.toLowerCase().includes(query) ||
				w.path.toLowerCase().includes(query) ||
				w.triggerTypes.some((tt) => tt.toLowerCase().includes(query)),
		);

		// Search runs (by ID, workflow name, trigger summary, or error message)
		const { runs: allRuns } = t.getRuns({ limit: 200 });
		const matchedRuns = allRuns
			.filter(
				(r) =>
					r.id.toLowerCase().includes(query) ||
					r.workflowName.toLowerCase().includes(query) ||
					r.triggerSummary.toLowerCase().includes(query) ||
					r.error?.message.toLowerCase().includes(query) ||
					r.status.toLowerCase().includes(query),
			)
			.slice(0, 20);

		res.json({
			workflows: matchedWorkflows.slice(0, 10),
			runs: matchedRuns,
		});
	});

	// === Custom Dashboards ===

	/**
	 * List all dashboards.
	 * GET /__blok/dashboards
	 */
	router.get("/dashboards", (_req: TraceRequest, res: TraceResponse) => {
		const dashboards = t.listDashboards();
		res.json({ dashboards });
	});

	/**
	 * Get a single dashboard by ID.
	 * GET /__blok/dashboards/:dashboardId
	 */
	router.get("/dashboards/:dashboardId", (req: TraceRequest, res: TraceResponse) => {
		const dashboard = t.getDashboard(req.params.dashboardId);
		if (!dashboard) {
			res.status(404).json({ error: `Dashboard '${req.params.dashboardId}' not found` });
			return;
		}
		res.json(dashboard);
	});

	/**
	 * Create a new dashboard.
	 * POST /__blok/dashboards
	 * Body: { name, description?, widgets?, isDefault? }
	 */
	router.post("/dashboards", (req: TraceRequest, res: TraceResponse) => {
		const body = (req.body || {}) as {
			name?: string;
			description?: string;
			widgets?: unknown[];
			isDefault?: boolean;
		};

		if (!body.name || typeof body.name !== "string" || body.name.trim().length === 0) {
			res.status(400).json({ error: "Dashboard name is required" });
			return;
		}

		const now = Date.now();
		const dashboard = {
			id: `dash_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
			name: body.name.trim(),
			description: body.description,
			isDefault: body.isDefault ?? false,
			createdAt: now,
			updatedAt: now,
			widgets: Array.isArray(body.widgets) ? body.widgets : [],
		};

		t.saveDashboard(dashboard as import("./types").Dashboard);
		res.status(201).json(dashboard);
	});

	/**
	 * Update an existing dashboard.
	 * PUT /__blok/dashboards/:dashboardId
	 * Body: { name?, description?, widgets?, isDefault? }
	 */
	router.put("/dashboards/:dashboardId", (req: TraceRequest, res: TraceResponse) => {
		const { dashboardId } = req.params;
		const existing = t.getDashboard(dashboardId);
		if (!existing) {
			res.status(404).json({ error: `Dashboard '${dashboardId}' not found` });
			return;
		}

		const body = (req.body || {}) as Partial<import("./types").Dashboard>;
		t.updateDashboard(dashboardId, body);

		const updated = t.getDashboard(dashboardId);
		res.json(updated);
	});

	/**
	 * Delete a dashboard.
	 * DELETE /__blok/dashboards/:dashboardId
	 */
	router.delete("/dashboards/:dashboardId", (req: TraceRequest, res: TraceResponse) => {
		const deleted = t.deleteDashboard(req.params.dashboardId);
		if (!deleted) {
			res.status(404).json({ error: `Dashboard '${req.params.dashboardId}' not found` });
			return;
		}
		res.json({ deleted: true });
	});

	/**
	 * Duplicate a dashboard.
	 * POST /__blok/dashboards/:dashboardId/duplicate
	 */
	router.post("/dashboards/:dashboardId/duplicate", (req: TraceRequest, res: TraceResponse) => {
		const source = t.getDashboard(req.params.dashboardId);
		if (!source) {
			res.status(404).json({ error: `Dashboard '${req.params.dashboardId}' not found` });
			return;
		}

		const now = Date.now();
		const copy: import("./types").Dashboard = {
			...source,
			id: `dash_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
			name: `${source.name} (Copy)`,
			isDefault: false,
			createdAt: now,
			updatedAt: now,
		};

		t.saveDashboard(copy);
		res.status(201).json(copy);
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

		// Immediate acknowledgment so the browser fires onopen without waiting
		res.write(`event: connected\ndata: ${JSON.stringify({ runId, timestamp: Date.now() })}\n\n`);
		res.write("retry: 3000\n\n");

		// Replay past events (respecting Last-Event-ID for reconnection).
		// Cap fresh connections to last 50 events to avoid blocking the stream.
		// The client fetches full run state via GET /runs/:runId.
		const MAX_REPLAY_EVENTS = 50;
		const lastEventId = req.headers["last-event-id"] as string | undefined;
		const existingEvents = t.getEvents(runId);

		let eventsToReplay: RunEvent[];
		if (lastEventId) {
			// Reconnection — replay all events since the last received (uncapped)
			const idx = existingEvents.findIndex((e) => e.id === lastEventId);
			eventsToReplay = idx >= 0 ? existingEvents.slice(idx + 1) : existingEvents;
		} else {
			// Fresh connection — only replay the most recent events
			eventsToReplay =
				existingEvents.length > MAX_REPLAY_EVENTS ? existingEvents.slice(-MAX_REPLAY_EVENTS) : existingEvents;
		}

		for (const event of eventsToReplay) {
			writeSSE(res, event);
		}

		// If run already finished, close stream
		if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
			res.write('event: stream-end\ndata: {"reason":"run_finished"}\n\n');
			res.end();
			return;
		}

		// Stream live events
		const onEvent = (event: RunEvent) => {
			if (event.runId !== runId) return;
			writeSSE(res, event);

			// Auto-close when run finishes
			if (event.type === "RUN_COMPLETED" || event.type === "RUN_FAILED") {
				res.write('event: stream-end\ndata: {"reason":"run_finished"}\n\n');
				res.end();
			}
		};

		t.on("event", onEvent);

		// Heartbeat to keep connection alive
		const heartbeat = setInterval(() => {
			res.write(":heartbeat\n\n");
		}, 5000);

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
		const workflowFilter = req.query.workflows ? req.query.workflows.split(",").map((w: string) => w.trim()) : null;

		// Set SSE headers
		res.setHeader("Content-Type", "text/event-stream");
		res.setHeader("Cache-Control", "no-cache");
		res.setHeader("Connection", "keep-alive");
		res.setHeader("X-Accel-Buffering", "no");
		res.flushHeaders();

		// Immediate acknowledgment so the browser fires onopen without waiting
		res.write(`event: connected\ndata: ${JSON.stringify({ timestamp: Date.now() })}\n\n`);
		res.write("retry: 3000\n\n");

		const onEvent = (event: RunEvent) => {
			if (workflowFilter && !workflowFilter.includes(event.workflowName)) return;
			writeSSE(res, event);
		};

		t.on("event", onEvent);

		// Heartbeat
		const heartbeat = setInterval(() => {
			res.write(":heartbeat\n\n");
		}, 5000);

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

// === CSV Helpers ===

function escapeCsv(value: unknown): string {
	if (value === null || value === undefined) return "";
	const str = typeof value === "object" ? JSON.stringify(value) : String(value);
	if (str.includes(",") || str.includes('"') || str.includes("\n")) {
		return `"${str.replace(/"/g, '""')}"`;
	}
	return str;
}

function runsToCsv(runs: WorkflowRun[]): string {
	const headers = [
		"id",
		"workflowName",
		"workflowPath",
		"triggerType",
		"triggerSummary",
		"status",
		"startedAt",
		"finishedAt",
		"durationMs",
		"nodeCount",
		"completedNodes",
		"error",
		"tags",
	];
	const rows = runs.map((r) => [
		r.id,
		r.workflowName,
		r.workflowPath,
		r.triggerType,
		r.triggerSummary,
		r.status,
		new Date(r.startedAt).toISOString(),
		r.finishedAt ? new Date(r.finishedAt).toISOString() : "",
		r.durationMs ?? "",
		r.nodeCount,
		r.completedNodes,
		r.error?.message ?? "",
		(r.tags || []).join(";"),
	]);
	return `${[headers.join(","), ...rows.map((row) => row.map(escapeCsv).join(","))].join("\n")}\n`;
}

function singleRunToCsv(run: WorkflowRun, nodes: NodeRun[], logs: TraceLogEntry[]): string {
	let csv = "# Run Summary\n";
	csv +=
		"id,workflowName,triggerType,triggerSummary,status,startedAt,finishedAt,durationMs,nodeCount,completedNodes,error\n";
	csv += `${[
		run.id,
		run.workflowName,
		run.triggerType,
		run.triggerSummary,
		run.status,
		new Date(run.startedAt).toISOString(),
		run.finishedAt ? new Date(run.finishedAt).toISOString() : "",
		run.durationMs ?? "",
		run.nodeCount,
		run.completedNodes,
		run.error?.message ?? "",
	]
		.map(escapeCsv)
		.join(",")}\n`;

	csv += "\n# Nodes\n";
	csv += "id,nodeName,nodeType,runtimeKind,status,startedAt,finishedAt,durationMs,stepIndex,depth,error\n";
	for (const n of nodes) {
		csv += `${[
			n.id,
			n.nodeName,
			n.nodeType,
			n.runtimeKind ?? "",
			n.status,
			new Date(n.startedAt).toISOString(),
			n.finishedAt ? new Date(n.finishedAt).toISOString() : "",
			n.durationMs ?? "",
			n.stepIndex,
			n.depth,
			n.error?.message ?? "",
		]
			.map(escapeCsv)
			.join(",")}\n`;
	}

	csv += "\n# Logs\n";
	csv += "id,nodeName,level,message,timestamp\n";
	for (const l of logs) {
		csv += `${[l.id, l.nodeName ?? "", l.level, l.message, new Date(l.timestamp).toISOString()]
			.map(escapeCsv)
			.join(",")}\n`;
	}

	return csv;
}

// === AI Error Explanation Helpers ===

function buildNodeErrorContext(
	run: WorkflowRun,
	node: NodeRun,
	allNodes: NodeRun[],
	nodeLogs: TraceLogEntry[],
): string {
	const timeline = allNodes
		.sort((a, b) => a.stepIndex - b.stepIndex)
		.map(
			(n) =>
				`  [${n.stepIndex}] ${n.nodeName} (${n.nodeType}${n.runtimeKind ? `, ${n.runtimeKind}` : ""}) → ${n.status}${n.durationMs ? ` (${n.durationMs}ms)` : ""}`,
		)
		.join("\n");

	const logLines = nodeLogs
		.slice(-20)
		.map((l) => `  [${l.level.toUpperCase()}] ${l.message}`)
		.join("\n");

	return `You are a workflow debugging assistant. A node failed during a Blok workflow execution. Analyze the error and provide:
1. A clear explanation of what went wrong
2. The likely root cause
3. Suggested fixes

## Workflow Context
- Workflow: ${run.workflowName} (${run.workflowPath})
- Trigger: ${run.triggerSummary}
- Status: ${run.status}

## Node Execution Timeline
${timeline}

## Failed Node Details
- Name: ${node.nodeName}
- Type: ${node.nodeType}${node.runtimeKind ? `\n- Runtime: ${node.runtimeKind}` : ""}
- Step Index: ${node.stepIndex}
- Duration: ${node.durationMs ?? "N/A"}ms

## Error
- Message: ${node.error?.message ?? "Unknown"}${node.error?.code ? `\n- Code: ${node.error.code}` : ""}${node.error?.stack ? `\n- Stack Trace:\n${node.error.stack}` : ""}

## Node Input
${node.inputs ? JSON.stringify(node.inputs, null, 2).slice(0, 2000) : "N/A"}

## Node Output (before failure)
${node.outputs ? JSON.stringify(node.outputs, null, 2).slice(0, 2000) : "N/A"}

${logLines ? `## Node Logs (last 20)\n${logLines}` : ""}

Provide a concise, actionable explanation. Focus on the root cause and how to fix it.`;
}

function buildRunErrorContext(
	run: WorkflowRun,
	allNodes: NodeRun[],
	failedNodes: NodeRun[],
	logs: TraceLogEntry[],
): string {
	const timeline = allNodes
		.sort((a, b) => a.stepIndex - b.stepIndex)
		.map(
			(n) =>
				`  [${n.stepIndex}] ${n.nodeName} (${n.nodeType}${n.runtimeKind ? `, ${n.runtimeKind}` : ""}) → ${n.status}${n.durationMs ? ` (${n.durationMs}ms)` : ""}`,
		)
		.join("\n");

	const failedDetails = failedNodes
		.map(
			(n) =>
				`### ${n.nodeName}\n- Error: ${n.error?.message || "Unknown"}\n${n.error?.stack ? `- Stack: ${n.error.stack.split("\n").slice(0, 5).join("\n")}` : ""}${n.inputs ? `\n- Input: ${JSON.stringify(n.inputs, null, 2).slice(0, 500)}` : ""}`,
		)
		.join("\n\n");

	const errorLogs = logs
		.filter((l) => l.level === "error" || l.level === "warn")
		.slice(-15)
		.map((l) => `  [${l.level.toUpperCase()}]${l.nodeName ? ` (${l.nodeName})` : ""} ${l.message}`)
		.join("\n");

	return `You are a workflow debugging assistant. A Blok workflow execution failed. Analyze the error and provide:
1. A clear explanation of what went wrong
2. The likely root cause
3. Suggested fixes

## Workflow Context
- Workflow: ${run.workflowName} (${run.workflowPath})
- Trigger: ${run.triggerSummary}
- Duration: ${run.durationMs ?? "N/A"}ms
- Nodes: ${run.completedNodes}/${run.nodeCount} completed

## Run Error
- Message: ${run.error?.message ?? "Unknown"}${run.error?.code ? `\n- Code: ${run.error.code}` : ""}${run.error?.stack ? `\n- Stack Trace:\n${run.error.stack}` : ""}

## Node Execution Timeline
${timeline}

${failedDetails ? `## Failed Nodes\n${failedDetails}` : ""}

${errorLogs ? `## Error/Warning Logs\n${errorLogs}` : ""}

Provide a concise, actionable explanation. Focus on the root cause and how to fix it.`;
}

async function callOpenAI(apiKey: string, model: string, prompt: string): Promise<string> {
	const response = await fetch("https://api.openai.com/v1/chat/completions", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			model,
			messages: [
				{
					role: "system",
					content:
						"You are an expert workflow debugging assistant for Blok, a workflow orchestration framework. Provide concise, actionable debugging advice. Use markdown formatting for readability.",
				},
				{ role: "user", content: prompt },
			],
			temperature: 0.3,
			max_tokens: 1500,
		}),
	});

	if (!response.ok) {
		const err = await response.json().catch(() => ({}));
		throw new Error(
			(err as { error?: { message?: string } }).error?.message || `OpenAI API returned ${response.status}`,
		);
	}

	const data = (await response.json()) as {
		choices: Array<{ message: { content: string } }>;
	};

	return data.choices[0]?.message?.content || "No explanation generated.";
}
