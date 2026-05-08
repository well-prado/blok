import type { Server } from "node:http";
import * as path from "node:path";
import { type Step, Workflow } from "@blokjs/helper";
import type { TriggerOpts } from "@blokjs/helper/dist/types/TriggerOpts";
import type { GlobalOptions, HMREvent, ParamsDictionary, TriggerResponse } from "@blokjs/runner";
import { TriggerBase } from "@blokjs/runner";
import { NodeMap } from "@blokjs/runner";
import { DefaultLogger } from "@blokjs/runner";
import { registerTraceRoutes } from "@blokjs/runner";
import { Configuration, Runner, WorkflowRegistry } from "@blokjs/runner";
import { ConcurrencyLimitError } from "@blokjs/runner";
import { QueueExpiredError } from "@blokjs/runner";
import { ConcurrencyMetrics } from "@blokjs/runner";
import { DeferredDispatchSignal } from "@blokjs/runner";
import { DeferredRunScheduler } from "@blokjs/runner";
import { Janitor } from "@blokjs/runner";
import { PayloadTooLargeError } from "@blokjs/runner";
import { RunTracker } from "@blokjs/runner";
import { traceRedactSensitive } from "@blokjs/runner";
import type { TraceAuthorizeFn } from "@blokjs/runner";
import { createConcurrencyBackend } from "@blokjs/runner";
import type { ScheduledDispatchRow } from "@blokjs/runner";
import { type Context, GlobalError, type RequestContext } from "@blokjs/shared";
import type { HttpBindings } from "@hono/node-server";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import { type Span, SpanStatusCode, metrics, trace } from "@opentelemetry/api";
import { Hono, type Context as HonoContext } from "hono";
import { cors } from "hono/cors";
import { v4 as uuid } from "uuid";
import apps from "../AppRoutes";
import nodes from "../Nodes";
import workflows from "../Workflows";
import { createTraceRouterAdapter } from "./HonoTraceRouterAdapter";
import MessageDecode from "./MessageDecode";
import { handleDynamicRoute, validateRoute } from "./Util";
import { type RouteEntry, buildRouteTable } from "./WorkflowRouter";
import { metricsHandler } from "./metrics/opentelemetry_metrics";
import { scanWorkflows } from "./scanWorkflows";
import NodeTypes from "./types/NodeTypes";
import type RuntimeWorkflow from "./types/RuntimeWorkflow";
import type WorkflowRequest from "./types/WorkflowRequest";

type AppBindings = { Bindings: HttpBindings };

export default class HttpTrigger extends TriggerBase {
	private app: Hono<AppBindings> = new Hono<AppBindings>();
	private port: string | number = process.env.PORT || 4000;
	private initializer = 0;
	private nodeMap: GlobalOptions = <GlobalOptions>{};
	private server: Server | null = null;
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

	constructor() {
		super();

		this.initializer = this.startCounter();
		this.loadNodes();
		this.loadWorkflows();
	}

	loadNodes() {
		this.nodeMap.nodes = new NodeMap();
		const nodeKeys = Object.keys(nodes);
		for (const key of nodeKeys) {
			this.nodeMap.nodes.addNode(key, nodes[key]);
		}
	}

	loadWorkflows() {
		this.nodeMap.workflows = workflows;
	}

