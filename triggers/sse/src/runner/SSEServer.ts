import type { Server } from "node:http";
import type { HMREvent } from "@blokjs/runner";
import { registerTraceRoutes } from "@blokjs/runner";
import type { HttpBindings } from "@hono/node-server";
import { serve } from "@hono/node-server";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { v4 as uuid } from "uuid";
import apps from "../AppRoutes";
import nodes from "../Nodes";
import { SSETrigger } from "../SSETrigger";
import workflows from "../Workflows";
import { createTraceRouterAdapter } from "./HonoTraceRouterAdapter";
import { metricsHandler } from "./metrics/opentelemetry_metrics";

type AppBindings = { Bindings: HttpBindings };

export default class SSEServer extends SSETrigger {
	private app: Hono<AppBindings> = new Hono<AppBindings>();
	private port: string | number = process.env.PORT || 4001;
	private server: Server | null = null;

	protected nodes = nodes;
	protected workflows = workflows;

	/**
	 * Gracefully stop the SSE server.
	 */
	override async stop(): Promise<void> {
		await super.stop();
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
			const startTime = this.startCounter();

			// CORS
			this.app.use(cors());

			// Health check
			this.app.all("/health-check", (c) => {
				return c.text("Online and ready for action", 200);
			});

			// Prometheus metrics
			this.app.get("/metrics", (c) => {
				try {
					metricsHandler(c.env.incoming, c.env.outgoing);
					return RESPONSE_ALREADY_SENT;
				} catch (_error) {
					return c.text("Error serving metrics", 500);
				}
			});

			// Blok Studio trace routes
			if (process.env.BLOK_TRACE_ENABLED !== "false") {
				const { traceAdapter, traceApp } = createTraceRouterAdapter();
				registerTraceRoutes(traceAdapter);
				this.app.route("/__blok", traceApp);
			}

			// Custom routes (AppRoutes.ts)
			this.app.route("/", apps);

			// --- SSE Stream Endpoint ---
			this.app.get("/events/:channel", async (c) => {
				const channel = c.req.param("channel");
				const incoming = c.env.incoming;
				const outgoing = c.env.outgoing;

				// Set SSE headers
				outgoing.writeHead(200, {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					Connection: "keep-alive",
					"X-Accel-Buffering": "no",
				});
				outgoing.flushHeaders();

				// Create write/close functions for SSETrigger
				const write = (data: string): boolean => {
					try {
						return outgoing.write(data);
					} catch {
						return false;
					}
				};
				const close = (): void => {
					try {
						outgoing.end();
					} catch {
						// Already closed
					}
				};

				// Extract headers
				const headers: Record<string, string> = {};
				for (const [key, value] of Object.entries(incoming.headers)) {
					if (typeof value === "string") {
						headers[key] = value;
					}
				}

				// Handle connection via SSETrigger base class
				const client = await this.handleConnection(write, close, headers, {
					channel,
					remoteAddress: incoming.socket?.remoteAddress,
				});

				if (!client) {
					outgoing.end();
					return RESPONSE_ALREADY_SENT;
				}

				// Subscribe to the requested channel
				await this.subscribe(client.id, channel);

				// Send initial connected event
				this.sendToClient(client.id, {
					id: uuid(),
					event: "connected",
					data: {
						clientId: client.id,
						channel,
						timestamp: new Date().toISOString(),
					},
				});

				// Handle disconnect
				incoming.on("close", () => {
					this.handleDisconnect(client.id);
				});

				// Keep the connection open — response is managed by SSE
				return RESPONSE_ALREADY_SENT;
			});

			// --- REST: Publish Event to Channel ---
			this.app.post("/events/:channel/publish", async (c) => {
				const channel = c.req.param("channel");
				let body: Record<string, unknown> = {};
				try {
					body = (await c.req.json()) as Record<string, unknown>;
				} catch {
					return c.json({ error: "Invalid JSON body" }, 400);
				}

				const eventName = (body.event as string) || "message";
				const data = body.data ?? body;

				const sent = this.broadcastToChannel(channel, {
					id: uuid(),
					event: eventName,
					data,
				});

				return c.json({ sent, channel, event: eventName });
			});

			// --- REST: Broadcast to All ---
			this.app.post("/events/broadcast", async (c) => {
				let body: Record<string, unknown> = {};
				try {
					body = (await c.req.json()) as Record<string, unknown>;
				} catch {
					return c.json({ error: "Invalid JSON body" }, 400);
				}

				const eventName = (body.event as string) || "message";
				const data = body.data ?? body;

				const sent = this.broadcastToAll({
					id: uuid(),
					event: eventName,
					data,
				});

				return c.json({ sent, event: eventName });
			});

			// --- REST: Connection Stats ---
			this.app.get("/clients", (c) => {
				return c.json(this.getStats());
			});

			// --- REST: List Channels ---
			this.app.get("/channels", (c) => {
				const channelList: { name: string; clients: number; lastEventAt: string | null }[] = [];
				for (const [name, channel] of this.channels) {
					channelList.push({
						name,
						clients: channel.clients.size,
						lastEventAt: channel.lastEventAt?.toISOString() || null,
					});
				}
				return c.json({ channels: channelList });
			});

			// Initialize SSE trigger (heartbeat, history cleanup, HMR, workflow discovery)
			super.listen().then(() => {
				// Start HTTP server
				this.server = serve({ fetch: this.app.fetch, port: Number(this.port) }, () => {
					this.logger.log(`SSE Server is running at http://localhost:${this.port}`);
					this.logger.log(`SSE stream endpoint: http://localhost:${this.port}/events/:channel`);
					this.logger.log(`Publish endpoint: POST http://localhost:${this.port}/events/:channel/publish`);

					// Enable HMR in development mode
					if (process.env.BLOK_HMR === "true" || process.env.NODE_ENV === "development") {
						this.enableHotReload();
					}

					done(this.endCounter(startTime));
				}) as Server;
			});
		});
	}
}
