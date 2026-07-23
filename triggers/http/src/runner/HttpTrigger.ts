import type { Server } from "node:http";
import * as path from "node:path";
import { workflow } from "@blokjs/helper";
import type { TriggerOpts } from "@blokjs/helper";
import type { GlobalOptions, HMREvent, ParamsDictionary, TriggerResponse } from "@blokjs/runner";
import { TriggerBase } from "@blokjs/runner";
import { NodeMap } from "@blokjs/runner";
import { DefaultLogger } from "@blokjs/runner";
import { registerTraceRoutes } from "@blokjs/runner";
import { RoutingDiagnostics } from "@blokjs/runner";
import { RuntimeRegistry, WorkflowRegistry } from "@blokjs/runner";
import { ConcurrencyLimitError } from "@blokjs/runner";
import { QueueExpiredError } from "@blokjs/runner";
import { ConcurrencyMetrics } from "@blokjs/runner";
import { bootstrapTracing } from "@blokjs/runner";
import { DeferredDispatchSignal } from "@blokjs/runner";
import { DeferredRunScheduler, getSchedulerClaimLeaseMs } from "@blokjs/runner";
import { Janitor } from "@blokjs/runner";
import { PayloadTooLargeError } from "@blokjs/runner";
import { RunTracker } from "@blokjs/runner";
import { traceRedactSensitive } from "@blokjs/runner";
import type { TraceAuthorizeFn } from "@blokjs/runner";
import type { ScheduledDispatchRow } from "@blokjs/runner";
import type { NodeBase } from "@blokjs/shared";
import { type Context, GlobalError, type RequestContext, type StreamContext } from "@blokjs/shared";
import type { HttpBindings } from "@hono/node-server";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import {
	type Counter,
	type Span,
	SpanKind,
	SpanStatusCode,
	context,
	metrics,
	propagation,
	trace,
} from "@opentelemetry/api";
import { Hono, type Context as HonoContext } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { v4 as uuid } from "uuid";
import apps from "../AppRoutes";
import nodes from "../Nodes";
import workflows from "../Workflows";
import { createTraceRouterAdapter } from "./HonoTraceRouterAdapter";
import MessageDecode from "./MessageDecode";
import { handleDynamicRoute, validateRoute } from "./Util";
import {
	type ManualRegistration,
	type RouteCollision,
	type RouteEntry,
	buildRouteTable,
	readMiddlewareFlag,
} from "./WorkflowRouter";
import { bootstrapMetrics } from "./metrics/opentelemetry_metrics";
import { buildNodeCatalog } from "./nodeCatalog";
import { emitWorkflowResponse, normalizeResponseEnvelope } from "./responseEmitter";
import { scanWorkflows } from "./scanWorkflows";
import NodeTypes from "./types/NodeTypes";
import type RuntimeWorkflow from "./types/RuntimeWorkflow";
import type WorkflowRequest from "./types/WorkflowRequest";

/**
 * v0.7 — exported so sibling triggers (WebSocket / SSE / Webhook) can
 * construct a `Hono<AppBindings>` instance externally and pass it into
 * HttpTrigger via the optional constructor argument. The single shared
 * app then routes HTTP, WS upgrades, SSE streams, and webhook POSTs on
 * one TCP port via Hono's path-routing tree.
 *
 * Kept as a public type rather than an internal so the orchestrator
 * pattern documented in [additional-triggers-plan.mdx](../../../../docs/c/devtools/additional-triggers-plan.mdx#server-architecture)
 * remains type-safe end-to-end.
 */
export type AppBindings = { Bindings: HttpBindings };

/**
 * v0.6 — file-based routing is ON by default. Operators opt OUT via
 * either:
 *   - `BLOK_FILE_BASED_ROUTING=false` — explicit kill switch.
 *   - `BLOK_ROUTING_LEGACY=1` / `=true` — full legacy mode (also
 *     re-enables the filename-derived URL fallback for path-less
 *     workflows in `WorkflowRouter.buildRouteTable`).
 *
 * The `BLOK_ROUTES=v2` opt-in is kept as a no-op for back-compat
 * (it's the historical alias for "explicit routing on").
 *
 * Both opt-outs are deprecated and will be removed in a future
 * release; the boot log surfaces a loud warning when either is set.
 */
export function isFileBasedRoutingEnabled(): boolean {
	const explicitFalse = process.env.BLOK_FILE_BASED_ROUTING === "false";
	const legacyFlag = process.env.BLOK_ROUTING_LEGACY === "1" || process.env.BLOK_ROUTING_LEGACY === "true";
	if (explicitFalse || legacyFlag) return false;
	return true;
}

/**
 * Read a workflow object's `name`, covering both shapes: a JSON / raw object
 * literal carries `name` on the root, while a v2 `workflow()` builder carries
 * it on the nested `_config`. Returns `undefined` when neither is a string.
 */
function readWorkflowName(wf: unknown): string | undefined {
	if (!wf || typeof wf !== "object") return undefined;
	const w = wf as { name?: unknown; _config?: { name?: unknown } };
	if (typeof w.name === "string") return w.name;
	if (typeof w._config?.name === "string") return w._config.name;
	return undefined;
}

/**
 * F8 — does a workflow object expose an `http` trigger block? Reads both the
 * root `trigger` (JSON / raw object literals) and `_config.trigger` (v2
 * `workflow()` builders). Used to gate the `/__blok/rpc/:name` mount so only
 * http-callable workflows run via RPC: a worker/cron-only workflow registered
 * for sub-workflow lookup must NOT be reachable (and middleware-resolvable as
 * http) over HTTP. Mirrors the route table's `extractHttpTrigger` filter.
 */
function hasHttpTrigger(wf: unknown): boolean {
	if (!wf || typeof wf !== "object") return false;
	const obj = wf as { trigger?: unknown; _config?: { trigger?: unknown } };
	const trigger = (obj.trigger ?? obj._config?.trigger) as Record<string, unknown> | undefined;
	if (!trigger || typeof trigger !== "object") return false;
	const http = (trigger as Record<string, unknown>).http;
	return !!http && typeof http === "object";
}

async function resolveManualRegistrations(workflowsMap: Record<string, unknown>): Promise<ManualRegistration[]> {
	return Promise.all(
		Object.keys(workflowsMap ?? {}).map(async (key) => ({
			key,
			workflow: await workflowsMap[key],
		})),
	);
}

async function resolveManualWorkflowMap(workflowsMap: Record<string, unknown>): Promise<Record<string, unknown>> {
	const entries = await resolveManualRegistrations(workflowsMap);
	return Object.fromEntries(entries.map(({ key, workflow }) => [key, workflow]));
}

/**
 * OBS-06 (T9) — pre-run boot failures. When `Configuration.init` (workflow
 * parse / node resolution / runtime registry) or the middleware-chain resolver
 * throws BEFORE `this.run()` reaches `tracker.startRun()`, the failure is a
 * config/deploy problem, not workflow logic — but it surfaced only as a generic
 * 500 with no distinct metric (`blok_workflow_errors_total` fires inside the
 * run, which never started, so it never sees a boot failure). This counter
 * separates "the workflow couldn't even boot" from "a step threw", so an alert
 * can page on deploy/config breakage distinctly. Lazily created once so it binds
 * to the trigger's MeterProvider; the wrap re-throws, so behaviour is unchanged.
 */
let _bootErrorCounter: Counter | null = null;
function recordBootError(phase: "configuration_init" | "middleware", err: unknown): void {
	if (!_bootErrorCounter) {
		_bootErrorCounter = metrics.getMeter("blok").createCounter("blok_boot_error_total", {
			description: "Workflow boot failures before the run started (config/middleware resolution)",
			unit: "1",
		});
	}
	const error_class = err instanceof Error && err.name ? err.name : "Error";
	_bootErrorCounter.add(1, { trigger_type: "http", phase, error_class });
}

/** Test-only: drop the cached counter so a fresh MeterProvider is picked up. */
export function _resetBootErrorCounterForTests(): void {
	_bootErrorCounter = null;
}

export default class HttpTrigger extends TriggerBase {
	/** ADR 0015 — HTTP request bodies are the caller input the `input` schema describes. */
	protected validatesDeclaredInput(): boolean {
		return true;
	}

	private app: Hono<AppBindings>;
	private port: string | number = process.env.PORT || 4000;
	private initializer = 0;
	private nodeMap: GlobalOptions = <GlobalOptions>{};
	private server: Server | null = null;

	/**
	 * v0.7 — callbacks registered by sibling same-port triggers (e.g.
	 * `WebSocketTrigger`) that need access to the `http.Server` instance
	 * AFTER `serve()` resolves. Run in registration order inside the
	 * `serve()` ready callback. Errors caught + logged (don't bring the
	 * server down on a hook failure). See
	 * [additional-triggers-plan.mdx](../../../../docs/c/devtools/additional-triggers-plan.mdx#server-architecture)
	 * for why this hook exists.
	 */
	private serverHooks: Array<(server: Server) => void | Promise<void>> = [];

	/**
	 * v0.7 — callbacks that run during `listen()` AFTER the workflow
	 * registry is populated but BEFORE the legacy catch-all route is
	 * registered on the Hono app. Sibling triggers (`WebSocketTrigger`,
	 * the upcoming `SSETrigger`) that mount path-specific routes on the
	 * shared app use this hook so their routes are matched FIRST — if we
	 * registered them after the catch-all, Hono would dispatch
	 * `/ws/<path>` requests through the workflow lookup path instead of
	 * the upgrade handler.
	 *
	 * Hooks are async-friendly; errors are caught + logged.
	 */
	private preCatchAllHooks: Array<() => void | Promise<void>> = [];
	protected tracer = trace.getTracer(
		process.env.PROJECT_NAME || "trigger-http-workflow",
		process.env.PROJECT_VERSION || "0.0.1",
	);
	private logger = new DefaultLogger();

	/**
	 * Security review FW-1 — operator-supplied authorize hook for the
	 * `/__blok/*` trace API + Studio backend. In production the trace
	 * router refuses to serve any route until this is registered (or
	 * the operator sets `BLOK_TRACE_AUTH_DISABLED=1`). See
	 * docs/d/security/cookbook.mdx#secure-the-trace-api-and-studio.
	 */
	private traceAuthFn: TraceAuthorizeFn | undefined;

	/** OBS-02 — graceful shutdown for the OTel tracer provider, if tracing was enabled. */
	private tracingShutdown: (() => Promise<void>) | null = null;

