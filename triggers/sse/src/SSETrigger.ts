/**
 * SSETrigger - Server-Sent Events trigger for real-time server push
 *
 * Extends TriggerBase to handle SSE connections for:
 * - Real-time notifications
 * - Live data updates
 * - Activity streams
 * - Dashboard updates
 *
 * Features:
 * - Channel/topic subscriptions
 * - Automatic reconnection support (via retry)
 * - Event type filtering
 * - Connection health monitoring
 * - Message history replay (via Last-Event-ID)
 */

import type { HelperResponse, SSETriggerOpts } from "@blok/helper";
import {
	DefaultLogger,
	type GlobalOptions,
	type BlokService,
	NodeMap,
	TriggerBase,
	type TriggerResponse,
} from "@blok/runner";
import type { Context, RequestContext } from "@blok/shared";
import { type Span, SpanStatusCode, metrics, trace } from "@opentelemetry/api";
import { v4 as uuid } from "uuid";

/**
 * SSE event structure
 */
export interface SSEEvent {
	/** Unique event ID */
	id: string;
	/** Event type/name */
	event: string;
	/** Event data (will be JSON stringified if object) */
	data: unknown;
	/** Retry interval hint for client (in ms) */
	retry?: number;
}

/**
 * SSE connection state
 */
export type SSEState = "connected" | "disconnecting" | "disconnected";

/**
 * SSE client connection
 */
export interface SSEClient {
	/** Unique client ID */
	id: string;
	/** Connection state */
	state: SSEState;
	/** Channels the client is subscribed to */
	channels: Set<string>;
	/** Client metadata */
	metadata: Record<string, unknown>;
	/** Connection timestamp */
	connectedAt: Date;
	/** Last activity timestamp */
	lastActivity: Date;
	/** Last event ID sent to this client */
	lastEventId: string | null;
	/** Write function to send SSE data */
	write: (data: string) => boolean;
	/** Close the connection */
	close: () => void;
}

/**
 * SSE channel for organizing events
 */
export interface SSEChannel {
	/** Channel name */
	name: string;
	/** Clients subscribed to this channel */
	clients: Set<string>;
	/** Channel metadata */
	metadata: Record<string, unknown>;
	/** Created timestamp */
	createdAt: Date;
	/** Last event timestamp */
	lastEventAt: Date | null;
}

/**
 * SSE connection event types
 */
export type SSEEventType = "connect" | "disconnect" | "subscribe" | "unsubscribe";

/**
 * SSE connection event (for workflow triggering)
 */
export interface SSEConnectionEvent {
	/** Event type */
	type: SSEEventType;
	/** Client ID */
	clientId: string;
	/** Channel name (for subscribe/unsubscribe) */
	channel?: string;
	/** Last Event ID (for reconnection) */
	lastEventId?: string;
}

/**
 * Workflow model with SSE trigger configuration
 */
interface SSEWorkflowModel {
	path: string;
	config: {
		name: string;
		version: string;
		trigger?: {
			sse?: SSETriggerOpts;
			[key: string]: unknown;
		};
		[key: string]: unknown;
	};
}

/**
 * SSETrigger - Handle Server-Sent Events connections
 */
export abstract class SSETrigger extends TriggerBase {
	protected nodeMap: GlobalOptions = {} as GlobalOptions;
	protected readonly tracer = trace.getTracer(
		process.env.PROJECT_NAME || "trigger-sse-workflow",
		process.env.PROJECT_VERSION || "0.0.1",
	);
	protected readonly logger = new DefaultLogger();
	protected sseWorkflows: SSEWorkflowModel[] = [];

	// Connection management
	protected clients: Map<string, SSEClient> = new Map();
	protected channels: Map<string, SSEChannel> = new Map();

	// Event history for replay on reconnection
	protected eventHistory: Map<string, { event: SSEEvent; channel: string; timestamp: Date }[]> = new Map();
	protected maxHistorySize = 100;
	protected historyRetentionMs = 60000; // 1 minute

	// Metrics
	protected activeConnections = 0;
	protected totalEventsSent = 0;