	/**
	 * Gracefully stop the HTTP server, waiting for in-flight requests to complete.
	 */
	async stop(): Promise<void> {
		await this.waitForInFlightRequests();
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

	protected override async onHmrNodeChange(event: HMREvent): Promise<void> {
		this.hmr?.invalidateModule(event.filePath);
		this.loadNodes();
		console.log(`[HMR] Node reloaded: ${event.relativePath}`);
	}

	getApp(): Hono<AppBindings> {
		return this.app;
	}

	/**
	 * Scan the workflow directories on disk + the manually-registered TS
	 * workflows in `Workflows.ts` and return the route table. Called once
	 * at boot from `listen()` so workflow URLs are decided before serving.
	 *
	 * Off by default. Opt-in via `BLOK_FILE_BASED_ROUTING=true` (or the
	 * shorter `BLOK_ROUTES=v2`). When off, returns an empty table and
	 * routing falls back to the legacy catch-all `/<key>/<path>` scheme.
	 */
	private async buildFileBasedRoutes(): Promise<RouteEntry[]> {
		const enabled = process.env.BLOK_FILE_BASED_ROUTING === "true" || process.env.BLOK_ROUTES === "v2";
		if (!enabled) return [];

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

		const manual = Object.keys(workflows ?? {}).map((key) => ({
			key,
			workflow: (workflows as Record<string, unknown>)[key],
		}));

		const table = buildRouteTable(scannedJson, manual, {
			onWarning: (msg) => this.logger.log(`[blok] route warning: ${msg}`),
		});

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
		const registered = new Set<string>();
		for (const r of table) {
			const wfName = (r.workflow as { name?: string })?.name ?? r.workflowKey;
			if (registered.has(wfName)) continue;
			registered.add(wfName);
			registry.register({
				name: wfName,
				source: r.source,
				workflow: r.workflow,
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
			const wfObj = sw.workflow as { name?: unknown; middleware?: unknown } | undefined;
			if (!wfObj || wfObj.middleware !== true) continue;
			const wfName = typeof wfObj.name === "string" ? wfObj.name : sw.name;
			if (!wfName) continue;
			if (registered.has(wfName)) continue;
			registered.add(wfName);
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
	 * v0.5 · scan WORKFLOWS_PATH/json/ for middleware-only workflows
	 * (`middleware: true`) and register them in WorkflowRegistry. Runs
	 * even when file-based routing is OFF — the catch-all dispatch path
	 * also honours `trigger.http.middleware: [...]` references and needs
	 * the middleware registry populated.
	 *
	 * Idempotent: if `buildFileBasedRoutes` already ran (file-based
	 * routing enabled) and registered these entries, this skips re-adding
	 * the same `(name, source)` pairs. Non-middleware workflows that
	 * already claim a name win (no overwrite).
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
		let count = 0;
		for (const sw of scanned) {
			const wfObj = sw.workflow as { name?: unknown; middleware?: unknown } | undefined;
			if (!wfObj || wfObj.middleware !== true) continue;
			const wfName = typeof wfObj.name === "string" ? wfObj.name : sw.name;
			if (!wfName) continue;
			const existing = registry.get(wfName);
			if (existing && !existing.isMiddleware) continue;
			if (existing && existing.source === sw.source) continue;
			registry.register({
				name: wfName,
				source: sw.source,
				workflow: sw.workflow,
				isMiddleware: true,
			});
			count++;
		}
		if (count > 0) {
			this.logger.log(`[blok] middleware registry — ${count} middleware workflow(s) registered (catch-all path)`);
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
				const body = await this.parseBody(c);
				return this.runWorkflowExecution(c, {
					workflowName: route.workflowKey,
					subPath: "/",
					body,
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
	 */
	private async parseBody(c: HonoContext<AppBindings>): Promise<unknown> {
		if (c.req.method === "GET" || c.req.method === "HEAD") return {};
		try {
			const contentType = c.req.header("content-type") || "";
			if (contentType.includes("application/json")) return await c.req.json();
			if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
				return await c.req.parseBody();
			}
			return await c.req.text();
		} catch {
			return {};
		}
	}

	async listen(): Promise<number> {
		// File-based routing — scan workflow folders, build the route table,
		// and register each entry as an explicit Hono route BEFORE the
		// catch-all. Off by default; opt-in via BLOK_FILE_BASED_ROUTING=true.
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

		return new Promise((done) => {
			// Static files
			this.app.use("/public/*", serveStatic({ root: "./" }));

			// CORS
			this.app.use(cors());

			// Health check
			this.app.all("/health-check", (c) => {
				return c.text("Online and ready for action", 200);
			});

			// Prometheus metrics — uses raw Node.js req/res since the
			// OpenTelemetry Prometheus exporter expects (IncomingMessage, ServerResponse)
			this.app.get("/metrics", (c) => {
				try {
					metricsHandler(c.env.incoming, c.env.outgoing);
					return RESPONSE_ALREADY_SENT;
				} catch (error) {
					return c.text("Error serving metrics", 500);
				}
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
			// dispatch. Empty when BLOK_FILE_BASED_ROUTING is off.
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

				const body = await this.parseBody(c);

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
					requestId,
					remoteNodeExecution,
					runtimeWorkflow,
				});
			};

			this.app.all("/:workflow{.+}/*", workflowHandler);
			this.app.all("/:workflow{.+}", workflowHandler);

			this.server = serve({ fetch: this.app.fetch, port: Number(this.port) }, () => {
				this.logger.log(`Server is running at http://localhost:${this.port}`);

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

				// Tier 2 #6 follow-up · install the cross-process concurrency
				// backend (NATS KV) when the operator opted in via
				// `BLOK_CONCURRENCY_BACKEND=nats-kv`. Default null = the existing
				// in-process behavior is preserved (zero overhead).
				//
				// PR 3 D1 — record install attempts via OTel counter so the
				// silent fallback (connect failure → in-process) is visible.
				try {
					const backend = createConcurrencyBackend();
					if (backend) {
						backend
							.connect()
							.then(() => {
								RunTracker.getInstance().setConcurrencyBackend(backend);
								ConcurrencyMetrics.getInstance().recordBackendInstall({
									backend: backend.name,
									status: "success",
								});
								this.logger.log(`[concurrency] backend installed: ${backend.name}`);
							})
							.catch((err: unknown) => {
								ConcurrencyMetrics.getInstance().recordBackendInstall({
									backend: backend.name,
									status: "failure",
								});
								this.logger.error(
									`[concurrency] backend connect failed (${backend.name}): ${err instanceof Error ? err.message : String(err)}; falling back to in-process behavior`,
								);
							});
					}
				} catch (err) {
					ConcurrencyMetrics.getInstance().recordBackendInstall({
						backend: "unknown",
						status: "failure",
					});
					this.logger.error(
						`[concurrency] createConcurrencyBackend failed: ${err instanceof Error ? err.message : String(err)}`,
					);
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
	/**
	 * v0.5 · dispatch a chain of middleware workflows on the same parent ctx.
	 *
	 * Each entry in `names` is the `name:` of a workflow registered with
	 * `middleware: true`. For each:
	 *
	 * - Materialize a fresh `Configuration` for the middleware (resolves
	 *   its inner steps + nodes against the same nodeMap as the main
	 *   workflow — so `@blokjs/throw` etc. resolve from `@blokjs/helpers`).
	 * - Save the parent ctx.config; swap in the middleware's resolved
	 *   nodeConfig (`mwConfig.nodes`) so the blueprint mapper finds the
	 *   middleware's step inputs.
	 * - Run via `new Runner(...).run(ctx, { deep: true })` — `deep: true`
	 *   prevents the inner runSteps from inheriting the outer run's
	 *   `lastCompletedStepIndex` cursor (PR 4 wait/resume hazard).
	 * - Restore parent ctx.config in `finally`.
	 *
	 * State mutations from middleware (e.g. `ctx.state.identity` from
	 * auth-check) carry forward to subsequent middleware AND the main
	 * workflow because they share the same ctx.
	 *
	 * Short-circuit: middleware author throws (typically via `@blokjs/throw`
	 * with a `code:` and `body:`). The throw propagates to the outer catch
	 * in `runWorkflowExecution`, which uses the GlobalError's structured
	 * code+body fields to format the HTTP response. The main workflow does
	 * NOT run when middleware throws.
	 *
	 * Missing middleware (name not registered) is a configuration error —
	 * we throw a clear message naming the unknown middleware.
	 */
	private async runMiddlewareChain(ctx: Context, names: readonly string[]): Promise<void> {
		const registry = WorkflowRegistry.getInstance();
		for (const mwName of names) {
			const entry = registry.getMiddleware(mwName);
			if (!entry) {
				const known = registry
					.list()
					.filter((e) => e.isMiddleware)
					.map((e) => e.name);
				const knownStr = known.length > 0 ? known.join(", ") : "(none registered)";
				throw new Error(
					`[blok] middleware "${mwName}" not found in WorkflowRegistry. Available middleware: ${knownStr}. Make sure the middleware workflow has \`"middleware": true\` set at the workflow root and is in a scanned WORKFLOWS_PATH directory.`,
				);
			}

			const mwConfig = new Configuration();
			await mwConfig.init(mwName, this.nodeMap, entry.workflow);

			const parentConfig = ctx.config;
			(ctx as { config: unknown }).config = mwConfig.nodes;
			// Sentinel so RunnerSteps can tag every NodeRun emitted during
			// this middleware's execution with `middleware: mwName`. Studio
			// reads that field to render a `mw:<name>` badge on the inner
			// step rows so operators can see which middleware in the chain
			// produced each nested step.
			(ctx as { _blokMiddlewareName?: string })._blokMiddlewareName = mwName;
			try {
				const mwRunner = new Runner(mwConfig.steps as unknown as ConstructorParameters<typeof Runner>[0]);
				await mwRunner.run(ctx, { deep: true, stepName: `mw:${mwName}` });
			} finally {
				(ctx as { config: unknown }).config = parentConfig;
				(ctx as { _blokMiddlewareName?: string })._blokMiddlewareName = undefined;
			}
		}
	}

	private async runWorkflowExecution(
		c: HonoContext<AppBindings>,
		opts: {
			workflowName: string;
			subPath: string;
			body: unknown;
			requestId: string;
			explicitRoute?: boolean;
			preloadedWorkflow?: unknown;
			remoteNodeExecution?: boolean;
			runtimeWorkflow?: RuntimeWorkflow;
		},
	): Promise<Response> {
		const id = opts.requestId;
		let workflowNameInPath = opts.workflowName;
		const subPath = opts.subPath;
		const body = opts.body;
		const explicitRoute = opts.explicitRoute === true;
		let remoteNodeExecution = opts.remoteNodeExecution === true;
		const runtimeWorkflow = opts.runtimeWorkflow;
		const preloadedWorkflow = opts.preloadedWorkflow;

		const defaultMeter = metrics.getMeter("default");
		const workflow_runner_errors = defaultMeter.createCounter("workflow_errors", {
			description: "Workflow runner errors",
		});
		const workflow_execution = defaultMeter.createCounter("workflow", {
			description: "Workflow requests",
		});

		return this.tracer.startActiveSpan(`${workflowNameInPath}`, async (span: Span) => {
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

					const step: Step = Workflow({
						name: `Remote Node: ${remoteNodeName}`,
						version: "1.0.0",
						description: "Remote Node",
					})
						.addTrigger((trigger as unknown as "http") || "grpc", trigger_config)
						.addStep({
							name: "node",
							node: remoteNodeName,
							type: set_node_type,
							inputs: ((workflowModel.nodes as unknown as ParamsDictionary).node as unknown as ParamsDictionary).inputs,
						});

					this.nodeMap.workflows[id] = step;
					workflowNameInPath = id;
					remoteNodeExecution = true;
				}

				// File-based routing path: pass the pre-loaded workflow object
				// directly to Configuration.init so it bypasses the disk lookup.
				// Falls back to the standard nodeMap-resolver path otherwise.
				if (preloadedWorkflow !== undefined) {
					await this.configuration.init(workflowNameInPath, this.nodeMap, preloadedWorkflow);
				} else {
					await this.configuration.init(workflowNameInPath, this.nodeMap);
				}
				let ctx: Context = this.createContext(undefined, workflowNameInPath || (c.req.param("workflow") as string), id);

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
					headers: Object.fromEntries([...c.req.raw.headers.entries()]),
					params: resolvedParams,
					query: queryObj,
					method: c.req.method,
					path: explicitRoute ? c.req.path : subPath,
					url: c.req.url,
				} as unknown as RequestContext;

				// v0.5 · trigger-level middleware chain. Each named middleware
				// is a workflow with `middleware: true`; we materialize a
				// fresh Configuration per middleware and run its steps on the
				// SAME parent ctx so state mutations (e.g. ctx.state.identity
				// from auth-check) carry forward to the main workflow.
				// Middleware errors propagate to the outer catch — `@blokjs/throw`
				// with `code: 401` produces a 401 HTTP response naturally.
				const httpTriggerCfg = (this.configuration.trigger as { http?: { middleware?: unknown } } | undefined)?.http;
				const middlewareNames = Array.isArray(httpTriggerCfg?.middleware)
					? (httpTriggerCfg.middleware as unknown[]).filter((n): n is string => typeof n === "string" && n.length > 0)
					: [];
				if (middlewareNames.length > 0) {
					await this.runMiddlewareChain(ctx, middlewareNames);
				}

				const response: TriggerResponse = await this.run(ctx);
				ctx = response.ctx;
				const average = response.metrics;

				const end = performance.now();
				ctx.logger.log(`Completed in ${(end - start).toFixed(2)}ms`);

				if (ctx.response.contentType === undefined || ctx.response.contentType === "")
					ctx.response.contentType = "application/json";

				span.setAttribute("success", true);
				span.setAttribute("Content-Type", ctx.response.contentType);
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

				// Support both module nodes (wrapped BlokResponse with .data/.contentType)
				// and runtime adapter nodes (raw data without wrapper)
				const hasWrapper =
					ctx.response && typeof ctx.response === "object" && "data" in ctx.response && "contentType" in ctx.response;
				const data = hasWrapper ? ctx.response.data : ctx.response;
				const contentType = hasWrapper ? ctx.response.contentType : "application/json";
				c.header("Content-Type", contentType);
				if (typeof data === "string") {
					return c.body(data, 200);
				}
				return c.json(data as object, 200);
			} catch (e: unknown) {
				span.setAttribute("success", false);
				span.setAttribute("workflow_request_id", `${id}`);
				span.recordException(e as Error);

				workflow_execution.add(0, {
					env: process.env.NODE_ENV,
					workflow_version: `${this.configuration?.version || "unknown"}`,
					workflow_name: `${this.configuration?.name || "unknown"}`,
					workflow_path: `${workflowNameInPath}`,
				});

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
					this.logger.log(`[scheduling] payload too large: ${e.actualBytes} bytes > cap of ${e.maxBytes} bytes → 413`);
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
		});
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

		const rows = tracker.getStore().getScheduledDispatches({ triggerType: "http" });
		const now = Date.now();
		let recovered = 0;
		let expired = 0;
		let skipped = 0;

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