	/**
	 * Register the authorize hook for `/__blok/*` (Blok Studio + trace
	 * API). Call before {@link listen}.
	 *
	 * In `BLOK_ENV=production` (or `NODE_ENV=production`), the trace
	 * router returns `503` until this is registered or
	 * `BLOK_TRACE_AUTH_DISABLED=1` is set.
	 *
	 * @param authorize  Function that returns `true` to allow a trace
	 *                   API request, `false` (or throws) to reject with
	 *                   `401`. Sees the raw request including method,
	 *                   path, headers, query, and body.
	 */
	public setTraceAuth(authorize: TraceAuthorizeFn): void {
		this.traceAuthFn = authorize;
	}

	/**
	 * v0.7 — register a callback to run after the HTTP server is ready
	 * (after `serve()` resolves). The callback receives the underlying
	 * `http.Server` instance.
	 *
	 * Used by sibling same-port triggers — most notably `WebSocketTrigger`
	 * which calls `@hono/node-ws`'s `injectWebSocket(server)` to attach
	 * its `upgrade` event listener to the same server.
	 *
	 * Hooks run in registration order. Errors are caught and logged so a
	 * misbehaving hook doesn't bring the server down. Call BEFORE
	 * `listen()`.
	 *
	 * @param cb  Receives the bound `http.Server`. Sync or async.
	 */
	public addServerHook(cb: (server: Server) => void | Promise<void>): void {
		this.serverHooks.push(cb);
	}

	/**
	 * v0.7 — register a callback that fires during `listen()` AFTER the
	 * workflow registry is populated but BEFORE the catch-all workflow
	 * route is mounted. Sibling triggers that mount explicit Hono routes
	 * on the shared app (WebSocketTrigger's upgrade endpoints, the
	 * upcoming SSETrigger's stream endpoints) call this so their routes
	 * win over the catch-all `/:workflow{.+}` matcher. Call BEFORE
	 * `listen()`.
	 */
	public addPreCatchAllHook(cb: () => void | Promise<void>): void {
		this.preCatchAllHooks.push(cb);
	}

	/**
	 * @param app  v0.7 — optional pre-constructed Hono app. When provided,
	 *             HttpTrigger registers its HTTP routes onto the shared
	 *             app instead of constructing its own. This is the entry
	 *             point for the same-port multiplex pattern documented in
	 *             [additional-triggers-plan.mdx](../../../../docs/c/devtools/additional-triggers-plan.mdx#server-architecture):
	 *             an orchestrator builds ONE Hono app, threads it into
	 *             every same-port trigger (HTTP + future WebSocket / SSE /
	 *             Webhook), and the HTTP trigger's `serve()` call hosts
	 *             everything on port 4000.
	 *
	 *             When omitted, HttpTrigger constructs its own app
	 *             (existing v0.6 behavior, fully backward-compatible).
	 */
	constructor(app?: Hono<AppBindings>) {
		super();

		this.app = app ?? new Hono<AppBindings>();
		this.initializer = this.startCounter();
		this.loadNodes();
		this.loadWorkflows();
	}

	loadNodes() {
		this.nodeMap.nodes = new NodeMap();
		// Register every node under its OWN `node.name` (the canonical `use:` ref
		// per ADR 0002) — the `Nodes.ts` map keys are cosmetic and the collision
		// guard (NodeMap.addNode) catches two nodes claiming one ref. `Nodes.ts`
		// auto-discovers local `src/nodes/` (top-level await + `discoverNodes`,
		// #360) and only hand-lists the third-party npm nodes, so the map values
		// are the single source of truth. HMR re-runs THIS same keying path.
		this.nodeMap.nodes.addNodes(Object.values(nodes) as unknown as NodeBase[]);
	}

	loadWorkflows() {
		this.nodeMap.workflows = workflows as unknown as GlobalOptions["workflows"];
	}

	/**
	 * Gracefully stop the HTTP server, waiting for in-flight requests to complete.
	 */
	async stop(): Promise<void> {
		await this.waitForInFlightRequests();
		if (this.tracingShutdown) {
			// Flush pending spans before exit so the last requests aren't lost.
			await this.tracingShutdown().catch((err) =>
				this.logger.error(`[blok][tracing] shutdown failed: ${(err as Error).message}`),
			);
			this.tracingShutdown = null;
		}
		return new Promise<void>((resolve) => {
			if (this.server) {
				this.server.close(() => {
					this.server = null;
					resolve();
				});
			} else {
				resolve();
			}
		});
	}

	/**
	 * OBS-02 — install the OpenTelemetry SDK at boot when an OTLP endpoint is
	 * configured, so the spans the runner already creates export to a backend
	 * (Tempo/Jaeger/…). No-op when `OTEL_EXPORTER_OTLP_ENDPOINT` is unset or
	 * `BLOK_TRACING_DISABLED=1`. Stores the shutdown so `stop()` can flush.
	 */
	private async maybeBootstrapTracing(): Promise<void> {
		if (process.env.BLOK_TRACING_DISABLED === "1") return;
		const base = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
		if (!base) return;
		const endpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ? base : `${base.replace(/\/$/, "")}/v1/traces`;
		try {
			const result = await bootstrapTracing({
				serviceName: process.env.APP_NAME || process.env.PROJECT_NAME || "blok-http",
				serviceVersion: process.env.PROJECT_VERSION,
				exporter: "otlp",
				endpoint,
			});
			if (result) {
				this.tracingShutdown = result.shutdown;
				this.logger.log(`[blok][tracing] OTLP distributed tracing enabled → ${endpoint}`);
			} else {
				this.logger.error(
					"[blok][tracing] OTEL_EXPORTER_OTLP_ENDPOINT is set but the OTel trace SDK isn't installed — tracing is OFF.",
				);
			}
		} catch (err) {
			this.logger.error(`[blok][tracing] failed to initialize: ${(err as Error).message}`);
		}
	}

	protected override async onHmrNodeChange(event: HMREvent): Promise<void> {
		this.hmr?.invalidateModule(event.filePath);
		this.loadNodes();
		console.log(`[HMR] Node reloaded: ${event.relativePath}`);
	}

	getApp(): Hono<AppBindings> {
		return this.app;
	}

	/**
	 * v0.7 — expose the runner's `GlobalOptions` (nodes + workflows) so
	 * sibling triggers on the shared app (WebSocketTrigger, SSETrigger)
	 * dispatch through the same node registry instead of maintaining
	 * their own. Read AFTER the constructor — `loadNodes()` +
	 * `loadWorkflows()` have populated the map by then.
	 */
	getNodeMap(): GlobalOptions {
		return this.nodeMap;
	}

	/**
	 * Scan the workflow directories on disk + the manually-registered TS
	 * workflows in `Workflows.ts` and return the route table. Called once
	 * at boot from `listen()` so workflow URLs are decided before serving.
	 *
	 * **Default ON since v0.6** (the v0.4 commit that introduced explicit-
	 * path routing promised this for v0.5; finally lands here). Opt out
	 * via `BLOK_FILE_BASED_ROUTING=false`, or via the existing
	 * `BLOK_ROUTING_LEGACY=1` escape hatch (which also enables the
	 * filename-derived URL fallback for un-migrated workflows). Both
	 * fall back to the legacy catch-all `/<key>/<path>` scheme — and
	 * both will be removed in a future release. The boot log warns
	 * loudly when the legacy path is active so operators notice.
	 */
	private async buildFileBasedRoutes(): Promise<RouteEntry[]> {
		const enabled = isFileBasedRoutingEnabled();
		if (!enabled) {
			this.logger.log(
				"[blok][routing] file-based routing is DISABLED — every request will go through the legacy catch-all `/<workflow-key>/<sub>` dispatch. Unset `BLOK_FILE_BASED_ROUTING=false` / `BLOK_ROUTING_LEGACY=1` to re-enable. The legacy mode will be removed in a future release.",
			);
			return [];
		}

		const workflowsRoot = process.env.WORKFLOWS_PATH || process.env.VITE_WORKFLOWS_PATH || `${process.cwd()}/workflows`;

		// JSON workflows live under WORKFLOWS_PATH/json/<nested>.json.
		// stripLeadingSegments=1 elides the `json/` segment from URLs.
		const scannedJson = await scanWorkflows(
			[
				{
					dir: path.join(workflowsRoot, "json"),
					kind: "json",
					stripLeadingSegments: 0,
				},
			],
			{
				onLoadError: (file, err) => {
					this.logger.error(`[blok] workflow load error in ${file}: ${err.message}`);
				},
			},
		);

		const manual = Object.keys(this.nodeMap.workflows ?? {}).map((key) => ({
			key,
			workflow: (this.nodeMap.workflows as Record<string, unknown>)[key],
		}));

		// Boot is tolerant of route-table collisions: a single bad
		// workflow pair shouldn't drop the WHOLE route table and force
		// every URL through the legacy catch-all (which then rejects
		// every post-v0.4 explicit path → total outage). Collisions are
		// captured into `RoutingDiagnostics` for Studio to surface, and
		// the offending workflow is skipped.
		const diagnostics = RoutingDiagnostics.getInstance();
		diagnostics.clear();
		const collisions: RouteCollision[] = [];
		const table = buildRouteTable(scannedJson, manual, {
			onWarning: (msg) => this.logger.log(`[blok] route warning: ${msg}`),
			onCollision: (collision) => {
				collisions.push(collision);
				this.logger.error(`[blok] route collision — ${collision.message}`);
				diagnostics.record({
					kind: collision.kind,
					method: collision.method,
					path: collision.path,
					winnerSource: collision.winnerSource,
					droppedSource: collision.droppedSource,
					message: collision.message,
				});
			},
		});
		if (collisions.length > 0) {
			this.logger.error(
				`[blok] file-based routing — ${collisions.length} workflow(s) dropped due to route collisions; the rest are still registered. See GET /__blok/routing for details.`,
			);
		}

		if (table.length > 0) {
			this.logger.log(`[blok] file-based routing — ${table.length} route(s) registered:`);
			for (const r of table) {
				this.logger.log(`[blok]   ${r.method.padEnd(7)} ${r.path}  ←  ${r.workflowKey}`);
			}
		}

		// Tier 2 · feed the WorkflowRegistry so the `subworkflow:` step
		// primitive can look up child workflows by name. The route table
		// may contain multiple entries per workflow (one per method/path);
		// dedupe by workflow name before registering. clear-then-register
		// keeps HMR semantics — a re-scan invalidates stale entries.
		const registry = WorkflowRegistry.getInstance();
		registry.clear();
		// F7 — track name→source instead of a bare Set so a SECOND file claiming
		// the same workflow `name` from a DIFFERENT source surfaces as a loud
		// collision diagnostic. Previously this silent pre-dedupe routed around
		// `WorkflowRegistry.register`'s same-name/different-source throw, leaving
		// the registry-keyed callers (sub-workflow lookup, RPC mount) silently
		// bound to whichever entry sorted first by specificity. We keep the
		// deterministic winner (first-registered) so boot stays tolerant, but no
		// longer hide the collision.
		const registered = new Map<string, string>();
		for (const r of table) {
			const wfName = readWorkflowName(r.workflow) ?? r.workflowKey;
			const existingSource = registered.get(wfName);
			if (existingSource !== undefined) {
				if (existingSource !== r.source) {
					const message = `[blok] workflow name collision — "${wfName}" is claimed by ${existingSource} and ${r.source}; only ${existingSource} is reachable as a sub-workflow / via RPC. Rename one workflow so each \`name\` is unique.`;
					this.logger.error(message);
					diagnostics.record({
						kind: "duplicate",
						winnerSource: existingSource,
						droppedSource: r.source,
						message,
					});
				}
				continue;
			}
			registered.set(wfName, r.source);
			registry.register({
				name: wfName,
				source: r.source,
				workflow: r.workflow,
				// Bug 01 — derive the middleware marker from the workflow object.
				// `buildRouteTable` already excludes middleware, so in practice
				// this is always false for routed entries; reading it here keeps
				// the flag correct if that exclusion is ever relaxed and covers
				// raw-object-literal / legacy `Workflow()` middleware that slipped
				// in with a trigger.
				isMiddleware: readMiddlewareFlag(r.workflow),
			});
		}
		if (registered.size > 0) {
			this.logger.log(`[blok] workflow registry — ${registered.size} workflow(s) callable as sub-workflow`);
		}

		// v0.5 · register middleware-only workflows (workflow.middleware === true).
		// These don't appear in the route table because they have no trigger;
		// register them under their own `name` so `trigger.http.middleware: [...]`
		// lookups in `runMiddlewareChain` can find them.
		let middlewareCount = 0;
		for (const sw of scannedJson) {
			if (!readMiddlewareFlag(sw.workflow)) continue;
			const wfName = readWorkflowName(sw.workflow) ?? sw.name;
			if (!wfName) continue;
			if (registered.has(wfName)) continue;
			registered.set(wfName, sw.source);
			registry.register({
				name: wfName,
				source: sw.source,
				workflow: sw.workflow,
				isMiddleware: true,
			});
			middlewareCount++;
		}
		if (middlewareCount > 0) {
			this.logger.log(`[blok] middleware registry — ${middlewareCount} middleware workflow(s) registered`);
		}

		return table;
	}

