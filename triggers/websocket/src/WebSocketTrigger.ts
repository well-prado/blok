/**
 * WebSocketTrigger - Real-time bidirectional communication trigger
 *
 * Extends TriggerBase to handle WebSocket connections for:
 * - Real-time messaging
 * - Live updates and notifications
 * - Collaborative features
 * - Streaming data
 *
 * Features:
 * - Connection management (connect, disconnect, reconnect)
 * - Room/channel support for broadcasting
 * - Message routing to workflows
 * - Heartbeat/ping-pong for connection health
 * - Authentication middleware
 * - Binary message support
 */

import type { HelperResponse, WebSocketTriggerOpts } from "@blokjs/helper";
import {
	type BlokService,
	DefaultLogger,
	type GlobalOptions,
	NodeMap,
	TriggerBase,
	type TriggerResponse,
} from "@blokjs/runner";
import type { Context, RequestContext } from "@blokjs/shared";
import { type Span, SpanStatusCode, metrics, trace } from "@opentelemetry/api";
import { v4 as uuid } from "uuid";

/**
 * WebSocket message types
 */
export type WebSocketMessageType = "text" | "binary" | "ping" | "pong";

/**
 * WebSocket connection state
 */
export type WebSocketState = "connecting" | "connected" | "disconnecting" | "disconnected";

/**
 * WebSocket message structure
 */
export interface WebSocketMessage {
	/** Unique message ID */
	id: string;
	/** Message type */
	type: WebSocketMessageType;
	/** Event name (for routing) */
	event: string;
	/** Message payload */
	data: unknown;
	/** Timestamp */
	timestamp: Date;
	/** Raw message data */
	raw?: Buffer | string;
}

/**
 * WebSocket client connection
 */
export interface WebSocketClient {
	/** Unique client ID */
	id: string;
	/** Connection state */
	state: WebSocketState;
	/** Rooms/channels the client is subscribed to */
	rooms: Set<string>;
	/** Client metadata */
	metadata: Record<string, unknown>;
	/** Connection timestamp */
	connectedAt: Date;
	/** Last activity timestamp */
	lastActivity: Date;
	/** Send message to client */
	send(data: string | Buffer): void;
	/** Close connection */
	close(code?: number, reason?: string): void;
	/** Ping the client */
	ping(): void;
}

/**
 * WebSocket room/channel for broadcasting
 */
export interface WebSocketRoom {
	/** Room name */
	name: string;
	/** Clients in the room */
	clients: Set<string>;
	/** Room metadata */
	metadata: Record<string, unknown>;
	/** Created timestamp */
	createdAt: Date;
}

/**
 * WebSocket event types for lifecycle hooks
 */
export type WebSocketEventType =
	| "connection"
	| "message"
	| "close"
	| "error"
	| "ping"
	| "pong"
	| "join_room"
	| "leave_room";

/**
 * WebSocket event for workflow triggering
 */
export interface WebSocketEvent {
	/** Event type */
	type: WebSocketEventType;
	/** Client ID */
	clientId: string;
	/** Message (for message events) */
	message?: WebSocketMessage;
	/** Room name (for room events) */
	room?: string;
	/** Error (for error events) */
	error?: Error;
	/** Close code (for close events) */
	closeCode?: number;
	/** Close reason (for close events) */
	closeReason?: string;
}

/**
 * Authentication result
 */
export interface AuthResult {
	authenticated: boolean;
	clientId?: string;
	metadata?: Record<string, unknown>;
	error?: string;
}

/**
 * Authentication handler function type
 */
export type AuthHandler = (request: unknown, headers: Record<string, string>) => Promise<AuthResult> | AuthResult;

/**
 * Workflow model with WebSocket trigger configuration
 */
interface WebSocketWorkflowModel {
	path: string;
	config: {
		name: string;
		version: string;
		trigger?: {
			websocket?: WebSocketTriggerOpts;
			[key: string]: unknown;
		};
		[key: string]: unknown;
	};
}

/**
 * WebSocketTrigger - Handle WebSocket connections and messages
 */
export abstract class WebSocketTrigger extends TriggerBase {
	protected nodeMap: GlobalOptions = {} as GlobalOptions;
	protected readonly tracer = trace.getTracer(
		process.env.PROJECT_NAME || "trigger-websocket-workflow",
		process.env.PROJECT_VERSION || "0.0.1",
	);
	protected readonly logger = new DefaultLogger();
	protected websocketWorkflows: WebSocketWorkflowModel[] = [];

