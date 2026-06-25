import http from "node:http";
import { DebounceCoordinator } from "../scheduling/DebounceCoordinator";
import { DeferredRunScheduler } from "../scheduling/DeferredRunScheduler";
import { WorkflowRegistry } from "../workflow/WorkflowRegistry";
import { inferSampleBody } from "../workflow/sampleBody";
import { RoutingDiagnostics } from "./RoutingDiagnostics";
import { RunTracker } from "./RunTracker";
import { METADATA_OPERATORS, isValidMetadataKey } from "./metadataFilter";
import type {
	MetadataFilter,
	MetadataOp,
	NodeRun,
	RunEvent,
	TraceLogEntry,
	WorkflowRun,
	WorkflowSummary,
} from "./types";

/**
 * Security review FW-2 — sensitive headers that are NEVER honored when
 * supplied via the replay endpoint's `overrides.headers`. Combined with
 * the FW-1 trace-auth gate, this blocks the replay-as-auth-bypass attack
 * where an unauthenticated client posts to `/__blok/runs/:id/replay`
 * with an attacker-controlled `Authorization` header that the runner
 * would otherwise dispatch verbatim to the user-authored route.
 */
const REPLAY_HEADER_DENYLIST = new Set([
	"authorization",
	"cookie",
	"set-cookie",
	"x-api-key",
	"x-auth-token",
	"proxy-authorization",
]);

function filterReplayHeaders(headers: Record<string, string> | undefined): Record<string, string> {
	if (!headers) return {};
	const filtered: Record<string, string> = {};
	for (const [k, v] of Object.entries(headers)) {
		if (REPLAY_HEADER_DENYLIST.has(k.toLowerCase())) continue;
		filtered[k] = v;
	}
	return filtered;
}

/**
 * Coerce a query-string `?limit=...` / `?offset=...` value to a clamped
 * integer. Strings parse via `Number.parseInt`; anything non-finite (or
 * outside `[min, max]`) falls back to `fallback`. Used by paginated GET
 * endpoints so Studio queries can't pin the event loop with absurd
 * window sizes.
 */
function clampInt(raw: string | undefined, min: number, max: number, fallback: number): number {
	if (typeof raw !== "string" || raw.length === 0) return fallback;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n) || Number.isNaN(n)) return fallback;
	if (n < min) return min;
	if (n > max) return max;
	return n;
}

/**
 * F2 (v0.5) — parse `metadata.<key>[__op]=<value>` query params into
 * the operator-aware `MetadataFilter[]` shape.
 *
 * Supported suffixes (`__op`): `eq` (default), `ne`, `gt`, `gte`,
 * `lt`, `lte`, `like`, `in`, `nin`. Unknown suffixes silently drop —
 * preserves the v0.4 contract that unrecognised query keys are ignored
 * rather than rejected (operators got the same treatment as the v0.4
 * key-shape validation).
 *
 * `in` / `nin` values are comma-split:
 *   `metadata.region__in=us,eu,ap` → value: ["us", "eu", "ap"]
 *
 * Keys outside `^[a-zA-Z0-9_-]+$` silently drop — same SQL-injection
 * guard the v0.4 parser already applied.
 */
function parseMetadataFiltersFromQuery(query: Record<string, string | undefined>): MetadataFilter[] | undefined {
	let filters: MetadataFilter[] | undefined;
	const opSet = new Set<string>(METADATA_OPERATORS);
	for (const [rawKey, value] of Object.entries(query)) {
		if (!rawKey.startsWith("metadata.")) continue;
		if (typeof value !== "string" || value.length === 0) continue;
		const remainder = rawKey.slice("metadata.".length);
		if (remainder.length === 0) continue;
		// Suffix split — accepts `key`, `key__op`. Multiple `__` in a
		// key name are tolerated; only the FINAL `__op` is interpreted
		// as the operator when it matches the operator set.
		const opIdx = remainder.lastIndexOf("__");
		let metaKey: string;
		let op: MetadataOp;
		if (opIdx > 0 && opSet.has(remainder.slice(opIdx + 2))) {
			metaKey = remainder.slice(0, opIdx);
			op = remainder.slice(opIdx + 2) as MetadataOp;
		} else {
			metaKey = remainder;
			op = "eq";
		}
		if (!isValidMetadataKey(metaKey)) continue;
		const parsedValue: string | string[] =
			op === "in" || op === "nin"
				? value
						.split(",")
						.map((s) => s.trim())
						.filter((s) => s.length > 0)
				: value;
		if (Array.isArray(parsedValue) && parsedValue.length === 0) continue;
		if (!filters) filters = [];
		filters.push({ key: metaKey, op, value: parsedValue });
	}
	return filters;
}

/**
 * Strip sensitive request headers from a scheduled-dispatch payload
 * before serving it to Studio. `extractDispatchPayload` already strips
 * these at PERSIST time (see `HttpTrigger.extractDispatchPayload`); we
 * re-apply the denylist on read as a belt-and-braces guard against
 * older sqlite rows that pre-date that strip path.
 */