	/**
	 * Bug 01 — register TS-authored middleware from the static `Workflows.ts`
	 * map. A trigger-less `workflow({ middleware: true })` never appears in the
	 * route table (and the v2 helper carries the flag on `_config`, not the
	 * root), so neither `buildFileBasedRoutes` nor `scanAndRegisterMiddleware`
	 * (JSON-only) picks it up. This pass runs UNCONDITIONALLY from `listen()`
	 * so TS middleware is registered whether file-based routing is on or off.
	 *
	 * Dedupe by name against whatever is already in the registry so it stays
	 * idempotent across HMR re-scans and never collides with a same-named JSON
	 * workflow already registered from a different source.
	 */
	private registerManualMiddleware(workflows: Record<string, unknown>): void {
		const registry = WorkflowRegistry.getInstance();
		let count = 0;
		for (const key of Object.keys(workflows ?? {})) {
			const wf = workflows[key];
			if (!readMiddlewareFlag(wf)) continue;
			const wfName = readWorkflowName(wf) ?? key;
			const source = `Workflows.ts[${JSON.stringify(key)}]`;
			const existing = registry.get(wfName);
			if (existing) {
				// Same workflow already registered (HMR re-run or a JSON dupe) —
				// leave it. The route-table / JSON passes own the canonical entry.
				continue;
			}
			registry.register({
				name: wfName,
				source,
				workflow: wf,
				isMiddleware: true,
			});
			count++;
		}
		if (count > 0) {
			this.logger.log(`[blok] middleware registry — ${count} TS middleware workflow(s) registered`);
		}
	}

	/**
	 * v0.5 · scan WORKFLOWS_PATH/json/ for ALL workflows and register them
	 * in WorkflowRegistry. Runs even when file-based routing is OFF — the
	 * catch-all dispatch path also honours `trigger.http.middleware: [...]`
	 * references AND `subworkflow:` step lookups, both of which need the
	 * registry populated.
	 *
	 * Two passes by purpose:
	 *   1. Middleware-only workflows (`middleware: true`) registered with
	 *      `isMiddleware: true` — fed to the trigger-level / workflow-level
	 *      middleware chain dispatcher in `runMiddlewareChain`.
	 *   2. Non-middleware workflows registered without the marker — fed to
	 *      `SubworkflowNode` so authors can compose workflows via the
	 *      `subworkflow: "<name>"` step shape regardless of whether the
	 *      route table was built (file-based-routing on) or not.
	 *
	 * Idempotent: if `buildFileBasedRoutes` already ran (file-based
	 * routing enabled) and registered these entries, the same `(name,
	 * source)` pairs skip re-adding. Name collisions across files surface
	 * as registration errors per `WorkflowRegistry.register`.
	 */
	private async scanAndRegisterMiddleware(): Promise<void> {
		const workflowsRoot = process.env.WORKFLOWS_PATH || process.env.VITE_WORKFLOWS_PATH || `${process.cwd()}/workflows`;
		const scanned = await scanWorkflows(
			[
				{
					dir: path.join(workflowsRoot, "json"),
					kind: "json",
					stripLeadingSegments: 0,
				},
			],
			{
				onLoadError: (file, err) => {
					this.logger.error(`[blok] middleware scan: workflow load error in ${file}: ${err.message}`);
				},
			},
		);

		const registry = WorkflowRegistry.getInstance();
		let middlewareCount = 0;
		let subworkflowCount = 0;
		for (const sw of scanned) {
			const wfObj = sw.workflow as { name?: unknown; middleware?: unknown } | undefined;
			if (!wfObj) continue;
			const wfName = typeof wfObj.name === "string" ? wfObj.name : sw.name;
			if (!wfName) continue;

			// Skip workflows already registered from the same source —
			// usually means buildFileBasedRoutes already grabbed them.
			const existing = registry.get(wfName);
			if (existing && existing.source === sw.source) continue;

			if (wfObj.middleware === true) {
				// Middleware-only workflow — only re-register if no entry
				// exists or the existing entry is also a middleware (keep
				// non-middleware route-table entries intact).
				if (existing && !existing.isMiddleware) continue;
				registry.register({
					name: wfName,
					source: sw.source,
					workflow: sw.workflow,
					isMiddleware: true,
				});
				middlewareCount++;
			} else {
				// Non-middleware workflow — register for sub-workflow
				// lookup. Skip if anything is already registered under
				// this name (route table or middleware re-claim).
				if (existing) continue;
				registry.register({
					name: wfName,
					source: sw.source,
					workflow: sw.workflow,
				});
				subworkflowCount++;
			}
		}
		if (middlewareCount > 0) {
			this.logger.log(
				`[blok] middleware registry — ${middlewareCount} middleware workflow(s) registered (catch-all path)`,
			);
		}
		if (subworkflowCount > 0) {
			this.logger.log(
				`[blok] workflow registry — ${subworkflowCount} workflow(s) registered for sub-workflow lookup (catch-all path)`,
			);
		}
	}

	/**
	 * Register every entry in the route table as an explicit Hono route.
	 * Each handler delegates to `runWorkflowExecution` with the route's
	 * pre-loaded workflow object passed directly to `Configuration.init`
	 * (no disk re-read at request time, no LocalStorage fallback dance).
	 *
	 * Registered BEFORE the catch-all so explicit routes win. Method
	 * "ANY" maps to `app.all(...)`; otherwise `app[method](...)`. Falls
	 * back to `app.all(...)` for HEAD/OPTIONS where Hono lacks a
	 * dedicated method.
	 */
	private registerExplicitRoutes(routes: readonly RouteEntry[]): void {
		for (const route of routes) {
			const handler = async (c: HonoContext<AppBindings>): Promise<Response> => {
				const requestId = c.req.query("requestId") || (uuid() as string);
				const { body, rawBody } = await this.parseBody(c);
				return this.runWorkflowExecution(c, {
					workflowName: route.workflowKey,
					subPath: "/",
					body,
					rawBody,
					requestId,
					explicitRoute: true,
					preloadedWorkflow: route.workflow,
				});
			};

			const method = route.method.toUpperCase();
			switch (method) {
				case "GET":
					this.app.get(route.path, handler);
					break;
				case "POST":
					this.app.post(route.path, handler);
					break;
				case "PUT":
					this.app.put(route.path, handler);
					break;
				case "DELETE":
					this.app.delete(route.path, handler);
					break;
				case "PATCH":
					this.app.patch(route.path, handler);
					break;
				default:
					// ANY (or HEAD/OPTIONS/unknown) — register on all methods.
					this.app.all(route.path, handler);
					break;
			}
		}
	}

	/**
	 * Parse the request body using the same content-type rules the
	 * catch-all handler uses. Extracted so both paths (catch-all and
	 * explicit routes) parse bodies identically.
	 *
	 * Returns BOTH the parsed body (whatever shape the content-type
	 * dictates) AND the raw body string captured BEFORE parsing.
	 * `rawBody` is what webhook HMAC verifiers need to match a
	 * provider's signature byte-exactly (Stripe `Stripe-Signature`,
	 * Slack `X-Slack-Signature`, GitHub when bodies contain content
	 * the JSON.stringify round-trip would mangle). For application/json
	 * payloads we parse the raw text manually instead of calling
	 * `c.req.json()` because `c.req.text()` and `c.req.json()` both
	 * consume the body stream — we only get one shot.
	 *
	 * `rawBody` is the empty string for GET/HEAD (no body), for
	 * non-text content-types where capture doesn't apply
	 * (multipart/form-data — Hono's `parseBody()` reads the stream and
	 * we can't get the raw bytes back without parsing twice), and
	 * when the underlying read throws.
	 */
	private async parseBody(c: HonoContext<AppBindings>): Promise<{ body: unknown; rawBody: string }> {
		if (c.req.method === "GET" || c.req.method === "HEAD") return { body: {}, rawBody: "" };
		const contentType = c.req.header("content-type") || "";

		// multipart needs Hono's stream parser — raw bytes aren't recoverable
		// after the parse, so rawBody stays empty. Webhook providers that
		// sign multipart bodies are vanishingly rare; the rest is the
		// common case.
		if (contentType.includes("multipart/form-data")) {
			try {
				return { body: await c.req.parseBody(), rawBody: "" };
			} catch {
				return { body: {}, rawBody: "" };
			}
		}

		// For application/json and application/x-www-form-urlencoded we
		// CAN capture the raw body and still parse — read the text once,
		// then parse off the captured string ourselves.
		let rawBody = "";
		try {
			rawBody = await c.req.text();
		} catch {
			return { body: {}, rawBody: "" };
		}

		if (contentType.includes("application/json")) {
			try {
				return { body: rawBody.length === 0 ? {} : JSON.parse(rawBody), rawBody };
			} catch {
				// Malformed JSON — preserve rawBody (a webhook verifier
				// might still want it for its 4xx error response) and let
				// downstream handle the empty parsed body. Matches pre-
				// v0.6 behaviour of returning {} on parse failure.
				return { body: {}, rawBody };
			}
		}

		if (contentType.includes("application/x-www-form-urlencoded")) {
			try {
				const parsed: Record<string, string> = {};
				for (const [k, v] of new URLSearchParams(rawBody)) parsed[k] = v;
				return { body: parsed, rawBody };
			} catch {
				return { body: {}, rawBody };
			}
		}

		// Default — text body, parsed body = raw text. Matches pre-v0.6
		// `c.req.text()` fallback.
		return { body: rawBody, rawBody };
	}