	// Configuration
	protected heartbeatInterval: NodeJS.Timeout | null = null;
	protected heartbeatIntervalMs = 30000; // 30 seconds
	protected maxClients = 10000;
	protected defaultRetryInterval = 3000; // 3 seconds

	// Subclasses provide these
	protected abstract nodes: Record<string, BlokService<unknown>>;
	protected abstract workflows: Record<string, HelperResponse>;

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
	 * Initialize SSE trigger
	 */
	async listen(): Promise<number> {
		const startTime = this.startCounter();

		// Find all workflows with SSE triggers
		this.sseWorkflows = this.getSSEWorkflows();

		if (this.sseWorkflows.length === 0) {
			this.logger.log("No workflows with SSE triggers found");
		} else {
			this.logger.log(`SSE trigger initialized. ${this.sseWorkflows.length} workflow(s) registered`);
		}

		// Start heartbeat monitoring
		this.startHeartbeat();

		// Start history cleanup
		this.startHistoryCleanup();

		// Enable HMR in development mode
		if (process.env.BLOK_HMR === "true" || process.env.NODE_ENV === "development") {
			await this.enableHotReload();
		}

		return this.endCounter(startTime);
	}

	/**
	 * Stop the SSE trigger
	 */
	async stop(): Promise<void> {
		// Stop heartbeat
		this.stopHeartbeat();

		// Close all client connections
		for (const client of this.clients.values()) {
			client.close();
		}

		// Clear state
		this.clients.clear();
		this.channels.clear();
		this.eventHistory.clear();
		this.sseWorkflows = [];
		this.activeConnections = 0;

		this.logger.log("SSE trigger stopped");
	}

	protected override async onHmrWorkflowChange(): Promise<void> {
		// Lightweight: refresh workflow list without disconnecting clients
		this.loadWorkflows();
		this.sseWorkflows = this.getSSEWorkflows();
		this.logger.log(`[HMR] SSE workflows reloaded. ${this.sseWorkflows.length} workflow(s) registered`);
	}

	/**
	 * Handle new SSE connection
	 * Call this from your HTTP endpoint handler
	 */
	async handleConnection(
		write: (data: string) => boolean,
		close: () => void,
		headers: Record<string, string> = {},
		metadata: Record<string, unknown> = {},
	): Promise<SSEClient | null> {
		// Check max connections
		if (this.clients.size >= this.maxClients) {
			this.logger.error("Max connections reached, rejecting new connection");
			close();
			return null;
		}

		const clientId = uuid();
		const lastEventId = headers["last-event-id"] || null;

		// Create client object
		const client: SSEClient = {
			id: clientId,
			state: "connected",
			channels: new Set(),
			metadata,
			connectedAt: new Date(),
			lastActivity: new Date(),
			lastEventId,
			write: (data: string) => {
				if (client.state === "connected") {
					return write(data);
				}
				return false;
			},
			close: () => {
				client.state = "disconnecting";
				close();
			},
		};

		// Register client
		this.clients.set(clientId, client);
		this.activeConnections++;

		// Send initial retry interval
		this.sendRetry(client, this.defaultRetryInterval);

		// Trigger connect event
		await this.triggerConnectionEvent({
			type: "connect",
			clientId,
			lastEventId: lastEventId || undefined,
		});

		this.logger.log(`SSE client connected: ${clientId} (${this.activeConnections} active)`);

		// If client is reconnecting with Last-Event-ID, replay missed events
		if (lastEventId) {
			this.replayEvents(client, lastEventId);
		}

		return client;
	}

	/**
	 * Handle SSE connection close
	 */
	async handleDisconnect(clientId: string): Promise<void> {
		const client = this.clients.get(clientId);
		if (!client) return;

		client.state = "disconnected";

		// Remove from all channels
		for (const channelName of client.channels) {
			const channel = this.channels.get(channelName);
			if (channel) {
				channel.clients.delete(clientId);
				// Clean up empty channels
				if (channel.clients.size === 0) {
					this.channels.delete(channelName);
				}
			}
		}

		// Unregister client
		this.clients.delete(clientId);
		this.activeConnections--;

		// Trigger disconnect event
		await this.triggerConnectionEvent({
			type: "disconnect",
			clientId,
		});

		this.logger.log(`SSE client disconnected: ${clientId}`);
	}

