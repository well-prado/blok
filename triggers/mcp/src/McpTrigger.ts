/**
 * McpTrigger — Model Context Protocol trigger. Exposes Blok workflows as
 * MCP **tools** (and **resources**) to external clients (Cursor, Claude
 * Code, …) over two transports multiplexed on the shared Hono port:
 *
 *   - **SSE (legacy 2024-11-05)** — `GET <path>/sse` opens the stream and
 *     announces `POST <path>/messages?sessionId=…` for JSON-RPC. This is the
 *     2-endpoint shape existing IDE configs expect (drop-in parity).
 *   - **Streamable-HTTP** — a single `<path>` endpoint (the current official
 *     remote transport), served statelessly via the SDK's web-standard
 *     transport directly off `c.req.raw`.
 *
 * **Authoring surface** — a workflow opts in with `trigger.mcp`:
 *
 * ```ts
 * export default workflow({
 *   name: "search_code",
 *   version: "1.0.0",
 *   input: z.object({ query: z.string(), limit: z.number().optional() }),
 *   trigger: { mcp: { path: "/mcp", serverName: "tetrix-platform",
 *                     tool: { description: "Full-text search the indexed code" } } },
 *   steps: [ { id: "search", use: "@tetrix/meili-search", inputs: { query: $.req.body.query } } ],
 * });
 * ```
 *
 * Every workflow sharing the same `path` + `serverName` is aggregated into one
 * MCP server. Each tool's `inputSchema` is generated from the workflow's `input`
 * Zod schema (via zod-to-json-schema). On `tools/call` the trigger runs the
 * mapped workflow through the runner — so every call is a Blok Studio run with
 * tracing / retries / idempotency for free.
 *
 * **Hono integration:** identical to `SSETrigger`/`WebhookTrigger` — accepts the
 * shared `Hono` app + an optional `HttpTriggerLike` exposing `addPreCatchAllHook`
 * so routes register AFTER the workflow registry is populated but BEFORE the
 * legacy `/:workflow{.+}` catch-all.
 *
 * **Identity:** an `x-user-context` header (or `?user_context=`) carrying base64
 * `{userId,email}` is parsed per connection and passed to the workflow ctx for
 * credential injection. It is NOT access control — there is no scoping here
 * (that's the app's call). Tokens are never logged (the global sanitizer middleware
 * handles redaction).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
	DefaultLogger,
	type GlobalOptions as RunnerGlobalOptions,
	TriggerBase,
	WorkflowRegistry,
} from "@blokjs/runner";
import type { Context, RequestContext } from "@blokjs/shared";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import { Server as McpSdkServer } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
	CallToolRequestSchema,
	ListResourcesRequestSchema,
	ListToolsRequestSchema,
	ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { type Span, SpanStatusCode, metrics, trace } from "@opentelemetry/api";
import type { Hono, Context as HonoContext } from "hono";
import { v4 as uuid } from "uuid";
import { zodToJsonSchema } from "zod-to-json-schema";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/** Parsed `x-user-context` identity (credential injection only — never scoping). */
export interface McpUserContext {
	userId: string;
	email: string;
}

type McpTransportKind = "sse" | "streamable-http";

interface McpToolMeta {
	name?: string;
	description?: string;
}
interface McpResourceMeta {
	uri: string;
	name?: string;
	description?: string;
	mimeType?: string;
}

/** Loosely-read `trigger.mcp` config (validated at workflow load by the helper). */
interface McpTriggerConfig {
	path: string;
	serverName?: string;
	serverVersion?: string;
	transports?: McpTransportKind[];
	tool?: McpToolMeta;
	resource?: McpResourceMeta;
	middleware?: string[];
}

interface HttpTriggerLike {
	addPreCatchAllHook(cb: () => void | Promise<void>): void;
}

/** A workflow exposed as an MCP tool. */
interface ToolEntry {
	workflowName: string;
	toolName: string;
	description: string;
	// biome-ignore lint/suspicious/noExplicitAny: workflow `input` is an opaque ZodType
	inputZod: any | undefined;
}

/** A workflow exposed as an MCP resource. */
interface ResourceEntry {
	workflowName: string;
	uri: string;
	name: string;
	description?: string;
	mimeType: string;
}