	async listen(): Promise<number> {
		// Metrics opt-out gate. ON by default; `BLOK_METRICS_DISABLED=1` skips the
		// exporter + global MeterProvider entirely (every blok_* instrument then
		// no-ops) and the `/metrics` route below is not registered. Previously the
		// exporter installed itself at module-import + via a Dockerfile --preload,
		// so it could never be turned off.
		//
		// MUST run BEFORE maybeBootstrapTracing(): `metrics.setGlobalMeterProvider`
		// is first-registration-wins, and bootstrapping the OTel trace SDK touches
		// the global meter provider — if tracing goes first, the Prometheus
		// MeterProvider never wins the global slot, so blok_* instruments (created
		// via `metrics.getMeter(...)`) record into a no-op meter and `/metrics`
		// shows "# no registered metrics" whenever OTLP tracing is enabled. Setting
		// the metrics provider first lets metrics + tracing coexist.
		const metricsBootstrap = await bootstrapMetrics();
		if (!metricsBootstrap) {
			this.logger.log("[blok][metrics] disabled (BLOK_METRICS_DISABLED=1) — no /metrics endpoint, instruments no-op.");
		}

		// OBS-02 — opt-in distributed tracing. When OTEL_EXPORTER_OTLP_ENDPOINT
		// is set, install an OTel SDK so the spans created throughout the runner
		// (every trigger handler, gRPC runtime call, etc. via `startActiveSpan` /
		// `recordException`) actually export to Tempo/Jaeger/etc. Without this the
		// global tracer is a no-op: spans run but go nowhere. No-op + zero
		// overhead when the env var is unset.
		await this.maybeBootstrapTracing();

		try {
			this.nodeMap.workflows = (await resolveManualWorkflowMap(
				(workflows as Record<string, unknown>) ?? {},
			)) as GlobalOptions["workflows"];
		} catch (err) {
			this.logger.error(`[blok] TS workflow registration failed: ${(err as Error).message}`);
		}

		// File-based routing — scan workflow folders, build the route table,
		// and register each entry as an explicit Hono route BEFORE the
		// catch-all. **Default ON since v0.6**; opt out via
		// `BLOK_FILE_BASED_ROUTING=false` or `BLOK_ROUTING_LEGACY=1`.
		// When off, all requests fall through to the catch-all (legacy
		// /<workflow-key> URL scheme).
		let fileBasedRoutes: RouteEntry[] = [];
		try {
			fileBasedRoutes = await this.buildFileBasedRoutes();
		} catch (err) {
			this.logger.error(`[blok] file-based routing setup failed: ${(err as Error).message}`);
		}

		// v0.5 · scan + register middleware-only workflows even when
		// file-based routing is off (the catch-all dispatch path also
		// honours `trigger.http.middleware: [...]`). buildFileBasedRoutes
		// already does this for routed + middleware workflows when enabled;
		// this fallback covers the off case so middleware works uniformly.
		try {
			await this.scanAndRegisterMiddleware();
		} catch (err) {
			this.logger.error(`[blok] middleware scan failed: ${(err as Error).message}`);
		}

		// Bug 01 · register TS-authored middleware (`workflow({ middleware: true })`
		// exported from `Workflows.ts`). Runs unconditionally — trigger-less TS
		// middleware never enters the route table, and the JSON-only scan above
		// won't see it — so without this pass `runMiddlewareChain` 500s for the
		// documented (recommended) TS authoring path.
		try {
			this.registerManualMiddleware((this.nodeMap.workflows as Record<string, unknown>) ?? {});
		} catch (err) {
			this.logger.error(`[blok] TS middleware registration failed: ${(err as Error).message}`);
		}

		// v0.5.4 · process-global middleware. Read the BLOK_GLOBAL_MIDDLEWARE
		// env var as a fallback registration path — useful when the operator
		// wants to add ops middleware (request-id, audit-log) without
		// rebuilding the trigger image. The programmatic API
		// (`WorkflowRegistry.setGlobalMiddleware([...])`) takes precedence:
		// if the registry already has a global chain set, the env var is
		// ignored. This lets a programmatic boot-time setup override an
		// operator's CI-injected env without surprising overrides.
		const registry = WorkflowRegistry.getInstance();
		if (registry.getGlobalMiddleware().length === 0 && process.env.BLOK_GLOBAL_MIDDLEWARE) {
			const fromEnv = process.env.BLOK_GLOBAL_MIDDLEWARE.split(",")
				.map((s) => s.trim())
				.filter((s) => s.length > 0);
			if (fromEnv.length > 0) {
				registry.setGlobalMiddleware(fromEnv);
				this.logger.log(`[blok] global middleware registered from BLOK_GLOBAL_MIDDLEWARE env: ${fromEnv.join(", ")}`);
			}
		}
		const globalChain = registry.getGlobalMiddleware();
		if (globalChain.length > 0) {
			this.logger.log(`[blok] process-global middleware chain (applies to every workflow): ${globalChain.join(" → ")}`);
		}

		// v0.7 — fire pre-catch-all hooks. Sibling triggers (WebSocketTrigger,
		// SSETrigger) registered routes on the shared Hono app here so they
		// match BEFORE the legacy `/:workflow{.+}` catch-all below. The
		// workflow registry is fully populated by this point, so hooks can
		// walk it to discover the routes they need to mount.
		for (const hook of this.preCatchAllHooks) {
			try {
				const result = hook();
				if (result instanceof Promise) {
					await result.catch((err: unknown) => {
						const msg = err instanceof Error ? err.message : String(err);
						this.logger.error(`[blok] pre-catch-all hook failed: ${msg}`);
					});
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				this.logger.error(`[blok] pre-catch-all hook failed: ${msg}`);
			}
		}

		return new Promise((done) => {
			// Static files
			this.app.use("/public/*", serveStatic({ root: "./" }));

			// CORS — configurable via BLOK_CORS_ORIGIN.
			// Default (unset): NO CORS headers are emitted (same-origin policy).
			// Set BLOK_CORS_ORIGIN=* to opt into the permissive wildcard (public
			// API); set a single origin or a comma-separated allow-list for a
			// credentialed app. Previously this was an unconditional `cors()` —
			// Hono's default is `origin: "*"`, which can't be tightened and is a
			// footgun for any API that returns user-scoped data.
			const corsOriginEnv = process.env.BLOK_CORS_ORIGIN;
			if (corsOriginEnv) {
				const origins = corsOriginEnv
					.split(",")
					.map((s) => s.trim())
					.filter((s) => s.length > 0);
				if (origins.length > 0) {
					this.app.use(cors({ origin: origins.length === 1 ? origins[0] : origins }));
				}
			}

			// Health check
			this.app.all("/health-check", (c) => {
				return c.text("Online and ready for action", 200);
			});

			// Prometheus metrics — uses raw Node.js req/res since the
			// OpenTelemetry Prometheus exporter expects (IncomingMessage, ServerResponse).
			// Only registered when metrics are enabled (see the bootstrap gate above);
			// with BLOK_METRICS_DISABLED=1 there is no /metrics route at all (→ 404).
			if (metricsBootstrap) {
				this.app.get("/metrics", (c) => {
					try {
						metricsBootstrap.metricsHandler(c.env.incoming, c.env.outgoing);
						return RESPONSE_ALREADY_SENT;
					} catch (error) {
						return c.text("Error serving metrics", 500);
					}
				});
			}

			// --- Typed client RPC mount (P1.3) ---
			// `POST /__blok/rpc/:name` runs a registered workflow BY NAME and
			// returns its output as JSON — the name-keyed entrypoint the typed
			// `@blokjs/client` calls (SPEC-blok-client-sdk.md §4.3). Registered
			// BEFORE the `/__blok` trace router so it isn't swallowed by it. The
			// request body is the workflow's input; the workflow's own middleware
			// chain (auth, etc.) still runs inside `runWorkflowExecution`.
			this.app.post("/__blok/rpc/:name", async (c) => {
				const name = c.req.param("name");
				const entry = WorkflowRegistry.getInstance().get(name);
				// F8 — only run http-callable workflows over RPC. A workflow is
				// reachable here only if it (a) is registered, (b) is not
				// middleware, and (c) actually declares a `trigger.http` block.
				// Without (c), a worker/cron-only workflow registered for
				// sub-workflow lookup would be executable over HTTP with no
				// trigger-surface gate — and `runWorkflowExecution` would resolve
				// its middleware against the wrong (`http`) trigger kind, silently
				// dropping the worker/cron middleware chain (e.g. auth).
				if (!entry || entry.isMiddleware === true || !hasHttpTrigger(entry.workflow)) {
					return c.json({ error: `Workflow "${name}" is not registered for RPC.` }, 404);
				}

				// Mount-level auth gate. The RPC surface is in the /__blok/
				// namespace but is registered BEFORE the trace router, so the
				// trace-auth gate (FW-1) never covers it — meaning any
				// http-triggered workflow without its own auth middleware was
				// callable unauthenticated. Mirror the trace gate here: in
				// production, refuse unless an authorize hook is registered (or
				// BLOK_RPC_AUTH_DISABLED=1 opts out, e.g. /__blok/* is firewalled
				// at the network layer). Reuses the operator's `setTraceAuth`
				// hook so there's one auth surface for the whole /__blok/ mount.
				// Per-workflow middleware still runs inside runWorkflowExecution.
				const isProd = process.env.BLOK_ENV === "production" || process.env.NODE_ENV === "production";
				if (isProd && process.env.BLOK_RPC_AUTH_DISABLED !== "1") {
					if (!this.traceAuthFn) {
						return c.json(
							{
								error: "RPC endpoint requires auth in production",
								hint: "Register an authorize hook before listen() — `trigger.setTraceAuth(req => ...)` — or set BLOK_RPC_AUTH_DISABLED=1 to opt out (typically because /__blok/* is firewalled).",
							},
							503,
						);
					}
					const raw = c.req.raw;
					const allowed = await Promise.resolve()
						.then(() =>
							// biome-ignore lint/style/noNonNullAssertion: guarded above
							this.traceAuthFn!({
								method: raw.method,
								params: c.req.param(),
								query: Object.fromEntries(new URL(raw.url).searchParams),
								headers: Object.fromEntries(raw.headers),
								body: null,
								on: () => {},
							}),
						)
						.catch(() => false);
					if (!allowed) return c.json({ error: "Unauthorized" }, 401);
				}

				const requestId = c.req.query("requestId") || (uuid() as string);
				const { body, rawBody } = await this.parseBody(c);
				const input = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};

				// Streaming request (P3.2): when the client asks for an SSE stream,
				// run the workflow with a bound `ctx.stream` and forward its frames.
				if ((c.req.header("accept") || "").includes("text/event-stream")) {
					return this.runWorkflowStream(c, { name, preloadedWorkflow: entry.workflow, input, requestId });
				}

				return this.runWorkflowExecution(c, {
					workflowName: name,
					subPath: "",
					body: input,
					rawBody,
					requestId,
					explicitRoute: true,
					preloadedWorkflow: entry.workflow,
					rpcInput: input,
				});
			});

			// --- Node catalog (SPEC-B P1.3) ---
			// `GET /__blok/nodes` lists every node across all runtimes — in-process
			// module nodes (with their reflected JSON Schema) + each connected
			// runtime's `ListNodes`. Powers `blokctl nodes list` + the typed
			// client's runtime-node typing. Registered before the trace router.
			this.app.get("/__blok/nodes", async (c) => {
				const moduleNodes = this.nodeMap.nodes?.getNodes?.() as Map<string, unknown> | undefined;
				const nodes = await buildNodeCatalog(moduleNodes, RuntimeRegistry.getInstance().getAll());
				return c.json({ nodes, count: nodes.length });
			});

			// --- Blok Studio: Trace API ---
			// Must be registered BEFORE AppRoutes and the catch-all workflow handler
			// so that /__blok/* requests are handled by the trace router, not treated
			// as workflow lookups.
			if (process.env.BLOK_TRACE_ENABLED !== "false") {
				const { traceAdapter, traceApp } = createTraceRouterAdapter();
				// Security review FW-1 — thread the operator-registered
				// authorize hook (if any) into the trace router. Production
				// without `setTraceAuth(...)` returns 503 from inside the
				// trace router middleware.
				registerTraceRoutes(traceAdapter, undefined, { authorize: this.traceAuthFn });
				this.app.route("/__blok", traceApp);
			}

			/*
			 * You can add your own middleware or routes with custom Hono logic
			 * to extend this project.
			 */
			this.app.route("/", apps);

			// File-based routing — register every scanned workflow at its
			// resolved URL (explicit `trigger.http.path` wins; otherwise the
			// file-derived path is used). Registered BEFORE the catch-all so
			// matching requests are routed directly without filename-prefix
			// dispatch. Empty when `BLOK_FILE_BASED_ROUTING=false` or
			// `BLOK_ROUTING_LEGACY=1` is set.
			if (fileBasedRoutes.length > 0) this.registerExplicitRoutes(fileBasedRoutes);

			// Catch-all workflow handler — legacy /<workflow-key>/<path> dispatch.
			// Falls through here only when no explicit file-based route matched.
			const workflowHandler = async (c: HonoContext<AppBindings>) => {
				const requestId = c.req.query("requestId") || (uuid() as string);
				const workflowNameInPath = c.req.param("workflow") as string;

				// Skip internal paths — these are handled by dedicated routers above
				if (workflowNameInPath === "__blok") {
					return c.json({ error: "Not found" }, 404);
				}

				// Compute the sub-path (equivalent to Express req.path in use() middleware context)
				const fullPath = c.req.path;
				const subPath = workflowNameInPath ? fullPath.slice(1 + workflowNameInPath.length) || "/" : fullPath;

				const { body, rawBody } = await this.parseBody(c);

				// Remote node execution dispatch (header-based) — only meaningful for
				// the catch-all path, never for explicit routes.
				let remoteNodeExecution = false;
				let runtimeWorkflow: RuntimeWorkflow | undefined;
				if (c.req.header("x-blok-execute-node") === "true" && c.req.method.toLowerCase() === "post") {
					remoteNodeExecution = true;
					const coder = new MessageDecode();
					const messageContext: Context = coder.requestDecode(body as WorkflowRequest);
					runtimeWorkflow = messageContext as unknown as RuntimeWorkflow;
				}

				return this.runWorkflowExecution(c, {
					workflowName: workflowNameInPath,
					subPath,
					body,
					rawBody,
					requestId,
					remoteNodeExecution,
					runtimeWorkflow,
				});
			};

			this.app.all("/:workflow{.+}/*", workflowHandler);
			this.app.all("/:workflow{.+}", workflowHandler);

			this.server = serve({ fetch: this.app.fetch, port: Number(this.port) }, () => {
				this.logger.log(`Server is running at http://localhost:${this.port}`);

				// v0.7 — run server hooks (sibling triggers like
				// WebSocketTrigger call `injectWebSocket(server)` here to
				// attach their `upgrade` listener to the http.Server). Errors
				// caught + logged so a misbehaving hook doesn't bring the
				// server down. The cast is safe — `serve()` returns a Server
				// instance per @hono/node-server's types.
				if (this.server && this.serverHooks.length > 0) {
					for (const hook of this.serverHooks) {
						try {
							const result = hook(this.server);
							if (result instanceof Promise) {
								result.catch((err: unknown) => {
									const msg = err instanceof Error ? err.message : String(err);
									this.logger.error(`[blok] server hook failed: ${msg}`);
								});
							}
						} catch (err) {
							const msg = err instanceof Error ? err.message : String(err);
							this.logger.error(`[blok] server hook failed: ${msg}`);
						}
					}
				}

				// Enable HMR in development mode
				if (process.env.BLOK_HMR === "true" || process.env.NODE_ENV === "development") {
					this.enableHotReload();
				}

				// Tier 2 quick-wins follow-up · install process-level handlers
				// that flip in-flight `running` runs to `crashed` on uncaught
				// errors, AND scan for orphaned runs from a previous (dead)
				// process. Both are idempotent + opt-out via
				// `BLOK_CRASH_AUTOFLIP_DISABLED=1`.
				try {
					HttpTrigger.installCrashHandlers(this.logger);
					const orphaned = HttpTrigger.recoverOrphanedRuns(undefined, this.logger);
					if (orphaned > 0) {
						this.logger.log(`[crash-autoflip] flipped ${orphaned} orphaned run(s) to crashed on boot`);
					}
				} catch (err) {
					this.logger.error(`[crash-autoflip] setup failed: ${err instanceof Error ? err.message : String(err)}`);
				}

				// Tier 2 follow-up · start the periodic storage janitor for
				// stale idempotency_cache + concurrency_locks + scheduled_dispatches
				// rows. Idempotent (singleton); opt-out via `BLOK_JANITOR_DISABLED=1`.
				try {
					Janitor.getInstance(RunTracker.getInstance().getStore(), this.logger).start();
				} catch (err) {
					this.logger.error(`[janitor] setup failed: ${err instanceof Error ? err.message : String(err)}`);
				}

				// Tier 2 follow-up · install graceful shutdown handlers
				// (SIGTERM / SIGINT) so backend connections + janitor +
				// scheduler all drain cleanly on process exit. Idempotent;
				// opt-out via `BLOK_GRACEFUL_SHUTDOWN_DISABLED=1`.
				try {
					HttpTrigger.installShutdownHandlers(this, this.logger);
				} catch (err) {
					this.logger.error(`[shutdown] setup failed: ${err instanceof Error ? err.message : String(err)}`);
				}

				// Tier 2 #5+#7 follow-up · re-fire HTTP dispatches that were
				// pending when this process (or its predecessor) crashed.
				// Idempotent — safe to call multiple times.
				this.recoverDispatches().catch((err: unknown) => {
					this.logger.error(
						`[scheduling] HTTP dispatch recovery failed: ${err instanceof Error ? err.message : String(err)}`,
					);
				});

				done(this.endCounter(this.initializer));
			}) as Server;
		});
	}