	/**
	 * Subscribe client to a channel
	 */
	async subscribe(clientId: string, channelName: string): Promise<boolean> {
		const client = this.clients.get(clientId);
		if (!client) return false;

		// Create channel if it doesn't exist
		if (!this.channels.has(channelName)) {
			this.channels.set(channelName, {
				name: channelName,
				clients: new Set(),
				metadata: {},
				createdAt: new Date(),
				lastEventAt: null,
			});
		}

		const channel = this.channels.get(channelName)!;
		channel.clients.add(clientId);
		client.channels.add(channelName);

		// Trigger subscribe event
		await this.triggerConnectionEvent({
			type: "subscribe",
			clientId,
			channel: channelName,
		});

		this.logger.log(`Client ${clientId} subscribed to channel: ${channelName}`);
		return true;
	}

	/**
	 * Unsubscribe client from a channel
	 */
	async unsubscribe(clientId: string, channelName: string): Promise<boolean> {
		const client = this.clients.get(clientId);
		if (!client) return false;

		const channel = this.channels.get(channelName);
		if (!channel) return false;

		channel.clients.delete(clientId);
		client.channels.delete(channelName);

		// Clean up empty channels
		if (channel.clients.size === 0) {
			this.channels.delete(channelName);
		}

		// Trigger unsubscribe event
		await this.triggerConnectionEvent({
			type: "unsubscribe",
			clientId,
			channel: channelName,
		});

		this.logger.log(`Client ${clientId} unsubscribed from channel: ${channelName}`);
		return true;
	}

	/**
	 * Send event to a specific client
	 */
	sendToClient(clientId: string, event: SSEEvent): boolean {
		const client = this.clients.get(clientId);
		if (!client || client.state !== "connected") return false;

		const formatted = this.formatEvent(event);
		const success = client.write(formatted);

		if (success) {
			client.lastActivity = new Date();
			client.lastEventId = event.id;
			this.totalEventsSent++;
		}

		return success;
	}

	/**
	 * Broadcast event to a channel
	 */
	broadcastToChannel(channelName: string, event: SSEEvent): number {
		const channel = this.channels.get(channelName);
		if (!channel) return 0;

		const formatted = this.formatEvent(event);
		let sent = 0;

		for (const clientId of channel.clients) {
			const client = this.clients.get(clientId);
			if (client && client.state === "connected") {
				const success = client.write(formatted);
				if (success) {
					client.lastActivity = new Date();
					client.lastEventId = event.id;
					sent++;
				}
			}
		}

		// Update channel stats
		channel.lastEventAt = new Date();

		// Store in history for replay
		this.storeEvent(channelName, event);

		this.totalEventsSent += sent;
		return sent;
	}

	/**
	 * Broadcast event to all connected clients
	 */
	broadcastToAll(event: SSEEvent): number {
		const formatted = this.formatEvent(event);
		let sent = 0;

		for (const client of this.clients.values()) {
			if (client.state === "connected") {
				const success = client.write(formatted);
				if (success) {
					client.lastActivity = new Date();
					client.lastEventId = event.id;
					sent++;
				}
			}
		}

		this.totalEventsSent += sent;
		return sent;
	}

	/**
	 * Send a comment (heartbeat) to keep connection alive
	 */
	sendHeartbeat(clientId: string): boolean {
		const client = this.clients.get(clientId);
		if (!client || client.state !== "connected") return false;

		// SSE comment format
		return client.write(": heartbeat\n\n");
	}

	/**
	 * Send retry interval to client
	 */
	sendRetry(client: SSEClient, retryMs: number): boolean {
		return client.write(`retry: ${retryMs}\n\n`);
	}

	/**
	 * Get client by ID
	 */
	getClient(clientId: string): SSEClient | undefined {
		return this.clients.get(clientId);
	}