/** All workflows that share a (path, serverName) form one MCP server. */
interface ServerGroup {
	path: string;
	serverName: string;
	serverVersion: string;
	transports: McpTransportKind[];
	tools: ToolEntry[];
	resources: ResourceEntry[];
}

const DEFAULT_SERVER_NAME = "blok-mcp";
const DEFAULT_SERVER_VERSION = "1.0.0";
const DEFAULT_TRANSPORTS: McpTransportKind[] = ["sse", "streamable-http"];

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Parse a base64-encoded `{userId,email}` identity string. Returns null on any failure. */
export function parseUserContext(value: string | undefined | null): McpUserContext | null {
	if (!value || typeof value !== "string") return null;
	try {
		const decoded = Buffer.from(value, "base64").toString("utf-8");
		if (!decoded || decoded.trim() === "null") return null;
		const ctx = JSON.parse(decoded) as { userId?: string; email?: string };
		if (!ctx || typeof ctx.userId !== "string") return null;
		return { userId: ctx.userId, email: typeof ctx.email === "string" ? ctx.email : "unknown" };
	} catch {
		return null;
	}
}

/** Convert a Zod schema to a JSON-Schema object suitable for an MCP tool `inputSchema`. */
// biome-ignore lint/suspicious/noExplicitAny: zod schema is opaque here
function toInputJsonSchema(inputZod: any | undefined): { type: "object"; [k: string]: unknown } {
	const empty = { type: "object" as const, properties: {}, additionalProperties: true };
	if (!inputZod || typeof inputZod !== "object" || typeof inputZod.safeParse !== "function") {
		return empty;
	}
	try {
		const json = zodToJsonSchema(inputZod, { target: "jsonSchema7", $refStrategy: "none" }) as Record<string, unknown>;
		// biome-ignore lint/performance/noDelete: strip JSON-Schema meta the MCP client doesn't need
		delete json.$schema;
		if (json.type !== "object") {
			return { ...empty, _wrapped: json } as { type: "object"; [k: string]: unknown };
		}
		return json as { type: "object"; [k: string]: unknown };
	} catch {
		return empty;
	}
}

// -----------------------------------------------------------------------------
// Trigger
// -----------------------------------------------------------------------------

export default class McpTrigger extends TriggerBase {
	protected nodeMap: RunnerGlobalOptions = {} as RunnerGlobalOptions;
	protected readonly logger = new DefaultLogger();
	protected readonly tracer = trace.getTracer(
		process.env.PROJECT_NAME || "trigger-mcp-workflow",
		process.env.PROJECT_VERSION || "0.0.1",
	);
	private readonly meter = metrics.getMeter("blok");
	private readonly counterToolCalls = this.meter.createCounter("blok_mcp_tool_calls_total", {
		description: "MCP tools/call dispatches.",
		unit: "1",
	});
	private readonly counterSessions = this.meter.createCounter("blok_mcp_sse_sessions_total", {
		description: "MCP SSE sessions opened.",
		unit: "1",
	});

	// biome-ignore lint/suspicious/noExplicitAny: Hono generic propagation (matches SSE/WS triggers)
	private readonly app: Hono<any, any, any>;
	private readonly httpTrigger: HttpTriggerLike | null;
	private wired = false;

	/** Live SSE sessions: sessionId → { transport, server, userContext }. */
	private sseSessions = new Map<
		string,
		{ transport: SSEServerTransport; server: McpSdkServer; userContext: McpUserContext | null }
	>();

	// biome-ignore lint/suspicious/noExplicitAny: matches `app` field generic
	constructor(app: Hono<any, any, any>, httpTrigger?: HttpTriggerLike) {
		super();
		this.app = app;
		this.httpTrigger = httpTrigger ?? null;
		_setActiveMcpTrigger(this);
	}

	/** Inject the runner's GlobalOptions (nodes + workflows). Called before `listen()`. */
	setNodeMap(nodeMap: RunnerGlobalOptions): void {
		this.nodeMap = nodeMap;
	}

	async listen(): Promise<number> {
		const startTime = this.startCounter();
		if (this.wired) {
			this.logger.log("[blok][mcp] listen() called twice; ignoring");
			return this.endCounter(startTime);
		}
		this.wired = true;

		if (this.httpTrigger) {
			this.httpTrigger.addPreCatchAllHook(() => this.registerRoutesFromRegistry());
		} else {
			this.registerRoutesFromRegistry();
		}
		return this.endCounter(startTime);
	}