	/**
	 * Stream a workflow's SSE events over the name-keyed RPC mount (P3.2).
	 *
	 * Mirrors the dedicated SSE trigger's dispatch: open an `streamSSE` response,
	 * bind a `ctx.stream` (StreamContext) to the Hono stream, run the workflow
	 * once, and forward every `ctx.stream.writeSSE(...)` / `@blokjs/sse-emit`
	 * frame to the client. The input arrives as `ctx.request.body` and its scalar
	 * fields are mirrored into query + params (same contract as the unary mount).
	 *
	 * `ctx.stream.subscribe()` (the in-process SSE event bus) is intentionally
	 * NOT wired here — bus-subscription workflows should use the dedicated SSE
	 * trigger. Push-style streaming (`@blokjs/sse-emit`, `streamTo: "sse"`) works.
	 */
	private async runWorkflowStream(
		c: HonoContext<AppBindings>,
		opts: { name: string; preloadedWorkflow: unknown; input: Record<string, unknown>; requestId: string },
	): Promise<Response> {
		const { name, preloadedWorkflow, input, requestId } = opts;
		const lastEventId = c.req.header("Last-Event-ID") || c.req.header("last-event-id") || null;
		const headers = Object.fromEntries([...c.req.raw.headers.entries()]);

		return streamSSE(c, async (honoStream) => {
			const abortController = new AbortController();
			let closed = false;
			honoStream.onAbort(() => {
				closed = true;
				abortController.abort();
			});

			const stream: StreamContext = {
				get id() {
					return requestId;
				},
				get lastEventId() {
					return lastEventId;
				},
				get closed() {
					return closed;
				},
				get signal() {
					return abortController.signal;
				},
				async writeSSE({ event, data, id, retry }) {
					if (closed) return;
					const payload = typeof data === "string" ? data : JSON.stringify(data);
					await honoStream
						.writeSSE({
							data: payload,
							...(event ? { event } : {}),
							...(id ? { id } : {}),
							...(typeof retry === "number" ? { retry } : {}),
						})
						.catch(() => {
							/* client gone — swallow */
						});
				},
				async writeComment(text) {
					if (closed) return;
					await honoStream.write(`: ${text}\n\n`).catch(() => {});
				},
				close() {
					closed = true;
					abortController.abort();
				},
				subscribe() {
					throw new Error(
						"[blok] ctx.stream.subscribe() (the SSE event bus) is not available over /__blok/rpc — " +
							"use the dedicated SSE trigger for bus-subscription workflows.",
					);
				},
			};

			try {
				await this.configuration.init(name, this.nodeMap, preloadedWorkflow);
				const ctx: Context = this.createContext(undefined, name, requestId);
				const query: Record<string, string> = {};
				const params: Record<string, string> = {};
				for (const [k, v] of Object.entries(input)) {
					if (v !== null && v !== undefined && typeof v !== "object") {
						query[k] = String(v);
						params[k] = String(v);
					}
				}
				ctx.request = {
					body: input,
					rawBody: "",
					headers,
					params,
					query,
					method: c.req.method,
					path: c.req.path,
					url: c.req.url,
				} as unknown as RequestContext;
				ctx.stream = stream;

				await this.applyMiddlewareChain(ctx, this.nodeMap);
				await this.run(ctx);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				this.logger.error(`[blok] rpc stream "${name}" failed: ${msg}`);
				if (!closed) {
					await honoStream.writeSSE({ event: "error", data: JSON.stringify({ message: msg }) }).catch(() => {});
				}
			}
		});
	}