	// Connection management
	protected clients: Map<string, WebSocketClient> = new Map();
	protected rooms: Map<string, WebSocketRoom> = new Map();

	// Metrics
	protected activeConnections = 0;
	protected totalMessages = 0;

	// Configuration
	protected heartbeatInterval: NodeJS.Timeout | null = null;
	protected heartbeatIntervalMs = 30000; // 30 seconds
	protected maxClients = 10000;
	protected messageRateLimit = 100; // messages per second per client

	// Subclasses provide these
	protected abstract nodes: Record<string, BlokService<unknown>>;
	protected abstract workflows: Record<string, HelperResponse>;

	// Optional auth handler
	protected authHandler?: AuthHandler;

	constructor() {
		super();
		this.loadNodes();
		this.loadWorkflows();
	}

	/**
	 * Load nodes into the node map
	 */
	loadNodes(): void {
		this.nodeMap.nodes = new NodeMap();
		if (this.nodes) {
			const nodeKeys = Object.keys(this.nodes);
			for (const key of nodeKeys) {
				this.nodeMap.nodes.addNode(key, this.nodes[key]);
			}
		}
	}

	/**
	 * Load workflows into the workflow map
	 */
	loadWorkflows(): void {
		this.nodeMap.workflows = this.workflows || {};
	}

	/**
	 * Set authentication handler
	 */
	setAuthHandler(handler: AuthHandler): void {
		this.authHandler = handler;
	}

	/**
	 * Initialize WebSocket trigger
	 */
	async listen(): Promise<number> {
		const startTime = this.startCounter();

		// Find all workflows with WebSocket triggers
		this.websocketWorkflows = this.getWebSocketWorkflows();

		if (this.websocketWorkflows.length === 0) {
			this.logger.log("No workflows with WebSocket triggers found");
		} else {
			this.logger.log(`WebSocket trigger initialized. ${this.websocketWorkflows.length} workflow(s) registered`);
		}

		// Start heartbeat monitoring
		this.startHeartbeat();

		// Enable HMR in development mode
		if (process.env.BLOK_HMR === "true" || process.env.NODE_ENV === "development") {
			await this.enableHotReload();
		}

		return this.endCounter(startTime);
	}

	/**
	 * Stop the WebSocket trigger
	 */
	async stop(): Promise<void> {
		// Stop heartbeat
		this.stopHeartbeat();

		// Close all client connections
		for (const client of this.clients.values()) {
			client.close(1001, "Server shutting down");
		}

		// Clear state
		this.clients.clear();
		this.rooms.clear();
		this.websocketWorkflows = [];
		this.activeConnections = 0;

		this.logger.log("WebSocket trigger stopped");
	}

	protected override async onHmrWorkflowChange(): Promise<void> {
		// Lightweight: refresh workflow list without disconnecting clients
		this.loadWorkflows();
		this.websocketWorkflows = this.getWebSocketWorkflows();
		this.logger.log(`[HMR] WebSocket workflows reloaded. ${this.websocketWorkflows.length} workflow(s) registered`);
	}

	/**
	 * Handle new WebSocket connection
	 */
	async handleConnection(
		socket: {
			send: (data: string | Buffer) => void;
			close: (code?: number, reason?: string) => void;
			ping: () => void;
		},
		request: unknown,
		headers: Record<string, string> = {},
	): Promise<WebSocketClient | null> {
		// Check max connections
		if (this.clients.size >= this.maxClients) {
			this.logger.error("Max connections reached, rejecting new connection");
			socket.close(1013, "Server at capacity");
			return null;
		}

		// Authenticate if handler is set
		let clientId = uuid();
		let metadata: Record<string, unknown> = {};

		if (this.authHandler) {
			const authResult = await this.authHandler(request, headers);
			if (!authResult.authenticated) {
				this.logger.error(`Authentication failed: ${authResult.error}`);
				socket.close(4001, authResult.error || "Authentication failed");
				return null;
			}
			if (authResult.clientId) {
				clientId = authResult.clientId;
			}
			if (authResult.metadata) {
				metadata = authResult.metadata;
			}
		}

		// Create client object
		const client: WebSocketClient = {
			id: clientId,
			state: "connected",
			rooms: new Set(),
			metadata,
			connectedAt: new Date(),
			lastActivity: new Date(),
			send: (data: string | Buffer) => {
				if (client.state === "connected") {
					socket.send(data);
				}
			},
			close: (code?: number, reason?: string) => {
				client.state = "disconnecting";
				socket.close(code, reason);
			},
			ping: () => {
				socket.ping();
			},
		};

		// Register client
		this.clients.set(clientId, client);
		this.activeConnections++;

		// Trigger connection event
		await this.triggerEvent({
			type: "connection",
			clientId,
		});

		this.logger.log(`Client connected: ${clientId} (${this.activeConnections} active)`);

		return client;
	}

