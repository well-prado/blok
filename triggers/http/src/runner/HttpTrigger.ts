import type { Server } from "node:http";
import { type Step, Workflow } from "@blok/helper";
import type { TriggerOpts } from "@blok/helper/dist/types/TriggerOpts";
import type { GlobalOptions, HMREvent, ParamsDictionary, TriggerResponse } from "@blok/runner";
import { TriggerBase } from "@blok/runner";
import { NodeMap } from "@blok/runner";
import { DefaultLogger } from "@blok/runner";
import { registerTraceRoutes } from "@blok/runner";
import { type Context, GlobalError, type RequestContext } from "@blok/shared";
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
import { metricsHandler } from "./metrics/opentelemetry_metrics";
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

	listen(): Promise<number> {
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
				registerTraceRoutes(traceAdapter);
				this.app.route("/__blok", traceApp);
			}

			/*
			 * You can add your own middleware or routes with custom Hono logic
			 * to extend this project.
			 */
			this.app.route("/", apps);

			// Catch-all workflow handler
			const workflowHandler = async (c: HonoContext<AppBindings>) => {
				const id: string = c.req.query("requestId") || (uuid() as string);
				let workflowNameInPath: string = c.req.param("workflow") as string;

				// Skip internal paths — these are handled by dedicated routers above
				if (workflowNameInPath === "__blok") {
					return c.json({ error: "Not found" }, 404);
				}

				// Compute the sub-path (equivalent to Express req.path in use() middleware context)
				const fullPath = c.req.path;
				const subPath = workflowNameInPath ? fullPath.slice(1 + workflowNameInPath.length) || "/" : fullPath;

				let remoteNodeExecution = false;
				let runtimeWorkflow: RuntimeWorkflow | undefined;

				// Parse request body for non-GET methods
				let body: unknown = {};
				if (c.req.method !== "GET" && c.req.method !== "HEAD") {
					try {
						const contentType = c.req.header("content-type") || "";
						if (contentType.includes("application/json")) {
							body = await c.req.json();
						} else if (
							contentType.includes("application/x-www-form-urlencoded") ||
							contentType.includes("multipart/form-data")
						) {
							body = await c.req.parseBody();
						} else {
							body = await c.req.text();
						}
					} catch {
						body = {};
					}
				}

				if (c.req.header("x-blok-execute-node") === "true" && c.req.method.toLowerCase() === "post") {
					remoteNodeExecution = true;
					const coder = new MessageDecode();
					const messageContext: Context = coder.requestDecode(body as WorkflowRequest);
					runtimeWorkflow = messageContext as unknown as RuntimeWorkflow;
				}

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
									inputs: ((workflowModel.nodes as unknown as ParamsDictionary).node as unknown as ParamsDictionary)
										.inputs,
								});

							this.nodeMap.workflows[id] = step;
							workflowNameInPath = id;
							remoteNodeExecution = true;
						}

						await this.configuration.init(workflowNameInPath, this.nodeMap);
						let ctx: Context = this.createContext(
							undefined,
							workflowNameInPath || (c.req.param("workflow") as string),
							id,
						);

						const resolvedParams = handleDynamicRoute(
							this.configuration.trigger.http.path,
							subPath,
							(c.req.param() as Record<string, string>) || {},
						);

						ctx.logger.log(`Version: ${this.configuration.version}, Method: ${c.req.method}`);

						const { method, path } = this.configuration.trigger.http;
						if (method && method !== "*" && method !== "ANY" && c.req.method.toLowerCase() !== method.toLowerCase())
							throw new Error("Invalid HTTP method");
						if (!validateRoute(path, subPath)) throw new Error("Invalid HTTP path");

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
							path: subPath,
							url: c.req.url,
						} as unknown as RequestContext;

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

						const data = ctx.response.data;
						c.header("Content-Type", ctx.response.contentType);
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
			};

			this.app.all("/:workflow{.+}/*", workflowHandler);
			this.app.all("/:workflow{.+}", workflowHandler);

			this.server = serve({ fetch: this.app.fetch, port: Number(this.port) }, () => {
				this.logger.log(`Server is running at http://localhost:${this.port}`);

				// Enable HMR in development mode
				if (process.env.BLOK_HMR === "true" || process.env.NODE_ENV === "development") {
					this.enableHotReload();
				}

				done(this.endCounter(this.initializer));
			}) as Server;
		});
	}
}