	async stop(): Promise<void> {
		for (const { transport } of this.sseSessions.values()) {
			try {
				await transport.close();
			} catch {
				/* ignore */
			}
		}
		this.sseSessions.clear();
		this.wired = false;
		if (_getActiveMcpTrigger() === this) _setActiveMcpTrigger(null);
		this.destroyMonitoring();
		this.logger.log("[blok][mcp] stopped");
	}

	getStats(): { sessions: number } {
		return { sessions: this.sseSessions.size };
	}

	// ---------------------------------------------------------------------------
	// Registry scan + grouping
	// ---------------------------------------------------------------------------

	private registerRoutesFromRegistry(): void {
		const groups = this.getServerGroups();
		if (groups.length === 0) {
			this.logger.log("[blok][mcp] no workflows with trigger.mcp found");
			return;
		}
		for (const group of groups) {
			this.registerGroupRoutes(group);
		}
	}

	private getServerGroups(): ServerGroup[] {
		const registry = WorkflowRegistry.getInstance();
		const byPath = new Map<string, ServerGroup>();

		for (const entry of registry.list()) {
			// Workflows registered as builders expose config on `_config`; plain
			// objects (tests / JSON) expose it at the top level.
			const wf = (entry.workflow as { _config?: unknown })?._config ?? entry.workflow;
			const cfg = (wf as { trigger?: { mcp?: McpTriggerConfig } })?.trigger?.mcp;
			if (!cfg || typeof cfg.path !== "string") continue;

			const path = cfg.path;
			let group = byPath.get(path);
			if (!group) {
				group = {
					path,
					serverName: cfg.serverName || DEFAULT_SERVER_NAME,
					serverVersion: cfg.serverVersion || DEFAULT_SERVER_VERSION,
					transports: Array.isArray(cfg.transports) && cfg.transports.length > 0 ? cfg.transports : DEFAULT_TRANSPORTS,
					tools: [],
					resources: [],
				};
				byPath.set(path, group);
			}

			if (cfg.resource && typeof cfg.resource.uri === "string") {
				group.resources.push({
					workflowName: entry.name,
					uri: cfg.resource.uri,
					name: cfg.resource.name || entry.name,
					description: cfg.resource.description,
					mimeType: cfg.resource.mimeType || "application/json",
				});
			} else {
				const inputZod = (wf as { input?: unknown })?.input;
				group.tools.push({
					workflowName: entry.name,
					toolName: cfg.tool?.name || entry.name,
					description: cfg.tool?.description || `Run the "${entry.name}" workflow.`,
					inputZod,
				});
			}
		}

		return [...byPath.values()];
	}

	// ---------------------------------------------------------------------------
	// MCP server factory (one per request/session, bound to a user context)
	// ---------------------------------------------------------------------------