	/**
	 * Handle WebSocket message
	 */
	async handleMessage(clientId: string, data: string | Buffer, isBinary: boolean): Promise<TriggerResponse | null> {
		const client = this.clients.get(clientId);
		if (!client) {
			this.logger.error(`Message from unknown client: ${clientId}`);
			return null;
		}

		// Update activity timestamp
		client.lastActivity = new Date();
		this.totalMessages++;

		// Parse message
		let message: WebSocketMessage;
		try {
			if (isBinary) {
				message = {
					id: uuid(),
					type: "binary",
					event: "binary",
					data: data,
					timestamp: new Date(),
					raw: data as Buffer,
				};
			} else {
				const text = data.toString();
				let parsed: { event?: string; data?: unknown } = {};
				try {
					parsed = JSON.parse(text);
				} catch {
					parsed = { event: "message", data: text };
				}
				message = {
					id: uuid(),
					type: "text",
					event: parsed.event || "message",
					data: parsed.data ?? parsed,
					timestamp: new Date(),
					raw: text,
				};
			}
		} catch (error) {
			this.logger.error(`Failed to parse message: ${(error as Error).message}`);
			return null;
		}

		// Trigger message event
		return this.triggerEvent({
			type: "message",
			clientId,
			message,
		});
	}

	/**
	 * Handle WebSocket close
	 */
	async handleClose(clientId: string, code: number, reason: string): Promise<void> {
		const client = this.clients.get(clientId);
		if (!client) return;

		client.state = "disconnected";

		// Remove from all rooms
		for (const roomName of client.rooms) {
			const room = this.rooms.get(roomName);
			if (room) {
				room.clients.delete(clientId);
				// Clean up empty rooms
				if (room.clients.size === 0) {
					this.rooms.delete(roomName);
				}
			}
		}

		// Unregister client
		this.clients.delete(clientId);
		this.activeConnections--;

		// Trigger close event
		await this.triggerEvent({
			type: "close",
			clientId,
			closeCode: code,
			closeReason: reason,
		});

		this.logger.log(`Client disconnected: ${clientId} (code: ${code}, reason: ${reason})`);
	}

	/**
	 * Handle WebSocket error
	 */
	async handleError(clientId: string, error: Error): Promise<void> {
		this.logger.error(`WebSocket error for client ${clientId}: ${error.message}`);

		await this.triggerEvent({
			type: "error",
			clientId,
			error,
		});
	}

	/**
	 * Handle ping from client
	 */
	handlePing(clientId: string): void {
		const client = this.clients.get(clientId);
		if (client) {
			client.lastActivity = new Date();
		}
	}

	/**
	 * Handle pong from client
	 */
	handlePong(clientId: string): void {
		const client = this.clients.get(clientId);
		if (client) {
			client.lastActivity = new Date();
		}
	}

	/**
	 * Join a room/channel
	 */
	async joinRoom(clientId: string, roomName: string): Promise<boolean> {
		const client = this.clients.get(clientId);
		if (!client) return false;

		// Create room if it doesn't exist
		if (!this.rooms.has(roomName)) {
			this.rooms.set(roomName, {
				name: roomName,
				clients: new Set(),
				metadata: {},
				createdAt: new Date(),
			});
		}

		const room = this.rooms.get(roomName);
		if (!room) return;
		room.clients.add(clientId);
		client.rooms.add(roomName);

		// Trigger join event
		await this.triggerEvent({
			type: "join_room",
			clientId,
			room: roomName,
		});

		this.logger.log(`Client ${clientId} joined room: ${roomName}`);
		return true;
	}

	/**
	 * Leave a room/channel
	 */
	async leaveRoom(clientId: string, roomName: string): Promise<boolean> {
		const client = this.clients.get(clientId);
		if (!client) return false;

		const room = this.rooms.get(roomName);
		if (!room) return false;

		room.clients.delete(clientId);
		client.rooms.delete(roomName);

		// Clean up empty rooms
		if (room.clients.size === 0) {
			this.rooms.delete(roomName);
		}

		// Trigger leave event
		await this.triggerEvent({
			type: "leave_room",
			clientId,
			room: roomName,
		});

		this.logger.log(`Client ${clientId} left room: ${roomName}`);
		return true;
	}