	/**
	 * F15 · enforce `trigger.http.headers`. The schema documents this field as
	 * "Required headers for incoming requests (validated at trigger entry)" but
	 * nothing ever read it. For each declared header:
	 *   - presence is checked case-insensitively (HTTP header names are
	 *     case-insensitive; `ctx.request.headers` keys arrive lower-cased from
	 *     `Headers.entries()`);
	 *   - when a non-empty string VALUE is declared, the incoming value must
	 *     match exactly (case-sensitive) — useful for a fixed API version or a
	 *     content-type precondition. A declared empty / non-string value only
	 *     asserts presence.
	 *
	 * Throws a `GlobalError` with code 400 + a structured JSON body on the first
	 * violation, short-circuiting before any step runs. No-op when the workflow
	 * declares no `headers`.
	 */
	private validateRequiredHeaders(requestHeaders: Record<string, unknown> | undefined): void {
		const http = this.configuration?.trigger?.http as { headers?: unknown } | undefined;
		const declared = http?.headers as Record<string, unknown> | undefined;
		if (!declared || typeof declared !== "object") return;

		// Lower-case the incoming header map once for case-insensitive lookup.
		const incoming: Record<string, string> = {};
		for (const [k, v] of Object.entries(requestHeaders ?? {})) {
			incoming[k.toLowerCase()] = typeof v === "string" ? v : String(v ?? "");
		}

		for (const [rawKey, rawExpected] of Object.entries(declared)) {
			const key = rawKey.toLowerCase();
			const present = Object.hasOwn(incoming, key);
			if (!present) {
				throw this.headerError(`Missing required header "${rawKey}".`, rawKey, undefined);
			}
			if (typeof rawExpected === "string" && rawExpected.length > 0 && incoming[key] !== rawExpected) {
				throw this.headerError(`Header "${rawKey}" must equal "${rawExpected}".`, rawKey, rawExpected);
			}
		}
	}

	/** Build the 400 `GlobalError` raised by {@link validateRequiredHeaders}. */
	private headerError(message: string, header: string, expected: string | undefined): GlobalError {
		const err = new GlobalError(message);
		err.setCode(400);
		err.setName("RequiredHeaderError");
		err.setJson({
			error: "required_header",
			message,
			header,
			...(expected !== undefined ? { expected } : {}),
		});
		return err;
	}