	/**
	 * Get all clients in a channel
	 */
	getClientsInChannel(channelName: string): SSEClient[] {
		const channel = this.channels.get(channelName);
		if (!channel) return [];

		const clients: SSEClient[] = [];
		for (const clientId of channel.clients) {
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
		totalEventsSent: number;
		channelCount: number;
		clientsByChannel: Record<string, number>;
	} {
		const clientsByChannel: Record<string, number> = {};
		for (const [name, channel] of this.channels) {
			clientsByChannel[name] = channel.clients.size;
		}

		return {
			activeConnections: this.activeConnections,
			totalEventsSent: this.totalEventsSent,
			channelCount: this.channels.size,
			clientsByChannel,
		};
	}

	/**
	 * Format SSE event for transmission
	 */
	protected formatEvent(event: SSEEvent): string {
		const lines: string[] = [];

		if (event.id) {
			lines.push(`id: ${event.id}`);
		}

		if (event.event && event.event !== "message") {
			lines.push(`event: ${event.event}`);
		}

		if (event.retry !== undefined) {
			lines.push(`retry: ${event.retry}`);
		}

		// Format data - each line must be prefixed with "data: "
		const dataStr = typeof event.data === "string" ? event.data : JSON.stringify(event.data);
		const dataLines = dataStr.split("\n");
		for (const line of dataLines) {
			lines.push(`data: ${line}`);
		}

		// Events must end with double newline
		return lines.join("\n") + "\n\n";
	}

	/**
	 * Store event in history for replay
	 */
	protected storeEvent(channel: string, event: SSEEvent): void {
		if (!this.eventHistory.has(channel)) {
			this.eventHistory.set(channel, []);
		}

		const history = this.eventHistory.get(channel)!;
		history.push({ event, channel, timestamp: new Date() });

		// Trim history if too large
		while (history.length > this.maxHistorySize) {
			history.shift();
		}
	}

	/**
	 * Replay missed events to reconnecting client
	 */
	protected replayEvents(client: SSEClient, lastEventId: string): void {
		let foundLastEvent = false;
		const eventsToReplay: SSEEvent[] = [];

		// Collect events from all channels the client might be interested in
		for (const history of this.eventHistory.values()) {
			for (const entry of history) {
				if (!foundLastEvent) {
					if (entry.event.id === lastEventId) {
						foundLastEvent = true;
					}
					continue;
				}
				eventsToReplay.push(entry.event);
			}
		}

		// Send missed events
		for (const event of eventsToReplay) {
			this.sendToClient(client.id, event);
		}

		if (eventsToReplay.length > 0) {
			this.logger.log(`Replayed ${eventsToReplay.length} events to client ${client.id}`);
		}
	}

	/**
	 * Get all workflows that have SSE triggers
	 */
	protected getSSEWorkflows(): SSEWorkflowModel[] {
		const workflows: SSEWorkflowModel[] = [];

		for (const [path, workflow] of Object.entries(this.nodeMap.workflows || {})) {
			const workflowConfig = (workflow as unknown as { _config: SSEWorkflowModel["config"] })._config;

			if (workflowConfig?.trigger) {
				const triggerType = Object.keys(workflowConfig.trigger)[0];

				if (triggerType === "sse" && workflowConfig.trigger.sse) {
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
	 * Trigger a workflow based on SSE connection event
	 */
	protected async triggerConnectionEvent(event: SSEConnectionEvent): Promise<TriggerResponse | null> {
		// Find matching workflow
		const workflow = this.findMatchingWorkflow(event);
		if (!workflow) {
			return null;
		}

		const config = workflow.config.trigger?.sse as SSETriggerOpts;
		return this.executeWorkflow(event, workflow, config);
	}

	/**
	 * Find workflow matching the SSE event
	 */
	protected findMatchingWorkflow(event: SSEConnectionEvent): SSEWorkflowModel | null {
		for (const workflow of this.sseWorkflows) {
			const config = workflow.config.trigger?.sse;
			if (!config) continue;

			// Check event type match
			if (config.events && config.events.length > 0) {
				const matches = config.events.some((pattern) => {
					if (pattern === "*") return true;
					if (pattern.endsWith(".*")) {
						const prefix = pattern.slice(0, -2);
						return event.type.startsWith(prefix);
					}
					return pattern === event.type;
				});
				if (!matches) continue;
			}

			// Check channel filter
			if (config.channels && config.channels.length > 0 && event.channel) {
				if (!config.channels.includes(event.channel)) continue;
			}

			return workflow;
		}

		return null;
	}

	/**
	 * Execute a workflow for an SSE event
	 */
	protected async executeWorkflow(
		event: SSEConnectionEvent,
		workflow: SSEWorkflowModel,
		_config: SSETriggerOpts,
	): Promise<TriggerResponse> {
		const executionId = uuid();

		const defaultMeter = metrics.getMeter("default");
		const sseExecutions = defaultMeter.createCounter("sse_executions", {
			description: "SSE workflow executions",
		});
		const sseErrors = defaultMeter.createCounter("sse_errors", {
			description: "SSE execution errors",
		});

		return new Promise((resolve) => {
			this.tracer.startActiveSpan(`sse:${event.type}`, async (span: Span) => {
				try {
					const start = performance.now();

					// Initialize configuration for this workflow
					await this.configuration.init(workflow.path, this.nodeMap);

					// Create context
					const ctx: Context = this.createContext(undefined, workflow.path, executionId);

					// Get client info
					const client = this.clients.get(event.clientId);

					// Populate request with SSE event
					ctx.request = {
						body: event,
						headers: {},
						query: {},
						params: {
							clientId: event.clientId,
							eventType: event.type,
							channel: event.channel,
						},
					} as unknown as RequestContext;

					// Store SSE context in vars (use type assertion for flexibility)
					if (!ctx.vars) ctx.vars = {};
					(ctx.vars as Record<string, unknown>)._sse = {
						clientId: event.clientId,
						eventType: event.type,
						channel: event.channel,
						lastEventId: event.lastEventId,
						clientChannels: client ? Array.from(client.channels) : [],
						clientMetadata: client?.metadata || {},
						timestamp: new Date().toISOString(),
					};

					// Add helper functions to context for sending events
					(ctx.vars as Record<string, unknown>)._sse_send = (eventName: string, data: unknown) => {
						this.sendToClient(event.clientId, {
							id: uuid(),
							event: eventName,
							data,
						});
					};
					(ctx.vars as Record<string, unknown>)._sse_broadcast = (
						channel: string,
						eventName: string,
						data: unknown,
					) => {
						this.broadcastToChannel(channel, {
							id: uuid(),
							event: eventName,
							data,
						});
					};

					ctx.logger.log(`Processing SSE event: ${event.type} for ${event.clientId}`);

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
					sseExecutions.add(1, {
						env: process.env.NODE_ENV,
						event_type: event.type,
						workflow_name: this.configuration.name,
						success: "true",
					});

					ctx.logger.log(`SSE event processed in ${(end - start).toFixed(2)}ms`);

					resolve(response);
				} catch (error) {
					const errorMessage = (error as Error).message;

					// Set span error
					span.setAttribute("success", false);
					span.recordException(error as Error);
					span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage });

					// Record error metrics
					sseErrors.add(1, {
						env: process.env.NODE_ENV,
						event_type: event.type,
						workflow_name: this.configuration?.name || "unknown",
					});

					this.logger.error(`SSE workflow failed: ${errorMessage}`, (error as Error).stack);

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
			for (const [clientId, client] of this.clients) {
				if (client.state === "connected") {
					const success = this.sendHeartbeat(clientId);
					if (!success) {
						this.logger.log(`Heartbeat failed for client ${clientId}, closing connection`);
						this.handleDisconnect(clientId);
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

	/**
	 * Start history cleanup
	 */
	protected startHistoryCleanup(): void {
		setInterval(() => {
			const now = Date.now();
			for (const [channel, history] of this.eventHistory) {
				const filtered = history.filter((entry) => now - entry.timestamp.getTime() < this.historyRetentionMs);
				if (filtered.length === 0) {
					this.eventHistory.delete(channel);
				} else {
					this.eventHistory.set(channel, filtered);
				}
			}
		}, this.historyRetentionMs);
	}
}

export default SSETrigger;