	/**
	 * Send message to a specific client
	 */
	sendToClient(clientId: string, event: string, data: unknown): boolean {
		const client = this.clients.get(clientId);
		if (!client || client.state !== "connected") return false;

		const message = JSON.stringify({ event, data });
		client.send(message);
		return true;
	}

	/**
	 * Broadcast message to all clients in a room
	 */
	broadcastToRoom(roomName: string, event: string, data: unknown, excludeClient?: string): number {
		const room = this.rooms.get(roomName);
		if (!room) return 0;

		const message = JSON.stringify({ event, data });
		let sent = 0;

		for (const clientId of room.clients) {
			if (excludeClient && clientId === excludeClient) continue;

			const client = this.clients.get(clientId);
			if (client && client.state === "connected") {
				client.send(message);
				sent++;
			}
		}

		return sent;
	}

	/**
	 * Broadcast message to all connected clients
	 */
	broadcastToAll(event: string, data: unknown, excludeClient?: string): number {
		const message = JSON.stringify({ event, data });
		let sent = 0;

		for (const [clientId, client] of this.clients) {
			if (excludeClient && clientId === excludeClient) continue;

			if (client.state === "connected") {
				client.send(message);
				sent++;
			}
		}

		return sent;
	}

	/**
	 * Get client by ID
	 */
	getClient(clientId: string): WebSocketClient | undefined {
		return this.clients.get(clientId);
	}

	/**
	 * Get all clients in a room
	 */
	getClientsInRoom(roomName: string): WebSocketClient[] {
		const room = this.rooms.get(roomName);
		if (!room) return [];

		const clients: WebSocketClient[] = [];
		for (const clientId of room.clients) {
			const client = this.clients.get(clientId);
			if (client) {
				clients.push(client);
			}
		}
		return clients;
	}

	/**
	 * Get connection stats
	 */
	getStats(): {
		activeConnections: number;
		totalMessages: number;
		roomCount: number;
		clientsByRoom: Record<string, number>;
	} {
		const clientsByRoom: Record<string, number> = {};
		for (const [name, room] of this.rooms) {
			clientsByRoom[name] = room.clients.size;
		}

		return {
			activeConnections: this.activeConnections,
			totalMessages: this.totalMessages,
			roomCount: this.rooms.size,
			clientsByRoom,
		};
	}

	/**
	 * Get all workflows that have WebSocket triggers
	 */
	protected getWebSocketWorkflows(): WebSocketWorkflowModel[] {
		const workflows: WebSocketWorkflowModel[] = [];

		for (const [path, workflow] of Object.entries(this.nodeMap.workflows || {})) {
			const workflowConfig = (workflow as unknown as { _config: WebSocketWorkflowModel["config"] })._config;

			if (workflowConfig?.trigger) {
				const triggerType = Object.keys(workflowConfig.trigger)[0];

				if (triggerType === "websocket" && workflowConfig.trigger.websocket) {
					workflows.push({
						path,
						config: workflowConfig,
					});
				}
			}
		}

		return workflows;
	}

	/**
	 * Find workflow matching the WebSocket event
	 */
	protected findMatchingWorkflow(event: WebSocketEvent): WebSocketWorkflowModel | null {
		for (const workflow of this.websocketWorkflows) {
			const config = workflow.config.trigger?.websocket;
			if (!config) continue;

			// Check event type match
			if (config.events && config.events.length > 0) {
				const eventName = event.type === "message" ? event.message?.event || "message" : event.type;

				const matches = config.events.some((pattern) => {
					if (pattern === "*") return true;
					if (pattern.endsWith(".*")) {
						const prefix = pattern.slice(0, -2);
						return eventName.startsWith(prefix);
					}
					return pattern === eventName;
				});
				if (!matches) continue;
			}

			// Check room filter
			if (config.rooms && config.rooms.length > 0 && event.room) {
				if (!config.rooms.includes(event.room)) continue;
			}

			return workflow;
		}

		return null;
	}

	/**
	 * Trigger a workflow based on WebSocket event
	 */
	protected async triggerEvent(event: WebSocketEvent): Promise<TriggerResponse | null> {
		// Find matching workflow
		const workflow = this.findMatchingWorkflow(event);
		if (!workflow) {
			return null;
		}

		const config = workflow.config.trigger?.websocket as WebSocketTriggerOpts;
		return this.executeWorkflow(event, workflow, config);
	}