	/**
	 * Execute a workflow request — the shared work both the legacy catch-all
	 * and the explicit file-based routes funnel into.
	 *
	 * @param c - Hono context
	 * @param opts.workflowName - workflow identifier (catch-all: extracted from URL; explicit: closure-bound)
	 * @param opts.subPath - sub-path after the workflow key (catch-all only; "/" for explicit routes)
	 * @param opts.body - parsed request body
	 * @param opts.requestId - per-request UUID for tracing
	 * @param opts.explicitRoute - true when called from `registerExplicitRoutes`. Skips
	 *   the runtime method+path validation since Hono already routed by both.
	 * @param opts.preloadedWorkflow - the workflow object pre-parsed at boot (file-based
	 *   routing path). When provided, `Configuration.init` uses it directly instead of
	 *   re-reading from disk.
	 * @param opts.remoteNodeExecution - legacy catch-all path: header-based dispatch.
	 * @param opts.runtimeWorkflow - legacy catch-all path: workflow synthesised at request
	 *   time from the remote-node-execution header payload.
	 */
	private async runWorkflowExecution(
		c: HonoContext<AppBindings>,
		opts: {
			workflowName: string;
			subPath: string;
			body: unknown;
			/**
			 * Raw request body string captured BEFORE JSON / form parsing.
			 * Empty string when the trigger couldn't (or didn't need to)
			 * capture it. Surfaced as `ctx.request.rawBody` so webhook HMAC
			 * verifiers (Stripe, Slack, byte-exact GitHub) can sign the
			 * exact bytes the provider signed.
			 */
			rawBody?: string;
			requestId: string;
			explicitRoute?: boolean;
			preloadedWorkflow?: unknown;
			remoteNodeExecution?: boolean;
			runtimeWorkflow?: RuntimeWorkflow;
			/**
			 * v0.7 · typed-client RPC mount (`/__blok/rpc/:name`). When set, the
			 * input object's top-level SCALAR fields are mirrored into
			 * `ctx.request.query` + `ctx.request.params` (in addition to arriving
			 * as `body`) so a workflow authored for a GET/query or `:param`
			 * trigger still resolves its inputs uniformly through the name-keyed
			 * mount. Nested/object fields stay on `body` only.
			 */
			rpcInput?: Record<string, unknown>;
		},
	): Promise<Response> {
		const id = opts.requestId;
		let workflowNameInPath = opts.workflowName;
		const subPath = opts.subPath;
		const body = opts.body;
		const rawBody = opts.rawBody ?? "";
		const explicitRoute = opts.explicitRoute === true;
		let remoteNodeExecution = opts.remoteNodeExecution === true;
		const runtimeWorkflow = opts.runtimeWorkflow;
		const preloadedWorkflow = opts.preloadedWorkflow;

		const defaultMeter = metrics.getMeter("default");
		const workflow_runner_errors = defaultMeter.createCounter("workflow_errors", {
			description: "Workflow runner errors",
		});

		// OBS-02 B2.1 — join the caller's distributed trace. Extract a W3C
		// `traceparent`/`tracestate` from the inbound request headers so the
		// workflow span nests under the upstream span instead of starting a
		// fresh root. With no `traceparent` present (or no provider registered)
		// `propagation.extract` returns the active context unchanged — identical
		// behaviour to before, zero overhead when tracing is off.
		const inboundCarrier = Object.fromEntries(c.req.raw.headers.entries());
		const parentContext = propagation.extract(context.active(), inboundCarrier);
		return this.tracer.startActiveSpan(
			`${workflowNameInPath}`,
			{ kind: SpanKind.SERVER },
			parentContext,
			async (span: Span) => {
				try {
					const start = performance.now();
					if (remoteNodeExecution && runtimeWorkflow !== undefined) {
						const workflowModel = runtimeWorkflow.workflow;
						const node_type = (workflowModel.steps[0] as unknown as ParamsDictionary).type;
						let set_node_type: NodeTypes = NodeTypes.MODULE;
						switch (node_type) {
							case "runtime.python3":
								set_node_type = NodeTypes.PYTHON3;
								break;
							case "runtime.go":
								set_node_type = NodeTypes.GO;
								break;
							case "runtime.rust":
								set_node_type = NodeTypes.RUST;
								break;
							case "runtime.java":
								set_node_type = NodeTypes.JAVA;
								break;
							case "runtime.csharp":
								set_node_type = NodeTypes.CSHARP;
								break;
							case "runtime.php":
								set_node_type = NodeTypes.PHP;
								break;
							case "runtime.ruby":
								set_node_type = NodeTypes.RUBY;
								break;
							case "local":
								set_node_type = NodeTypes.LOCAL;
								break;
							default:
								set_node_type = NodeTypes.MODULE;
								break;
						}

						const trigger = Object.keys(workflowModel.trigger)[0];
						const trigger_config =
							((workflowModel.trigger as unknown as ParamsDictionary)[trigger] as unknown as TriggerOpts) || {};

						let remoteNodeName = workflowNameInPath + subPath;
						if (remoteNodeName.substring(remoteNodeName.length - 1) === "/") {
							remoteNodeName = remoteNodeName.substring(0, remoteNodeName.length - 1);
						}

						const step = workflow({
							name: `Remote Node: ${remoteNodeName}`,
							version: "1.0.0",
							description: "Remote Node",
							trigger: { [(trigger as string) || "grpc"]: trigger_config },
							steps: [
								{
									id: "node",
									use: remoteNodeName,
									type: set_node_type,
									inputs: ((workflowModel.nodes as unknown as ParamsDictionary).node as unknown as ParamsDictionary)
										.inputs,
								},
							],
						} as unknown as Parameters<typeof workflow>[0]);

						this.nodeMap.workflows[id] = step;
						workflowNameInPath = id;
						remoteNodeExecution = true;
					}

					// File-based routing path: pass the pre-loaded workflow object
					// directly to Configuration.init so it bypasses the disk lookup.
					// Falls back to the standard nodeMap-resolver path otherwise.
					try {
						if (preloadedWorkflow !== undefined) {
							await this.configuration.init(workflowNameInPath, this.nodeMap, preloadedWorkflow);
						} else {
							await this.configuration.init(workflowNameInPath, this.nodeMap);
						}
					} catch (bootErr) {
						recordBootError("configuration_init", bootErr);
						throw bootErr;
					}
					let ctx: Context = this.createContext(
						undefined,
						workflowNameInPath || (c.req.param("workflow") as string),
						id,
					);

					// For explicit (file-based) routes, Hono already validated the
					// method + matched path params. `c.req.param()` returns the
					// captured params directly. For the catch-all, parse via
					// handleDynamicRoute against the trigger's path pattern.
					let resolvedParams: Record<string, string>;
					if (explicitRoute) {
						const all = (c.req.param() as Record<string, string>) || {};
						const filtered: Record<string, string> = {};
						for (const k of Object.keys(all)) {
							if (k !== "workflow") filtered[k] = all[k];
						}
						resolvedParams = filtered;
					} else {
						resolvedParams = handleDynamicRoute(
							this.configuration.trigger.http.path,
							subPath,
							(c.req.param() as Record<string, string>) || {},
						);
					}

					ctx.logger.log(`Version: ${this.configuration.version}, Method: ${c.req.method}`);

					// Method/path validation only for the catch-all path. Hono
					// already enforced both for explicit routes.
					if (!explicitRoute) {
						const { method, path } = this.configuration.trigger.http;
						if (method && method !== "*" && method !== "ANY" && c.req.method.toLowerCase() !== method.toLowerCase())
							throw new Error("Invalid HTTP method");
						if (!validateRoute(path, subPath)) throw new Error("Invalid HTTP path");
					}

					// Build RequestContext from Hono request
					const url = new URL(c.req.url);
					const queryObj: Record<string, string> = {};
					for (const [key, value] of url.searchParams.entries()) {
						if (key !== "requestId") {
							queryObj[key] = value;
						}
					}

					ctx.request = {
						body,
						rawBody,
						headers: Object.fromEntries([...c.req.raw.headers.entries()]),
						params: resolvedParams,
						query: queryObj,
						method: c.req.method,
						path: explicitRoute ? c.req.path : subPath,
						url: c.req.url,
					} as unknown as RequestContext;

					// F15 · required-header validation. `trigger.http.headers`
					// declares headers the request MUST carry; enforce them at
					// trigger entry (on BOTH explicit and catch-all routes) now that
					// `ctx.request.headers` is populated. A missing/mismatched header
					// short-circuits with 400 before any step runs.
					this.validateRequiredHeaders((ctx.request as unknown as RequestContext).headers);

					// v0.7 · typed-client RPC mount — mirror the input's scalar fields
					// into query + params so a workflow authored for a GET/query or
					// `:param` trigger resolves its inputs through the name-keyed mount.
					if (opts.rpcInput && typeof opts.rpcInput === "object") {
						const flat: Record<string, string> = {};
						for (const [k, v] of Object.entries(opts.rpcInput)) {
							if (v !== null && v !== undefined && typeof v !== "object") flat[k] = String(v);
						}
						const req = ctx.request as unknown as { query: Record<string, string>; params: Record<string, string> };
						req.query = { ...req.query, ...flat };
						req.params = { ...req.params, ...flat };
					}

					// v0.6 · merged middleware chain (process-global → workflow-level
					// → trigger-level). Implementation lives on `TriggerBase`
					// so worker + cron triggers reuse the same merge logic.
					try {
						await this.applyMiddlewareChain(ctx, this.nodeMap);
					} catch (bootErr) {
						recordBootError("middleware", bootErr);
						throw bootErr;
					}

					const response: TriggerResponse = await this.run(ctx);
					ctx = response.ctx;
					const average = response.metrics;

					const end = performance.now();
					ctx.logger.log(`Completed in ${(end - start).toFixed(2)}ms`);

					// Normalize the final response into a `{ data, contentType }`
					// envelope WITHOUT mutating the node's raw return value — this
					// is what stops a `runtime.*` node's content-type from leaking
					// into its JSON body. The content-type is sourced from the
					// SDK's proto `content_type` via the `_stepContentType`
					// side-channel (set by RuntimeAdapterNode, reset per-step by
					// RunnerSteps), defaulting to JSON. See `normalizeResponseEnvelope`.
					const resolvedContentType =
						((ctx as Record<string, unknown>)._stepContentType as string | undefined) || "application/json";
					ctx.response = normalizeResponseEnvelope(ctx.response, resolvedContentType) as typeof ctx.response;

					span.setAttribute("success", true);
					span.setAttribute("Content-Type", ctx.response.contentType ?? "application/json");
					span.setAttribute("workflow_request_id", `${ctx.id}`);
					span.setAttribute("workflow_elapsed_time", `${end - start}`);
					span.setAttribute("workflow_version", `${this.configuration.version}`);
					span.setAttribute("workflow_name", `${this.configuration.name}`);
					span.setAttribute("workflow_memory_avg_mb", `${average.memory.total}`);
					span.setAttribute("workflow_memory_min_mb", `${average.memory.min}`);
					span.setAttribute("workflow_memory_max_mb", `${average.memory.max}`);
					span.setAttribute("workflow_cpu_percentage", `${average.cpu.average}`);
					span.setAttribute("workflow_cpu_total", `${average.cpu.total}`);
					span.setAttribute("workflow_cpu_usage", `${average.cpu.usage}`);
					span.setAttribute("workflow_cpu_model", `${average.cpu.model}`);
					span.setStatus({ code: SpanStatusCode.OK });

					// Emit the response from the finished workflow's ctx.response.
					// Honors a `@blokjs/respond` envelope (status / headers /
					// Set-Cookie / body) and raw binary bodies, falling back to the
					// default JSON / string-200 behaviour. See `responseEmitter.ts`.
					return emitWorkflowResponse(c, ctx.response);
				} catch (e: unknown) {
					span.setAttribute("success", false);
					span.setAttribute("workflow_request_id", `${id}`);
					span.recordException(e as Error);

					// OBS-01 (T5a): removed a dead `workflow_execution.add(0, …)` here.
					// Adding 0 to a counter is a no-op, and this catch also runs for
					// control-flow signals (DeferredDispatchSignal, ConcurrencyLimitError),
					// so even add(1) would over-count. Real workflow error counting is
					// owned by the canonical `blok_workflow_errors_total`
					// (PrometheusMetricsBridge), which fires on genuine run failure.

					// Tier 2 #5 + #7 — scheduling-deferred run. Surface as 202
					// Accepted with a `Location` header pointing at the run's
					// detail endpoint and a structured JSON body. The actual
					// dispatch happens later via the in-process scheduler.
					if (e instanceof DeferredDispatchSignal) {
						const targetRunId = e.info.intoRunId ?? e.info.runId;
						this.logger.log(
							`[scheduling] ${e.info.workflowName} runId=${e.info.runId} status=${e.info.status} ` +
								`scheduledAt=${e.info.scheduledAt}${e.info.expiresAt ? ` expiresAt=${e.info.expiresAt}` : ""} ` +
								`pingCount=${e.info.pingCount} → 202`,
						);
						span.setStatus({ code: SpanStatusCode.OK, message: `deferred:${e.info.status}` });
						c.header("Location", `/__blok/runs/${targetRunId}`);
						return c.json(
							{
								runId: e.info.runId,
								workflowName: e.info.workflowName,
								status: e.info.status,
								scheduledAt: e.info.scheduledAt,
								expiresAt: e.info.expiresAt,
								debounced: e.info.debounced,
								pingCount: e.info.pingCount,
								intoRunId: e.info.intoRunId,
							},
							202,
						);
					}

					// PR 2 A4 — durable scheduler payload too large. Surface as
					// 413 Payload Too Large with structured info so callers know
					// the dispatch was rejected because the body would push the
					// `scheduled_dispatches` row past the configured cap. Operators
					// raise the cap via BLOK_DISPATCH_PAYLOAD_MAX_BYTES (default 1MB).
					if (e instanceof PayloadTooLargeError) {
						span.setStatus({ code: SpanStatusCode.OK, message: "payload_too_large_for_durable_scheduling" });
						this.logger.log(
							`[scheduling] payload too large: ${e.actualBytes} bytes > cap of ${e.maxBytes} bytes → 413`,
						);
						return c.json(
							{
								error: "Payload too large for durable scheduling",
								actualBytes: e.actualBytes,
								maxBytes: e.maxBytes,
								configurable: "BLOK_DISPATCH_PAYLOAD_MAX_BYTES",
							},
							413,
						);
					}

					// PR 1-5 polish — queue-mode TTL elapsed. The tracker already
					// flipped the run to `expired` (see TriggerBase queue branch);
					// surface as 410 Gone (NOT 429) so HTTP clients don't retry a
					// permanently-dead run. No `Retry-After` header — would
					// contradict the 410 contract. Distinct from
					// ConcurrencyLimitError (transient, 429) below.
					if (e instanceof QueueExpiredError) {
						span.setStatus({ code: SpanStatusCode.OK, message: "queue_expired" });
						this.logger.log(
							`[concurrency] ${e.info.workflowName} key='${e.info.concurrencyKey}' ` +
								`queueExpiredAt=${e.info.queueExpiredAt} → 410`,
						);
						return c.json(
							{
								error: "Queued run expired",
								workflowName: e.info.workflowName,
								concurrencyKey: e.info.concurrencyKey,
								queueExpiredAt: e.info.queueExpiredAt,
								runId: e.info.runId,
							},
							410,
						);
					}

					// Tier 2 #6 — concurrency gate denial. Surface as 429 with a
					// Retry-After header (in seconds, rounded up) and a structured
					// JSON body so callers can build smart back-off without
					// parsing the message string.
					if (e instanceof ConcurrencyLimitError) {
						const retryAfterSeconds = Math.max(1, Math.ceil(e.info.retryAfterMs / 1000));
						span.setStatus({ code: SpanStatusCode.OK, message: "concurrency_limit_reached" });
						this.logger.log(
							`[concurrency] ${e.info.workflowName} key='${e.info.concurrencyKey}' ` +
								`limit=${e.info.concurrencyLimit} inFlight=${e.info.currentInFlight} → 429`,
						);
						c.header("Retry-After", String(retryAfterSeconds));
						return c.json(
							{
								error: "Concurrency limit reached",
								workflowName: e.info.workflowName,
								concurrencyKey: e.info.concurrencyKey,
								concurrencyLimit: e.info.concurrencyLimit,
								currentInFlight: e.info.currentInFlight,
								retryAfterMs: e.info.retryAfterMs,
								runId: e.info.runId,
							},
							429,
						);
					}

					if (e instanceof GlobalError) {
						const error_context = e as GlobalError;

						if (error_context.context.message === "{}" && error_context.context.json instanceof DOMException) {
							workflow_runner_errors.add(1, {
								env: process.env.NODE_ENV,
								workflow_version: `${this.configuration?.version || "unknown"}`,
								workflow_name: `${this.configuration?.name || "unknown"}`,
								workflow_path: `${workflowNameInPath}`,
							});
							span.setStatus({
								code: SpanStatusCode.ERROR,
								message: (error_context.context.json as Error).toString(),
							});
							this.logger.error(`${(error_context.context.json as Error).toString()}`);
							return c.json(
								{
									origin: error_context.context.name,
									error: (error_context.context.json as Error).toString(),
								},
								500,
							);
						}

						if (error_context.context.code === undefined) error_context.setCode(500);
						const code = error_context.context.code as number;

						if (error_context.hasJson()) {
							workflow_runner_errors.add(1, {
								env: process.env.NODE_ENV,
								workflow_version: `${this.configuration?.version || "unknown"}`,
								workflow_name: `${this.configuration?.name || "unknown"}`,
								workflow_path: `${workflowNameInPath}`,
							});
							span.setStatus({ code: SpanStatusCode.ERROR, message: JSON.stringify(error_context.context.json) });
							this.logger.error(`${JSON.stringify(error_context.context.json)}`);
							return c.json(error_context.context.json as object, code as 500);
						}

						workflow_runner_errors.add(1, {
							env: process.env.NODE_ENV,
							workflow_version: `${this.configuration?.version || "unknown"}`,
							workflow_name: `${this.configuration?.name || "unknown"}`,
							workflow_path: `${workflowNameInPath}`,
						});
						span.setStatus({ code: SpanStatusCode.ERROR, message: error_context.message });
						this.logger.error(`${error_context.message}`, error_context.stack?.replace(/\n/g, " "));
						return c.json({ error: error_context.message }, code as 500);
					}

					workflow_runner_errors.add(1, {
						env: process.env.NODE_ENV,
						workflow_version: `${this.configuration?.version || "unknown"}`,
						workflow_name: `${this.configuration?.name || "unknown"}`,
						workflow_path: `${workflowNameInPath}`,
					});
					span.setStatus({ code: SpanStatusCode.ERROR, message: (e as Error).message });
					this.logger.error(
						`${workflowNameInPath}: ${(e as Error).message}`,
						`${(e as Error).stack?.replace(/\n/g, " ")}`,
					);
					return c.json({ error: (e as Error).message }, 500);
				} finally {
					if (remoteNodeExecution) {
						delete this.nodeMap.workflows[id];
					}
					span.end();
				}
			},
		);
	}