function sanitizeDispatchPayload(payload: unknown): unknown {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
	const obj = payload as Record<string, unknown>;
	const headers = obj.headers;
	if (!headers || typeof headers !== "object" || Array.isArray(headers)) return payload;
	const filtered: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
		if (REPLAY_HEADER_DENYLIST.has(k.toLowerCase())) continue;
		filtered[k] = v;
	}
	return { ...obj, headers: filtered };
}

/**
 * Synthesize a zero-stat `WorkflowSummary` from a `WorkflowRegistry`
 * entry that has never run. Studio's sidebar consumes `/__blok/workflows`,
 * so without this merge a workflow that's registered + bound to a URL
 * but hasn't been triggered yet is invisible to the operator — they
 * have no row to click into, can't open the Graph tab, and (the bug
 * that motivated this) can't even tell the workflow exists.
 *
 * Returns `null` for middleware-only workflows (`isMiddleware: true`)
 * and for entries without a recognised trigger kind — both are
 * non-user-facing.
 */
function synthesizeRegistryOnlySummary(reg: {
	readonly name: string;
	readonly source: string;
	readonly workflow: unknown;
	readonly isMiddleware?: boolean;
}): WorkflowSummary | null {
	if (reg.isMiddleware) return null;
	const wf = reg.workflow;
	if (!wf || typeof wf !== "object") return null;
	const trigger = (wf as { trigger?: unknown }).trigger;
	if (!trigger || typeof trigger !== "object") return null;

	const triggerTypes: string[] = [];
	let primaryPath: string | undefined;
	for (const [kind, raw] of Object.entries(trigger as Record<string, unknown>)) {
		if (!raw || typeof raw !== "object") continue;
		triggerTypes.push(kind);
		if (primaryPath !== undefined) continue;
		// Pick the first identifying field that exists. Mirrors the
		// `workflow_path` column the SQL summaries return — that's the
		// runtime-set URL, here we approximate with the trigger config.
		const r = raw as Record<string, unknown>;
		if (typeof r.path === "string") primaryPath = r.path;
		else if (typeof r.queue === "string") primaryPath = r.queue;
		else if (typeof r.schedule === "string") primaryPath = r.schedule;
		else if (typeof r.topic === "string") primaryPath = r.topic;
	}

	if (triggerTypes.length === 0) return null;

	return {
		name: reg.name,
		path: primaryPath ?? "/",
		triggerTypes,
		totalRuns: 0,
		recentRuns: 0,
		errorRate: 0,
		avgDurationMs: 0,
		p95DurationMs: 0,
	};
}

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
 * Security review FW-1 — authorize hook signature for `/__blok/*` routes.
 *
 * Triggers register a function that decides whether to serve trace API
 * requests. Returning `true` allows the request; `false` (or a thrown
 * error) returns `401`. In production, the trace router refuses to serve
 * any route until an authorize hook is registered (or the operator sets
 * `BLOK_TRACE_AUTH_DISABLED=1` to opt out — typically because they've
 * firewalled `/__blok/*` separately).
 */
export type TraceAuthorizeFn = (req: TraceRequest) => Promise<boolean> | boolean;