	/**
	 * Execute a workflow for a WebSocket event
	 */
	protected async executeWorkflow(
		event: WebSocketEvent,
		workflow: WebSocketWorkflowModel,
		_config: WebSocketTriggerOpts,
	): Promise<TriggerResponse> {
		const executionId = uuid();

		const defaultMeter = metrics.getMeter("default");
		const wsExecutions = defaultMeter.createCounter("websocket_executions", {
			description: "WebSocket workflow executions",
		});
		const wsErrors = defaultMeter.createCounter("websocket_errors", {
			description: "WebSocket execution errors",
		});

		return new Promise((resolve) => {
			this.tracer.startActiveSpan(`websocket:${event.type}`, async (span: Span) => {
				try {
					const start = performance.now();

					// Initialize configuration for this workflow
					await this.configuration.init(workflow.path, this.nodeMap);

					// Create context
					const ctx: Context = this.createContext(undefined, workflow.path, executionId);

					// Get client info
					const client = this.clients.get(event.clientId);

					// Populate request with WebSocket event
					ctx.request = {
						body: event.message?.data ?? event,
						headers: {},
						query: {},
						params: {
							clientId: event.clientId,
							eventType: event.type,
							messageEvent: event.message?.event,
							room: event.room,
						},
					} as unknown as RequestContext;

					// Store WebSocket context in vars (use type assertion for flexibility)
					if (!ctx.vars) ctx.vars = {};
					(ctx.vars as Record<string, unknown>)._websocket = {
						clientId: event.clientId,
						eventType: event.type,
						messageId: event.message?.id,
						messageEvent: event.message?.event,
						room: event.room,
						clientRooms: client ? Array.from(client.rooms) : [],
						clientMetadata: client?.metadata || {},
						timestamp: new Date().toISOString(),
					};

					// Add helper functions to context for sending responses
					(ctx.vars as Record<string, unknown>)._websocket_send = (data: unknown) => {
						this.sendToClient(event.clientId, "response", data);
					};
					(ctx.vars as Record<string, unknown>)._websocket_broadcast = (room: string, data: unknown) => {
						this.broadcastToRoom(room, "broadcast", data, event.clientId);
					};

					ctx.logger.log(`Processing WebSocket event: ${event.type} from ${event.clientId}`);

					// Execute workflow
					const response: TriggerResponse = await this.run(ctx);
					const end = performance.now();

					// Set span attributes
					span.setAttribute("success", true);
					span.setAttribute("client_id", event.clientId);
					span.setAttribute("event_type", event.type);
					span.setAttribute("workflow_path", workflow.path);
					span.setAttribute("elapsed_ms", end - start);
					span.setStatus({ code: SpanStatusCode.OK });

					// Record metrics
					wsExecutions.add(1, {
						env: process.env.NODE_ENV,
						event_type: event.type,
						workflow_name: this.configuration.name,
						success: "true",
					});

					ctx.logger.log(`WebSocket event processed in ${(end - start).toFixed(2)}ms`);

					resolve(response);
				} catch (error) {
					const errorMessage = (error as Error).message;

					// Set span error
					span.setAttribute("success", false);
					span.recordException(error as Error);
					span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage });

					// Record error metrics
					wsErrors.add(1, {
						env: process.env.NODE_ENV,
						event_type: event.type,
						workflow_name: this.configuration?.name || "unknown",
					});

					this.logger.error(`WebSocket workflow failed: ${errorMessage}`, (error as Error).stack);

					throw error;
				} finally {
					span.end();
				}
			});
		});
	}

	/**
	 * Start heartbeat monitoring
	 */
	protected startHeartbeat(): void {
		this.heartbeatInterval = setInterval(() => {
			const now = Date.now();
			const staleThreshold = this.heartbeatIntervalMs * 2;

			for (const [clientId, client] of this.clients) {
				const lastActivity = client.lastActivity.getTime();

				// Check for stale connections
				if (now - lastActivity > staleThreshold) {
					this.logger.log(`Closing stale connection: ${clientId}`);
					client.close(1000, "Connection timed out");
				} else {
					// Ping active connections
					try {
						client.ping();
					} catch (error) {
						this.logger.error(`Ping failed for ${clientId}: ${(error as Error).message}`);
					}
				}
			}
		}, this.heartbeatIntervalMs);
	}

	/**
	 * Stop heartbeat monitoring
	 */
	protected stopHeartbeat(): void {
		if (this.heartbeatInterval) {
			clearInterval(this.heartbeatInterval);
			this.heartbeatInterval = null;
		}
	}
}

export default WebSocketTrigger;