	private buildServer(group: ServerGroup, getUserContext: () => McpUserContext | null): McpSdkServer {
		const server = new McpSdkServer(
			{ name: group.serverName, version: group.serverVersion },
			{ capabilities: { tools: {}, resources: {} } },
		);

		server.setRequestHandler(ListToolsRequestSchema, async () => ({
			tools: group.tools.map((t) => ({
				name: t.toolName,
				description: t.description,
				inputSchema: toInputJsonSchema(t.inputZod),
			})),
		}));

		server.setRequestHandler(CallToolRequestSchema, async (req) => {
			const toolName = req.params.name;
			const tool = group.tools.find((t) => t.toolName === toolName);
			if (!tool) {
				return { content: [{ type: "text", text: `Unknown tool: ${toolName}` }], isError: true };
			}
			const args = (req.params.arguments ?? {}) as Record<string, unknown>;
			return this.dispatchTool(tool, args, getUserContext());
		});

		if (group.resources.length > 0) {
			server.setRequestHandler(ListResourcesRequestSchema, async () => ({
				resources: group.resources.map((r) => ({
					uri: r.uri,
					name: r.name,
					description: r.description,
					mimeType: r.mimeType,
				})),
			}));

			server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
				const uri = req.params.uri;
				const resource = group.resources.find((r) => r.uri === uri);
				if (!resource) throw new Error(`Unknown resource: ${uri}`);
				const result = await this.dispatchResource(resource, getUserContext());
				const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
				return { contents: [{ uri: resource.uri, mimeType: resource.mimeType, text }] };
			});
		}

		return server;
	}

	// ---------------------------------------------------------------------------
	// Workflow dispatch (tools/call + resources/read run through the runner)
	// ---------------------------------------------------------------------------

	private async dispatchTool(
		tool: ToolEntry,
		args: Record<string, unknown>,
		userContext: McpUserContext | null,
	): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
		this.counterToolCalls.add(1, { tool: tool.toolName });
		try {
			const data = await this.runWorkflow(tool.workflowName, args, userContext, `mcp.tool:${tool.toolName}`);
			const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
			return { content: [{ type: "text", text }] };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.logger.error(`[blok][mcp] tool "${tool.toolName}" failed: ${msg}`);
			// Tool failure → MCP tool error result, NOT a transport crash.
			return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
		}
	}

	private async dispatchResource(resource: ResourceEntry, userContext: McpUserContext | null): Promise<unknown> {
		return this.runWorkflow(resource.workflowName, {}, userContext, `mcp.resource:${resource.uri}`);
	}

	/**
	 * Run a workflow through the runner and return `ctx.response.data`. Mirrors
	 * the WebhookTrigger request→response dispatch (init → context → middleware →
	 * run). MCP tool calls within a session are serial, matching the shared
	 * `this.configuration` lifecycle the other triggers use.
	 */
	private async runWorkflow(
		workflowName: string,
		args: Record<string, unknown>,
		userContext: McpUserContext | null,
		spanLabel: string,
	): Promise<unknown> {
		const requestId = uuid();
		return this.tracer.startActiveSpan(`mcp:${workflowName}`, async (span: Span) => {
			try {
				const registry = WorkflowRegistry.getInstance();
				const entry = registry.get(workflowName);
				if (!entry) throw new Error(`workflow "${workflowName}" not found in registry`);
				await this.configuration.init(workflowName, this.nodeMap, entry.workflow);

				const headers: Record<string, string> = {};
				if (userContext) {
					// Carry identity to the workflow exactly as HTTP would (base64 header).
					headers["x-user-context"] = Buffer.from(JSON.stringify(userContext), "utf-8").toString("base64");
				}

				const ctx: Context = this.createContext(undefined, workflowName, requestId);
				ctx.request = {
					body: args,
					headers,
					params: {},
					query: {},
				} as unknown as RequestContext;
				(ctx as Record<string, unknown>)._mcp = { userContext };

				await this.applyMiddlewareChain(ctx, this.nodeMap);
				await this.run(ctx);

				span.setAttribute("workflow_name", workflowName);
				span.setAttribute("mcp_label", spanLabel);
				span.setStatus({ code: SpanStatusCode.OK });

				const data = ctx.response?.data;
				// #436 — when BLOK_VALIDATE_WORKFLOW_OUTPUT is on, validate the result
				// against the workflow's declared `output` Zod (reached via `_config`,
				// same as the tool inputSchema derivation). A failure THROWS, which
				// dispatchTool turns into a proper MCP error result (isError:true) —
				// never a raw 500 / transport crash. No declared output → pass through.
				const validateOutput =
					process.env.BLOK_VALIDATE_WORKFLOW_OUTPUT === "1" || process.env.BLOK_VALIDATE_WORKFLOW_OUTPUT === "true";
				if (validateOutput) {
					const wf = (entry.workflow as { _config?: unknown })?._config ?? entry.workflow;
					const outputZod = (wf as { output?: { safeParse?: (d: unknown) => unknown } } | undefined)?.output;
					if (outputZod && typeof outputZod.safeParse === "function") {
						const parsed = outputZod.safeParse(data) as {
							success: boolean;
							data?: unknown;
							error?: { message: string };
						};
						if (!parsed.success) {
							throw new Error(
								`workflow "${workflowName}" output failed validation against workflow.output: ${parsed.error?.message ?? "invalid output"}`,
							);
						}
						return parsed.data;
					}
				}
				return data;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				span.recordException(err as Error);
				span.setStatus({ code: SpanStatusCode.ERROR, message: msg });
				throw err;
			} finally {
				span.end();
			}
		});
	}

	// ---------------------------------------------------------------------------
	// Route registration (SSE + Streamable-HTTP)
	// ---------------------------------------------------------------------------

	private registerGroupRoutes(group: ServerGroup): void {
		this.logger.log(
			`[blok][mcp] server "${group.serverName}" at ${group.path} — ${group.tools.length} tool(s), ${group.resources.length} resource(s), transports=[${group.transports.join(",")}]`,
		);

		if (group.transports.includes("sse")) {
			this.registerSseRoutes(group);
		}
		if (group.transports.includes("streamable-http")) {
			this.registerStreamableHttpRoute(group);
		}
	}

	private registerSseRoutes(group: ServerGroup): void {
		const ssePath = `${group.path}/sse`;
		const messagesPath = `${group.path}/messages`;
		this.logger.log(`[blok][mcp]   GET  ${ssePath}   POST ${messagesPath}  (sse)`);

		// GET <path>/sse — open the SSE stream; SDK announces the messages endpoint.
		this.app.get(ssePath, async (c: HonoContext) => {
			const env = c.env as unknown as { incoming: IncomingMessage; outgoing: ServerResponse };
			if (!env?.outgoing) {
				return c.text("MCP SSE transport requires the Node server (@hono/node-server).", 500);
			}
			const rawUserCtx =
				c.req.header("x-user-context") || (new URL(c.req.url).searchParams.get("user_context") ?? undefined);
			const userContext = parseUserContext(rawUserCtx);

			const transport = new SSEServerTransport(messagesPath, env.outgoing);
			const sessionId = transport.sessionId;
			const server = this.buildServer(group, () => this.sseSessions.get(sessionId)?.userContext ?? null);
			this.sseSessions.set(sessionId, { transport, server, userContext });
			this.counterSessions.add(1, { server: group.serverName });

			transport.onclose = () => {
				this.sseSessions.delete(sessionId);
			};

			try {
				await server.connect(transport);
			} catch (err) {
				this.sseSessions.delete(sessionId);
				const msg = err instanceof Error ? err.message : String(err);
				this.logger.error(`[blok][mcp] sse connect failed: ${msg}`);
			}
			return RESPONSE_ALREADY_SENT;
		});

		// POST <path>/messages?sessionId=… — JSON-RPC messages for an open stream.
		this.app.post(messagesPath, async (c: HonoContext) => {
			const env = c.env as unknown as { incoming: IncomingMessage; outgoing: ServerResponse };
			const sessionId = new URL(c.req.url).searchParams.get("sessionId") ?? undefined;
			if (!sessionId) return c.text("Missing sessionId query parameter", 400);
			const session = this.sseSessions.get(sessionId);
			if (!session) return c.text("Session not found", 404);
			const body = await c.req.json().catch(() => undefined);
			try {
				await session.transport.handlePostMessage(env.incoming, env.outgoing, body);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				this.logger.error(`[blok][mcp] handlePostMessage failed: ${msg}`);
				if (!env.outgoing.headersSent) return c.text("Error handling MCP message", 500);
			}
			return RESPONSE_ALREADY_SENT;
		});
	}

	private registerStreamableHttpRoute(group: ServerGroup): void {
		this.logger.log(`[blok][mcp]   ALL  ${group.path}  (streamable-http)`);

		// Stateless Streamable-HTTP: a fresh server + transport per request, served
		// directly off the Fetch `Request` (works on any Hono runtime).
		this.app.all(group.path, async (c: HonoContext) => {
			const rawUserCtx =
				c.req.header("x-user-context") || (new URL(c.req.url).searchParams.get("user_context") ?? undefined);
			const userContext = parseUserContext(rawUserCtx);

			const server = this.buildServer(group, () => userContext);
			const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
			try {
				await server.connect(transport);
				const res = await transport.handleRequest(c.req.raw);
				return res;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				this.logger.error(`[blok][mcp] streamable-http request failed: ${msg}`);
				return c.json({ jsonrpc: "2.0", error: { code: -32603, message: msg }, id: null }, 500);
			}
		});
	}
}

// -----------------------------------------------------------------------------
// Singleton accessor (parity with SSE/Webhook triggers)
// -----------------------------------------------------------------------------

let activeTrigger: McpTrigger | null = null;
export function _setActiveMcpTrigger(trigger: McpTrigger | null): void {
	activeTrigger = trigger;
}
export function _getActiveMcpTrigger(): McpTrigger | null {
	return activeTrigger;
}

export type { McpTriggerConfig };