export interface TraceRouterOptions {
	/**
	 * Authorize hook for trace API requests. See {@link TraceAuthorizeFn}.
	 * Required in production unless `BLOK_TRACE_AUTH_DISABLED=1` is set.
	 */
	authorize?: TraceAuthorizeFn;
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
 * import { registerTraceRoutes } from "@blokjs/runner";
 * const traceRouter = Router();
 * registerTraceRoutes(traceRouter, undefined, { authorize: myAuthFn });
 * app.use("/__blok", traceRouter);
 * ```
 */
export function registerTraceRoutes(router: TraceRouter, tracker?: RunTracker, options?: TraceRouterOptions): void {
	const t = tracker || RunTracker.getInstance();

	// --- CORS for cross-origin Studio UI ---
	// Security review FW-4 — `BLOK_TRACE_CORS_ORIGIN` overrides the
	// permissive `*` default. Set to a single allow-listed origin in
	// production to prevent cross-origin reads of trace data.
	const corsOrigin = process.env.BLOK_TRACE_CORS_ORIGIN || "*";

	// Security review FW-1 — production-default-deny on /__blok/* unless
	// the operator either registers an authorize hook (preferred) or
	// explicitly opts out via BLOK_TRACE_AUTH_DISABLED=1.
	const isProd = process.env.BLOK_ENV === "production" || process.env.NODE_ENV === "production";
	const authDisabled = process.env.BLOK_TRACE_AUTH_DISABLED === "1";
	const authorize = options?.authorize;

	router.use((req: TraceRequest, res: TraceResponse, next: () => void) => {
		res.setHeader("Access-Control-Allow-Origin", corsOrigin);
		res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
		res.setHeader("Access-Control-Allow-Headers", "Content-Type, Last-Event-ID");
		if (req.method === "OPTIONS") {
			res.sendStatus(204);
			return;
		}

		// Dev OR explicit opt-out → pass through (preserves previous behaviour).
		if (!isProd || authDisabled) {
			next();
			return;
		}

		// Production WITHOUT an authorize hook → 503 with a hint.
		if (!authorize) {
			res.status(503).json({
				error: "Trace endpoints require auth in production",
				hint: "Register an authorize hook before listen() — `trigger.setTraceAuth(req => ...)` — or set BLOK_TRACE_AUTH_DISABLED=1 to opt out (typically because /__blok/* is already firewalled).",
				docs: "https://github.com/deskree-inc/blok/blob/main/docs/d/security/cookbook.mdx#secure-the-trace-api-and-studio",
			});
			return;
		}

		// Production WITH an authorize hook → consult it. Wrap in
		// `Promise.resolve().then(...)` so a SYNC throw inside the
		// authorize function is caught the same as an async rejection.
		Promise.resolve()
			.then(() => authorize(req))
			.then((ok) => {
				if (ok) {
					next();
				} else {
					res.status(401).json({ error: "Unauthorized" });
				}
			})
			.catch((err) => {
				// Don't leak the underlying error message — log it once,
				// return a generic 401.
				console.error("[blok][trace-auth] authorize() threw:", (err as Error)?.message ?? err);
				res.status(401).json({ error: "Unauthorized" });
			});
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
		// E4 follow-up — `getWorkflowSummaries()` derives only from the
		// `workflow_runs` table, so workflows that have been registered
		// but never run don't show up. Studio uses this endpoint to power
		// the sidebar; without merging the registry the user has no way
		// to navigate to a workflow before it executes, including no way
		// to see its static DAG. Synthesize a zero-stat summary for
		// every registered workflow not already present.
		const seen = new Set(summaries.map((s) => s.name));
		for (const reg of WorkflowRegistry.getInstance().list()) {
			if (seen.has(reg.name)) continue;
			const synthesized = synthesizeRegistryOnlySummary(reg);
			if (synthesized) summaries.push(synthesized);
		}
		res.json(summaries);
	});

	router.get("/workflows/:name", (req: TraceRequest, res: TraceResponse) => {
		const { name } = req.params;
		const summaries = t.getWorkflowSummaries();
		let summary = summaries.find((s) => s.name === name);

		// E4 — surface the raw workflow JSON (pre-normalization) from
		// the registry so Studio can render the static DAG. Triggers
		// feed the registry at boot; if the workflow was registered
		// inline (e.g. tests with no source file) it's still here.
		const registered = WorkflowRegistry.getInstance().get(name);

		// Sidebar follow-up (#99) — if the workflow is registered but
		// has never run, `getWorkflowSummaries()` won't return a row
		// for it (SQL aggregation derives from `workflow_runs`). Fall
		// back to a synthesized zero-stat summary so Studio's detail
		// page renders + the Graph tab AND the empty-state curl example
		// are reachable on first sight.
		if (!summary && registered) {
			const synthesized = synthesizeRegistryOnlySummary(registered);
			if (synthesized) summary = synthesized;
		}

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

		// Sample-body resolution. Priority (highest first):
		//   1. Author override: `trigger.http.examples.body` in the
		//      workflow JSON (#100). Source of truth — never overridden.
		//   2. Recorded sample: captured from the first successful run
		//      when `trigger.http.recordSample: true` (option C / v0.6).
		//      Real-world body that exercised the workflow.
		//   3. Static inference: walk step references for
		//      `ctx.request.body.<path>` (#100). Heuristic placeholder.
		//   4. Empty `{}` — fallback when nothing else exists.
		// The `inferSampleBody()` helper already handles #1 vs #3; we
		// slot the recorded sample in between by overriding the `source`
		// + `body` when one exists AND the helper didn't fall through to
		// an author override.
		const inferred = registered?.workflow ? inferSampleBody(registered.workflow) : null;
		const recorded = t.getWorkflowSample(name);
		let examples: { body: unknown; source: "author" | "recorded" | "inferred" | "empty" } | undefined;
		if (inferred?.source === "author") {
			examples = { body: inferred.body, source: "author" };
		} else if (recorded) {
			examples = { body: recorded.body, source: "recorded" };
		} else if (inferred) {
			examples = { body: inferred.body, source: inferred.source };
		}

		res.json({
			...summary,
			nodeNames: Array.from(nodeNames),
			runtimes: Array.from(runtimes),
			definition: registered?.workflow,
			examples,
		});
	});

	// E4 follow-up — surface boot-time route-build errors (collisions,
	// missing paths) so Studio can render a banner on the Workflows page
	// rather than burying the issue in terminal logs. The trigger
	// populates `RoutingDiagnostics` at boot via `buildRouteTable` in
	// tolerant mode.
	router.get("/routing", (_req: TraceRequest, res: TraceResponse) => {
		const diagnostics = RoutingDiagnostics.getInstance();
		res.json({
			diagnostics: diagnostics.list(),
			count: diagnostics.count(),
			now: Date.now(),
		});
	});

	// #103 follow-up — operator-facing escape hatch for the
	// first-record-wins semantic. When the captured body is wrong / stale
	// / contains a one-off payload, deleting the sample lets the next
	// successful run re-record (only if the workflow's HTTP trigger has
	// `recordSample: true`). Studio's workflow detail page wires a
	// "Re-record sample" button to this endpoint. Returns `{ deleted:
	// true }` on success, `404` when no sample exists for the workflow.
	// JSON-rather-than-204 keeps `fetchJson()` on the client side simple
	// and mirrors the saved-filters DELETE shape.
	router.delete("/workflows/:name/sample", (req: TraceRequest, res: TraceResponse) => {
		const { name } = req.params;
		const removed = t.deleteWorkflowSample(name);
		if (!removed) {
			res.status(404).json({ error: `No recorded sample for workflow '${name}'` });
			return;
		}
		res.json({ deleted: true });
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

	// === Queues (Phase 5) ===
	//
	// Direction A · Phase 5. Honest "what's configured to receive
	// work" page — Blok's HTTP triggers are stateless (no queue depth)
	// so this view is workflow-by-trigger-type with throughput +
	// last-run timing, not a JetStream-style depth dashboard.
	// JetStream-backed worker queues will surface real depth here when
	// the NATS integration grows the capability — for now we mark
	// `depth: null` everywhere so the UI knows to show "—" instead of
	// "0".
	//
	// Query params:
	//   ?env=<name>  filter by environment scope (Phase 2.1)
	router.get("/queues", (req: TraceRequest, res: TraceResponse) => {
		const envFilter =
			typeof req.query.env === "string" && req.query.env.length > 0 && req.query.env !== "all"
				? req.query.env
				: undefined;

		// Reuse the workflow-summary aggregation; queues are workflows
		// reframed by their trigger type. Pull recent runs to compute
		// per-trigger-type throughput counts.
		const workflows = t.getWorkflowSummaries();
		const recent = t.getRuns({ limit: 500, sort: "desc" }).runs;

		// env post-filter on the recent-run window
		const recentInScope = envFilter ? recent.filter((r) => (r.environment ?? "production") === envFilter) : recent;

		// Group workflows by their first trigger type (HTTP triggers
		// dominate today; future triggers will surface in this list).
		const queues = workflows.map((w) => {
			const wfRecent = recentInScope.filter((r) => r.workflowName === w.name);
			const triggerType = w.triggerTypes[0] ?? "unknown";
			const lastRun = wfRecent[0];
			return {
				id: w.name,
				name: w.name,
				triggerType,
				triggerTypes: w.triggerTypes,
				// Stateless HTTP triggers have no queue depth; depth
				// will populate when NATS JetStream integration lands.
				depth: null as number | null,
				runs24h: wfRecent.length,
				totalRuns: w.totalRuns,
				lastRunAt: lastRun?.startedAt ?? w.lastRunAt,
				lastRunStatus: lastRun?.status ?? w.lastRunStatus,
				avgDurationMs: w.avgDurationMs,
				errorRate: w.errorRate,
			};
		});

		res.json({ queues, total: queues.length, env: envFilter ?? null });
	});

	// === Deployments (Phase 5) ===
	//
	// Read-only "what versions are running where" view. Blok workflows
	// declare a `version` string in their definition; we group runs by
	// `workflowName + version` and report counts + success rate per
	// pair. Studio lists these as "what's deployed", and clicking a
	// row drills into the workflow's runs filtered to that version.
	//
	// Source: scan recent run metadata. Workflow versions live in the
	// trigger's workflow registry but the runner doesn't keep that
	// catalog at this layer — recent runs are the source of truth for
	// "what version produced what trace".
	router.get("/deployments", (req: TraceRequest, res: TraceResponse) => {
		const envFilter =
			typeof req.query.env === "string" && req.query.env.length > 0 && req.query.env !== "all"
				? req.query.env
				: undefined;
		const limit = Math.min(Number.parseInt(req.query.limit || "500", 10), 2000);

		const runs = t.getRuns({ limit, sort: "desc" }).runs;
		const inScope = envFilter ? runs.filter((r) => (r.environment ?? "production") === envFilter) : runs;

		// Group by `workflowName::version`. Version is read from the
		// run's metadata if present, else "unknown" so the row still
		// surfaces.
		const buckets = new Map<
			string,
			{
				workflowName: string;
				version: string;
				environment: string;
				runs: number;
				succeeded: number;
				failed: number;
				lastRunAt: number;
				firstRunAt: number;
				avgDurationMs: number;
				_durationSum: number;
			}
		>();

		for (const run of inScope) {
			const version = (run.metadata?.version as string | undefined) ?? "unknown";
			const env = run.environment ?? "production";
			const key = `${run.workflowName}::${version}::${env}`;
			let b = buckets.get(key);
			if (!b) {
				b = {
					workflowName: run.workflowName,
					version,
					environment: env,
					runs: 0,
					succeeded: 0,
					failed: 0,
					lastRunAt: 0,
					firstRunAt: run.startedAt,
					avgDurationMs: 0,
					_durationSum: 0,
				};
				buckets.set(key, b);
			}
			b.runs += 1;
			if (run.status === "completed") b.succeeded += 1;
			if (run.status === "failed") b.failed += 1;
			if (run.startedAt > b.lastRunAt) b.lastRunAt = run.startedAt;
			if (run.startedAt < b.firstRunAt) b.firstRunAt = run.startedAt;
			if (run.durationMs) b._durationSum += run.durationMs;
		}

		const deployments = [...buckets.values()].map((b) => {
			const { _durationSum, ...rest } = b;
			return {
				...rest,
				avgDurationMs: b.runs > 0 ? Math.round(_durationSum / b.runs) : 0,
				successRate: b.runs > 0 ? b.succeeded / b.runs : 0,
			};
		});
		deployments.sort((a, b) => b.lastRunAt - a.lastRunAt);

		res.json({ deployments, total: deployments.length, env: envFilter ?? null });
	});

	// === Logs (cross-run aggregator) ===
	//
	// Direction A · Phase 3 · the page that doesn't exist in current
	// Studio. Aggregates `TraceLogEntry`s across recent runs into a
	// flat feed so operators can grep across workflows during an
	// incident without having to know which run-id to open.
	//
	// Pagination is deliberately simple — `limit` + `since` (epoch ms)
	// with `desc` sort. We over-fetch from the store (limit*4 runs ×
	// up-to-N logs each) and apply filters in memory because the
	// underlying log store doesn't have an indexed multi-key query.
	// At ≤1000 rows this stays well under 50ms even on the in-memory
	// backend; SQLite can be similarly fast since each `getLogs(runId)`
	// is a single indexed query. When the cap is reached, the response
	// signals truncation via `truncated: true` so the client can prompt
	// for narrower filters.
	//
	// Query params (all optional):
	//   ?workflow=<name>                exact match
	//   ?level=info,warn,error,debug    comma-separated
	//   ?q=<text>                       case-insensitive substring of message
	//   ?since=<epoch ms>               only logs newer than this
	//   ?limit=<int>                    max rows returned, default 200, cap 1000
	router.get("/logs", (req: TraceRequest, res: TraceResponse) => {
		const workflowFilter =
			typeof req.query.workflow === "string" && req.query.workflow.length > 0 ? req.query.workflow : undefined;
		const levelFilter = (() => {
			if (typeof req.query.level !== "string" || req.query.level.length === 0) return undefined;
			return new Set(req.query.level.split(",").map((s: string) => s.trim().toLowerCase()));
		})();
		const qRaw = typeof req.query.q === "string" ? req.query.q.trim() : "";
		const q = qRaw.length > 0 ? qRaw.toLowerCase() : undefined;
		const since = req.query.since ? Number.parseInt(req.query.since, 10) : undefined;
		const limit = Math.min(Number.parseInt(req.query.limit || "200", 10), 1000);
		// Phase 2.1 · environment scoping. Default `production` matches
		// SqliteRunStore.rowToRun's NULL → "production" mapping so legacy
		// runs still surface under the default scope.
		const envFilter =
			typeof req.query.env === "string" && req.query.env.length > 0 && req.query.env !== "all"
				? req.query.env
				: undefined;

		// Pull recent runs so we can flatten their logs. We over-pull
		// (limit*4 runs cap'd at 200) so a noisy run with 50+ logs
		// doesn't crowd out logs from quieter neighbors.
		const runs = t.getRuns({ limit: Math.min(limit * 4, 200), sort: "desc" }).runs;
		const matches: Array<{
			id: string;
			runId: string;
			workflowName: string;
			workflowPath: string;
			nodeId: string | undefined;
			nodeName: string | undefined;
			level: string;
			message: string;
			timestamp: number;
			data: unknown;
		}> = [];
		let truncated = false;

		outer: for (const run of runs) {
			if (workflowFilter && run.workflowName !== workflowFilter) continue;
			if (envFilter && (run.environment ?? "production") !== envFilter) continue;
			const logs = t.getLogs(run.id);
			for (const log of logs) {
				if (since !== undefined && log.timestamp <= since) continue;
				if (levelFilter && !levelFilter.has(log.level)) continue;
				if (q && !log.message.toLowerCase().includes(q)) continue;
				matches.push({
					id: log.id,
					runId: run.id,
					workflowName: run.workflowName,
					workflowPath: run.workflowPath,
					nodeId: log.nodeId,
					nodeName: log.nodeName,
					level: log.level,
					message: log.message,
					timestamp: log.timestamp,
					data: log.data,
				});
				if (matches.length >= limit) {
					truncated = true;
					break outer;
				}
			}
		}

		matches.sort((a, b) => b.timestamp - a.timestamp);
		res.json({
			logs: matches,
			total: matches.length,
			truncated,
			query: { workflow: workflowFilter, level: req.query.level, q: qRaw, since, limit },
		});
	});

	// === Run Endpoints ===

	router.get("/runs", (req: TraceRequest, res: TraceResponse) => {
		const workflow = req.query.workflow;
		const status = req.query.status;
		const tags = req.query.tags ? req.query.tags.split(",").map((t: string) => t.trim()) : undefined;
		// F2 (v0.5) — `metadata.<key>[__op]=<value>` query params parsed
		// into a `MetadataFilter[]` for the RunQuery filter. Multiple
		// pairs combine with AND semantics.
		//
		// Examples:
		//   metadata.tier=premium             → {key: "tier", op: "eq", value: "premium"}
		//   metadata.tier__ne=free            → {key: "tier", op: "ne", value: "free"}
		//   metadata.count__gt=10             → {key: "count", op: "gt", value: "10"}
		//   metadata.region__in=us,eu         → {key: "region", op: "in", value: ["us","eu"]}
		//   metadata.name__like=test%         → {key: "name", op: "like", value: "test%"}
		//
		// Keys are restricted by the SqliteRunStore implementation
		// (`/^[a-zA-Z0-9_-]+$/`) for JSON path safety; non-matching keys
		// or unknown operators silently drop.
		const metadata = parseMetadataFiltersFromQuery(req.query as Record<string, string | undefined>);
		const limit = Number.parseInt(req.query.limit || "50", 10);
		const offset = Number.parseInt(req.query.offset || "0", 10);
		const sort = (req.query.sort as "asc" | "desc") || "desc";
		// Phase 2.1 · environment scoping. Same post-filter pattern as
		// `categoryFilter` below: applied after `getRuns()` returns so it
		// works against any store (SQLite has the column; InMemory just
		// stores the object). Empty string + "all" both bypass the
		// filter (Studio's EnvChip can dispatch a "show all envs"
		// view in a follow-up).
		const envFilter =
			typeof req.query.env === "string" && req.query.env.length > 0 && req.query.env !== "all"
				? req.query.env
				: undefined;
		// Master plan §17.10: optional category filter. The filter is
		// applied AFTER `getRuns()` returns so it works against any
		// store backend (in-memory, sqlite, postgres) without a schema
		// change. The trade-off is that pagination math now reflects
		// the post-filter count, not the underlying store count — this
		// is the right behavior for a UI filter (the user sees "12
		// dependency failures" not "12 of 1247 runs that happen to be
		// dependency failures").
		const categoryFilter =
			typeof req.query.category === "string" && req.query.category.length > 0
				? req.query.category.toUpperCase()
				: undefined;

		// Combined filter mode — when EITHER category OR env post-filters
		// are active we have to over-fetch + re-paginate after applying
		// them.
		const needsPostFilter = Boolean(categoryFilter || envFilter);
		const result = t.getRuns({
			workflow,
			status: status as "running" | "completed" | "failed" | undefined,
			tags,
			metadata,
			limit: needsPostFilter ? Math.max(limit, 1000) : limit,
			offset: needsPostFilter ? 0 : offset,
			sort,
		});

		let runs = result.runs;
		let total = result.total;
		if (categoryFilter) {
			runs = runs.filter((r) => {
				const category = r.error?.category;
				return typeof category === "string" && category.toUpperCase() === categoryFilter;
			});
			total = runs.length;
		}
		if (envFilter) {
			// Default `production` for legacy rows where env is NULL —
			// matches the SqliteRunStore.rowToRun default.
			runs = runs.filter((r) => (r.environment ?? "production") === envFilter);
			total = runs.length;
		}
		if (needsPostFilter) {
			runs = runs.slice(offset, offset + limit);
		}

		res.json({
			runs,
			total,
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

	/**
	 * Tier 2 · sub-workflow lineage. Returns the runs that were started
	 * by `subworkflow:` steps inside the given parent run. Studio renders
	 * these as a "Sub-runs" list on the parent's run detail page.
	 */
	router.get("/runs/:runId/subruns", (req: TraceRequest, res: TraceResponse) => {
		const { runId } = req.params;
		const run = t.getRun(runId);
		if (!run) {
			res.status(404).json({ error: `Run '${runId}' not found` });
			return;
		}
		const subruns = t.getRunsByParent(runId);
		res.json(subruns);
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
		// Security review FW-2 — strip sensitive headers from overrides
		// BEFORE merging, then layer the framework-controlled headers
		// LAST so an attacker can't replace `X-Blok-Replay-Of`.
		const safeOverrideHeaders = filterReplayHeaders(overrides.headers as Record<string, string>);
		const customHeaders: Record<string, string> = {
			"Content-Type": "application/json",
			...safeOverrideHeaders,
			// Tier 1 · replay lineage. TriggerBase reads this header and threads
			// it into `tracker.startRun({ replayOf })`, which persists onto the
			// new run's WorkflowRun.replayOf field. Studio renders a
			// "Replay of #..." breadcrumb that links back to the source run.
			"X-Blok-Replay-Of": runId,
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
				// Tier 1 · explicit lineage in the API response so Studio
				// doesn't have to fetch the new run separately to confirm
				// the replay relationship.
				replayOf: runId,
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

	// === Concurrency observability (Tier 2 follow-up) ===

	/**
	 * Concurrency backend health probe. Returns the configured backend
	 * (`"in-process"` when none) and basic state. Useful for k8s-style
	 * health checks AND Studio's "Backend status" tile.
	 *
	 * GET /__blok/concurrency/health
	 */
	router.get("/concurrency/health", (_req: TraceRequest, res: TraceResponse) => {
		res.json({
			backend: "in-process",
			disabled: process.env.BLOK_CONCURRENCY_DISABLED === "1",
			leaseMs: process.env.BLOK_CONCURRENCY_LEASE_MS ? Number(process.env.BLOK_CONCURRENCY_LEASE_MS) : 60 * 60 * 1000,
		});
	});

	/**
	 * Snapshot of currently in-flight concurrency slots, grouped by
	 * (workflowName, concurrencyKey) bucket. Powers Studio's per-key
	 * in-flight tile.
	 *
	 * GET /__blok/concurrency/state
	 */
	router.get("/concurrency/state", (_req: TraceRequest, res: TraceResponse) => {
		const buckets = t.getStore().getConcurrencySnapshot(Date.now());
		const totalLeases = buckets.reduce((sum, b) => sum + b.leases.length, 0);
		res.json({
			totalBuckets: buckets.length,
			totalLeases,
			buckets: buckets.map((b) => ({
				workflowName: b.workflowName,
				concurrencyKey: b.concurrencyKey,
				inFlight: b.leases.length,
				leases: b.leases,
			})),
		});
	});

	/**
	 * List pending scheduled dispatches — rows from `scheduled_dispatches`
	 * that haven't fired yet (delayed / queued / debounced). Powers
	 * Studio's "Scheduled runs" view (E1) so operators can see + cancel
	 * inbound dispatches BEFORE they execute.
	 *
	 * Already-fired runs are pruned from this table the moment
	 * `dispatchDeferred` re-enters; expired runs are pruned by the
	 * Janitor sweep. To see those, use `/__blok/runs?status=expired` /
	 * `?status=completed` / etc. against `workflow_runs`.
	 *
	 * GET /__blok/scheduled
	 *
	 * Query params:
	 *   - `status` — comma-separated list of `delayed`/`queued`/`debounced`.
	 *     When omitted, returns all three.
	 *   - `workflowName` — exact-match filter.
	 *   - `limit` — pagination cap (default 100, max 500).
	 *   - `offset` — pagination offset (default 0).
	 *
	 * Returns:
	 *   `{ rows: ScheduledDispatchRow[], total: number, now: number }`
	 *   `now` is the server-side `Date.now()` snapshot so the client can
	 *   render accurate "fires in 27s" countdowns without clock skew.
	 */
	router.get("/scheduled", (req: TraceRequest, res: TraceResponse) => {
		const query = (req.query ?? {}) as Record<string, string | undefined>;
		const validStatuses = new Set(["delayed", "queued", "debounced"]);

		const requestedStatuses = (query.status ?? "")
			.split(",")
			.map((s) => s.trim())
			.filter((s) => s.length > 0 && validStatuses.has(s));
		const statusesToReturn = requestedStatuses.length > 0 ? requestedStatuses : ["delayed", "queued", "debounced"];

		// Pull each requested status separately — the underlying
		// `getScheduledDispatches({status})` only accepts a single status
		// string. Concatenate + sort by scheduledAt ASC so the soonest
		// next-fire is at the top of the table.
		const store = t.getStore();
		const allRows = statusesToReturn.flatMap((status) =>
			store.getScheduledDispatches({ status: status as "delayed" | "queued" | "debounced" }),
		);

		const workflowFilter = typeof query.workflowName === "string" ? query.workflowName : undefined;
		const filtered = workflowFilter ? allRows.filter((r) => r.workflowName === workflowFilter) : allRows;
		filtered.sort((a, b) => a.scheduledAt - b.scheduledAt);

		// Pagination — the underlying store does full scans today; cap at
		// 500 so a runaway query can't pin the event loop.
		const limit = clampInt(query.limit, 1, 500, 100);
		const offset = clampInt(query.offset, 0, Number.MAX_SAFE_INTEGER, 0);
		const page = filtered.slice(offset, offset + limit);

		// Sensitive headers are already stripped at persist time
		// (see `extractDispatchPayload` in HttpTrigger). Re-strip on read
		// too as a belt-and-braces measure — operators should never see
		// `authorization` / `cookie` / `x-api-key` in the Studio UI.
		const sanitized = page.map((row) => ({ ...row, payload: sanitizeDispatchPayload(row.payload) }));

		res.json({
			rows: sanitized,
			total: filtered.length,
			now: Date.now(),
		});
	});

	// === Cancellation (Tier 2 polish) ===

	/**
	 * Cancel a pending (delayed/debounced/queued) run before it executes.
	 *
	 * `POST /__blok/runs/:runId/cancel`
	 *
	 * Returns:
	 * - `200 { cancelled: true, runId, previousStatus, newStatus: "cancelled" }` on success
	 * - `400 { error }` when the run isn't in a cancellable state
	 *   (running/completed/failed/throttled/expired/crashed/timedOut/cancelled)
	 * - `404 { error }` when the runId doesn't exist
	 *
	 * Cancels the underlying scheduler entry (`DeferredRunScheduler` for
	 * delayed/queued runs; `DebounceCoordinator` for debounced trailing-mode
	 * runs) AND flips the run's status to `"cancelled"` via
	 * `tracker.cancelRun(runId)`. Both scheduler `.cancel()` methods are
	 * idempotent so calling them on a runId that doesn't have a pending
	 * timer is a safe no-op.
	 */
	router.post("/runs/:runId/cancel", (req: TraceRequest, res: TraceResponse) => {
		const { runId } = req.params;
		const run = t.getRun(runId);

		if (!run) {
			res.status(404).json({ error: `Run '${runId}' not found` });
			return;
		}

		// Tier 2 follow-up · "running" added so cooperative AbortSignal
		// cancellation can flip in-flight runs to `cancelled` via
		// `tracker.abortRunningRun(runId)`. Other terminal states
		// (completed/failed/throttled/expired/crashed/timedOut) remain
		// non-cancellable.
		const cancellable = ["delayed", "debounced", "queued", "running"];
		if (!cancellable.includes(run.status)) {
			res.status(400).json({
				error: `Cannot cancel run in '${run.status}' state. Only runs in 'delayed', 'debounced', 'queued', or 'running' state can be cancelled.`,
				runId,
				status: run.status,
			});
			return;
		}

		// Capture previousStatus BEFORE cancelRun mutates the run record.
		const previousStatus = run.status;

		// Tier 2 follow-up · running runs use cooperative AbortSignal.
		// `abortRunningRun` fires the controller AND flips status via
		// cancelRun in one atomic-feeling call. Returns 200 — the
		// in-flight step's between-step check will throw shortly.
		if (run.status === "running") {
			const aborted = t.abortRunningRun(runId);
			if (!aborted) {
				// No registered controller — likely a stale state where
				// the run is mid-finalization. Still return success since
				// the run is on its way to terminal anyway.
				res.json({
					cancelled: true,
					runId,
					previousStatus,
					newStatus: "cancelled",
					note: "No active AbortController; run will reach terminal state naturally.",
				});
				return;
			}
			res.json({
				cancelled: true,
				runId,
				previousStatus,
				newStatus: "cancelled",
				note: "Cancellation initiated via AbortSignal; in-flight step will abort cooperatively.",
			});
			return;
		}

		// Best-effort scheduler cleanup (both methods are idempotent).
		DeferredRunScheduler.getInstance().cancel(runId);
		if (run.debounceKey) {
			// Tier C #1 — `cancel()` is now async because the coordinator may
			// route through a cross-process backend. Fire-and-forget: the
			// HTTP response shouldn't block on broker cleanup, and the
			// run-status flip below is the source of truth for the caller.
			void DebounceCoordinator.getInstance()
				.cancel(run.workflowName, run.debounceKey)
				.catch((err: unknown) => {
					console.warn(
						`[blok][scheduling] debounce cancel failed for ${run.workflowName}:${run.debounceKey}: ${err instanceof Error ? err.message : String(err)}`,
					);
				});
		}

		const cancelled = t.cancelRun(runId);
		if (!cancelled) {
			// Race: status changed between our check and the call.
			res.status(409).json({
				error: `Could not cancel run '${runId}'. It may have just transitioned to a non-cancellable state.`,
				runId,
			});
			return;
		}

		res.json({
			cancelled: true,
			runId,
			previousStatus,
			newStatus: "cancelled",
		});
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

	// === Saved filters (E2) ===

	/**
	 * List every saved filter. Newest-updated first so the dropdown
	 * surfaces recently-edited presets at the top.
	 * GET /__blok/saved-filters
	 */
	router.get("/saved-filters", (_req: TraceRequest, res: TraceResponse) => {
		res.json({ filters: t.listSavedFilters() });
	});

	/**
	 * Upsert a saved filter. `name` is the unique key — re-posting with
	 * the same name overwrites the existing entry (preserves `id` +
	 * `createdAt`). Studio uses this to replace the localStorage
	 * `saveFilter()` call.
	 * POST /__blok/saved-filters
	 * Body: { name, status, tagsInput, metadataInput }
	 */
	router.post("/saved-filters", (req: TraceRequest, res: TraceResponse) => {
		const body = (req.body || {}) as {
			name?: unknown;
			status?: unknown;
			tagsInput?: unknown;
			metadataInput?: unknown;
		};

		const name = typeof body.name === "string" ? body.name.trim() : "";
		if (name.length === 0) {
			res.status(400).json({ error: "Saved-filter `name` is required" });
			return;
		}

		const now = Date.now();
		const persisted = t.upsertSavedFilter({
			id: `sf_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
			name,
			status: typeof body.status === "string" ? body.status : "",
			tagsInput: typeof body.tagsInput === "string" ? body.tagsInput : "",
			metadataInput: typeof body.metadataInput === "string" ? body.metadataInput : "",
			createdAt: now,
			updatedAt: now,
		});

		res.status(201).json(persisted);
	});

	/**
	 * Delete a saved filter by name. Returns `404` when the row didn't
	 * exist (so the Studio mutation can disambiguate). Uses the name
	 * (not the id) so the Studio component — which knows the name from
	 * the dropdown — doesn't need a round-trip to learn the id first.
	 * DELETE /__blok/saved-filters/:name
	 */
	router.delete("/saved-filters/:name", (req: TraceRequest, res: TraceResponse) => {
		const removed = t.deleteSavedFilter(req.params.name);
		if (!removed) {
			res.status(404).json({ error: `Saved filter '${req.params.name}' not found` });
			return;
		}
		res.json({ deleted: true });
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