	// === Tier 2 #5+#7 follow-up · durable scheduling for HTTP delays ===

	/** Header keys that are NEVER persisted to disk (sensitive credentials). */
	private static readonly DISPATCH_HEADER_DENYLIST = new Set([
		"authorization",
		"cookie",
		"set-cookie",
		"x-api-key",
		"x-auth-token",
		"proxy-authorization",
	]);

	/** PR 2 A4 — default 1MB cap on the durable scheduler payload row. */
	private static readonly DEFAULT_DISPATCH_PAYLOAD_MAX_BYTES = 1_048_576;

	private getDispatchPayloadMaxBytes(): number {
		const raw = process.env.BLOK_DISPATCH_PAYLOAD_MAX_BYTES;
		if (!raw || !/^\d+$/.test(raw)) return HttpTrigger.DEFAULT_DISPATCH_PAYLOAD_MAX_BYTES;
		return Number(raw);
	}

	/**
	 * Tier 2 #5+#7 follow-up · extract a JSON-serializable subset of the
	 * Hono-built ctx that's enough for `restoreDispatch()` to reconstruct
	 * an equivalent ctx after a process restart. Sensitive headers are
	 * stripped before persistence.
	 *
	 * PR 2 A4 — caps the serialized payload at `BLOK_DISPATCH_PAYLOAD_MAX_BYTES`
	 * (default 1MB). Throws `PayloadTooLargeError` on overflow; the HTTP
	 * transport translates to 413 Payload Too Large with structured info.
	 * Prevents sqlite bloat + boot-recovery latency on uncapped request bodies.
	 */
	protected override extractDispatchPayload(ctx: Context): unknown {
		const req = ctx.request as RequestContext | undefined;
		if (!req) return null;
		const headers: Record<string, unknown> = {};
		const rawHeaders = (req.headers ?? {}) as Record<string, unknown>;
		for (const [k, v] of Object.entries(rawHeaders)) {
			if (HttpTrigger.DISPATCH_HEADER_DENYLIST.has(k.toLowerCase())) continue;
			headers[k] = v;
		}
		// Security review FW-7 — pipe body/params/query through the
		// sensitive-field redactor before persisting. Without redaction,
		// a delayed POST with `{password, ssn}` writes raw plaintext to
		// scheduled_dispatches.payload_json, which survives until the
		// dispatch fires or the Janitor sweeps the row.
		//
		// `traceRedactSensitive` (vs full `traceSanitize`) skips the
		// 10KB trace-storage truncation — the dispatch path has its
		// own 1MB cap below; double-truncating would silently shrink
		// payloads below the cap into a tiny preview envelope.
		const payload = {
			method: req.method,
			path: req.path,
			url: (req as unknown as { url?: string }).url,
			headers,
			body: traceRedactSensitive(req.body),
			params: traceRedactSensitive(req.params),
			query: traceRedactSensitive(req.query),
			workflowName: ctx.workflow_name,
			workflowPath: ctx.workflow_path,
		};

		// PR 2 A4 · size cap. Serialize once + measure; the same JSON
		// gets written to sqlite by upsertScheduledDispatch.
		const serialized = JSON.stringify(payload);
		const maxBytes = this.getDispatchPayloadMaxBytes();
		if (serialized.length > maxBytes) {
			throw new PayloadTooLargeError(serialized.length, maxBytes);
		}
		return payload;
	}

	/**
	 * Tier 2 #5+#7 follow-up · scan the durable scheduler table on boot
	 * and re-fire HTTP dispatches that were pending when the process died.
	 *
	 * Behavior per row:
	 * - Past-due AND past TTL: mark `expired`, delete the row.
	 * - Past-due, not expired: immediately invoke restoreDispatch.
	 * - Future-scheduled: register a fresh timer pointing at restoreDispatch.
	 *
	 * Idempotent — safe to call multiple times (HMR re-loads, etc.). The
	 * underlying scheduler's `schedule()` replaces existing timers for the
	 * same runId; persisted rows just register the same timer again.
	 *
	 * Skips rows whose `workflowName` doesn't match a workflow this trigger
	 * owns (multi-trigger processes).
	 */
	async recoverDispatches(): Promise<{ recovered: number; expired: number; skipped: number }> {
		const tracker = RunTracker.getInstance();
		if (!tracker.active) return { recovered: 0, expired: 0, skipped: 0 };

		const now = Date.now();
		let recovered = 0;
		let expired = 0;
		let skipped = 0;

		// Tier C #2 — atomically claim eligible rows so multi-process PG
		// deployments don't double-fire. Kill-switch
		// BLOK_SCHEDULER_CLAIM_DISABLED=1 reverts to the legacy
		// getScheduledDispatches path (suitable for sqlite-per-process
		// deployments that want the old behavior).
		const claimDisabled = process.env.BLOK_SCHEDULER_CLAIM_DISABLED === "1";
		let rows: ReturnType<typeof tracker.getStore.prototype.getScheduledDispatches>;
		if (claimDisabled) {
			rows = tracker.getStore().getScheduledDispatches({ triggerType: "http" });
		} else {
			const processId = DeferredRunScheduler.getInstance().getProcessId();
			const leaseMs = getSchedulerClaimLeaseMs();
			// PG stores expose a true async claim API; sync wrappers exist
			// for sqlite/in-memory parity but PG users get the strongest
			// cross-process guarantee by hitting PG directly.
			const store = tracker.getStore();
			const asyncClaim = (
				store as unknown as {
					claimDispatchesAsync?: (
						processId: string,
						leaseMs: number,
						now: number,
						opts?: { triggerType?: string },
					) => Promise<ReturnType<typeof store.claimDispatches>>;
				}
			).claimDispatchesAsync;
			rows = asyncClaim
				? await asyncClaim.call(store, processId, leaseMs, now, { triggerType: "http" })
				: store.claimDispatches(processId, leaseMs, now, { triggerType: "http" });
		}

		for (const row of rows) {
			// Skip rows for workflows this trigger doesn't own. The
			// WorkflowRegistry tracks which workflows are registered;
			// fallback: if the workflow name matches our own configuration,
			// we own it.
			const ownsWorkflow =
				row.workflowName === this.configuration.name || WorkflowRegistry.getInstance().has(row.workflowName);
			if (!ownsWorkflow) {
				skipped++;
				continue;
			}

			// Past TTL → mark expired and delete.
			if (row.expiresAt !== undefined && now > row.expiresAt) {
				tracker.markRunExpired(row.runId, { expiresAt: row.expiresAt, expiredAt: now });
				tracker.getStore().deleteScheduledDispatch(row.runId);
				ConcurrencyMetrics.getInstance().recordDispatchExpired({
					workflow_name: row.workflowName,
					trigger_type: "http",
					dispatch_status: row.dispatchStatus,
				});
				expired++;
				continue;
			}

			// Live (past-due or future): re-register the timer.
			DeferredRunScheduler.getInstance().schedule(
				row.runId,
				row.scheduledAt,
				async () => {
					await this.restoreDispatch(row);
				},
				{
					workflowName: row.workflowName,
					triggerType: "http",
					expiresAt: row.expiresAt,
					dispatchStatus: row.dispatchStatus,
					payload: row.payload,
				},
			);
			ConcurrencyMetrics.getInstance().recordDispatchRecovered({
				workflow_name: row.workflowName,
				trigger_type: "http",
				dispatch_status: row.dispatchStatus,
			});
			recovered++;
		}

		if (recovered + expired > 0) {
			this.logger.log(
				`[scheduling] HTTP dispatch recovery: ${recovered} re-scheduled, ${expired} expired, ${skipped} skipped`,
			);
		}
		return { recovered, expired, skipped };
	}

	/**
	 * Tier 2 #5+#7 follow-up · re-create a Context from a persisted
	 * dispatch payload and re-enter `dispatchDeferred`.
	 *
	 * Public method for testability (call from tests with a hand-built row);
	 * normally invoked by the scheduler timer registered in `recoverDispatches`.
	 */
	async restoreDispatch(row: ScheduledDispatchRow): Promise<void> {
		const payload = (row.payload ?? {}) as {
			method?: string;
			path?: string;
			url?: string;
			headers?: Record<string, unknown>;
			body?: unknown;
			params?: Record<string, string>;
			query?: Record<string, string>;
			workflowName?: string;
			workflowPath?: string;
		};

		const ctx: Context = this.createContext(undefined, payload.workflowPath || "", row.runId);
		ctx.request = {
			body: payload.body,
			headers: (payload.headers ?? {}) as Record<string, string>,
			params: (payload.params ?? {}) as ParamsDictionary,
			query: (payload.query ?? {}) as Record<string, string>,
			method: payload.method ?? "POST",
			path: payload.path ?? "/",
			url: payload.url,
		} as unknown as RequestContext;

		// Stash the existing traceRunId so the re-entered run() reuses it
		// (otherwise a new run would be created with a different id).
		(ctx as Record<string, unknown>)._traceRunId = row.runId;

		await this.dispatchDeferred(ctx, row.runId, row.expiresAt);
	}
}
