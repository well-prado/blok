import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DefaultLogger } from "@blokjs/runner";
import McpTrigger from "@blokjs/trigger-mcp";
import SSETrigger from "@blokjs/trigger-sse";
import WebhookTrigger from "@blokjs/trigger-webhook";
import WebSocketTrigger from "@blokjs/trigger-websocket";
import { type Span, metrics, trace } from "@opentelemetry/api";
import { Hono } from "hono";
import HttpTrigger, { type AppBindings } from "./runner/HttpTrigger.js";

// #721 — `import.meta.main` alone isn't enough: Bun always has it, but Node
// only unflagged it in v22.18.0 (see nodejs/node#57804), and this package's
// own `engines` floor is Node >=18 (it ships as scaffolded-project source,
// compiled and run under whatever Node the end user has). So the guard
// compares realpath'd `process.argv[1]` against this module's own path
// instead — works identically under Bun and every Node version, and
// realpath on both sides means a `bin` symlink or a spawn through a
// different path (e.g. `blokctl dev`'s `bun run <path>`) still resolves to
// the same file.
function isMainModule(moduleUrl: string): boolean {
	if (!process.argv[1]) return false;
	try {
		return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(process.argv[1]);
	} catch {
		return false;
	}
}

export default class App {
	private httpTrigger: HttpTrigger = <HttpTrigger>{};
	private wsTrigger: WebSocketTrigger | null = null;
	private sseTrigger: SSETrigger | null = null;
	private webhookTrigger: WebhookTrigger | null = null;
	private mcpTrigger: McpTrigger | null = null;
	protected trigger_initializer = 0;
	protected initializer = 0;
	protected tracer = trace.getTracer(
		process.env.PROJECT_NAME || "trigger-http-server",
		process.env.PROJECT_VERSION || "0.0.1",
	);
	private logger = new DefaultLogger();
	protected app_cold_start = metrics.getMeter("default").createGauge("initialization", {
		description: "Application cold start",
	});

	constructor() {
		this.initializer = performance.now();
		// v0.7 — share ONE Hono app across HttpTrigger and WebSocketTrigger
		// so HTTP routes + WS upgrade routes multiplex on port 4000. The
		// orchestrator pattern documented in
		// docs/c/devtools/additional-triggers-plan.mdx.
		const app = new Hono<AppBindings>();
		this.httpTrigger = new HttpTrigger(app);
		this.wsTrigger = new WebSocketTrigger(app, this.httpTrigger);
		this.sseTrigger = new SSETrigger(app, this.httpTrigger);
		this.webhookTrigger = new WebhookTrigger(app, this.httpTrigger);
		this.mcpTrigger = new McpTrigger(app, this.httpTrigger);
		// Share the HTTP trigger's node + workflow registry with the
		// sibling triggers so per-event / per-stream / per-webhook / per-MCP
		// workflow runs resolve `branch`, helper nodes, and built-in
		// helpers through the same NodeMap that HTTP requests use.
		const nodeMap = this.httpTrigger.getNodeMap();
		this.wsTrigger.setNodeMap(nodeMap);
		this.sseTrigger.setNodeMap(nodeMap);
		this.webhookTrigger.setNodeMap(nodeMap);
		this.mcpTrigger.setNodeMap(nodeMap);
	}

	async run() {
		await this.tracer.startActiveSpan("initialization", async (span: Span) => {
			// Wire sibling same-port triggers FIRST — they register pre-
			// catch-all and server hooks on HttpTrigger that fire during /
			// after HttpTrigger.listen(). Order:
			//   1. WS + SSE register their hooks here (no routes mounted yet).
			//   2. HttpTrigger.listen() scans + registers workflows in
			//      WorkflowRegistry, fires preCatchAllHooks (WS + SSE
			//      register their routes), mounts the legacy catch-all,
			//      then calls serve(). The serve() ready callback fires
			//      WS's serverHook → injectWebSocket attaches.
			await this.wsTrigger?.listen();
			await this.sseTrigger?.listen();
			await this.webhookTrigger?.listen();
			await this.mcpTrigger?.listen();
			await this.httpTrigger.listen();
			this.initializer = performance.now() - this.initializer;

			this.logger.log(`Server initialized in ${this.initializer.toFixed(2)}ms`);
			this.app_cold_start.record(this.initializer, {
				pid: process.pid,
				env: process.env.NODE_ENV,
				app: process.env.APP_NAME,
			});
			span.end();
		});
	}

	// Expose the Hono app for hosting with serverless functions like AWS Lambda, GC Functions, etc.
	getHttpApp() {
		return this.httpTrigger.getApp();
	}
}

if (isMainModule(import.meta.url) && process.env.DISABLE_TRIGGER_RUN !== "true") {
	new App().run();
}
