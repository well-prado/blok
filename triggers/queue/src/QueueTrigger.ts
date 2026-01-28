/**
 * QueueTrigger - Base class for queue-based workflow triggers
 *
 * Extends TriggerBase to support message queue triggers:
 * - Kafka
 * - RabbitMQ
 * - AWS SQS
 * - Redis (BullMQ)
 * - Beanstalk
 *
 * Pattern:
 * 1. loadNodes() - Load available nodes into NodeMap
 * 2. loadWorkflows() - Load workflows with queue triggers
 * 3. startConsumer() - Connect to queue and start consuming messages
 * 4. For each message:
 *    - Match workflow by trigger config (topic/queue name)
 *    - Create context with this.createContext()
 *    - Populate ctx.request with message data
 *    - Execute workflow via this.run(ctx)
 *    - Ack/nack based on response
 */

import type { Context, RequestContext } from "@nanoservice-ts/shared";
import {
	TriggerBase,
	NodeMap,
	DefaultLogger,
	type GlobalOptions,
	type TriggerResponse,
	type NanoService,
} from "@nanoservice-ts/runner";
import type { HelperResponse, QueueTriggerOpts, QueueProvider } from "@nanoservice-ts/helper";
import { trace, metrics, type Span, SpanStatusCode } from "@opentelemetry/api";
import { v4 as uuid } from "uuid";

/**
 * Message received from queue
 */
export interface QueueMessage {
	/** Unique message ID */
	id: string;
	/** Message body (parsed) */
	body: unknown;
	/** Message headers/attributes */
	headers: Record<string, string>;
	/** Original raw message from provider */
	raw: unknown;
	/** Topic/queue name */
	topic: string;
	/** Partition (for Kafka) */
	partition?: number;
	/** Offset (for Kafka) */
	offset?: string;
	/** Timestamp */
	timestamp?: Date;
	/** Acknowledge the message */
	ack: () => Promise<void>;
	/** Reject/nack the message */
	nack: (requeue?: boolean) => Promise<void>;
}

/**
 * Queue adapter interface - implemented by each provider
 */
export interface QueueAdapter {
	/** Provider name */
	readonly provider: QueueProvider;

	/** Connect to the queue system */
	connect(): Promise<void>;

	/** Disconnect from the queue system */
	disconnect(): Promise<void>;

	/** Subscribe to a topic/queue and receive messages */
	subscribe(
		config: QueueTriggerOpts,
		handler: (message: QueueMessage) => Promise<void>,
	): Promise<void>;

	/** Unsubscribe from a topic/queue */
	unsubscribe(topic: string): Promise<void>;

	/** Check if connected */
	isConnected(): boolean;

	/** Health check */
	healthCheck(): Promise<boolean>;
}

/**
 * Workflow model with queue trigger configuration
 */
interface QueueWorkflowModel {
	path: string;
	config: {
		name: string;
		version: string;
		trigger?: {
			queue?: QueueTriggerOpts;
			[key: string]: unknown;
		};
		[key: string]: unknown;
	};
}

/**
 * QueueTrigger - Abstract base class for queue-based triggers
 */
export abstract class QueueTrigger extends TriggerBase {
	protected nodeMap: GlobalOptions = {} as GlobalOptions;
	protected readonly tracer = trace.getTracer(
		process.env.PROJECT_NAME || "trigger-queue-workflow",
		process.env.PROJECT_VERSION || "0.0.1",
	);
	protected readonly logger = new DefaultLogger();
	protected abstract adapter: QueueAdapter;

	// Subclasses provide these - use proper NanoService type
	protected abstract nodes: Record<string, NanoService<unknown>>;
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
		const nodeKeys = Object.keys(this.nodes);
		for (const key of nodeKeys) {
			this.nodeMap.nodes.addNode(key, this.nodes[key]);
		}
	}

	/**
	 * Load workflows into the workflow map
	 */
	loadWorkflows(): void {
		this.nodeMap.workflows = this.workflows;
	}

	/**
	 * Start the queue consumer - main entry point
	 */
	async listen(): Promise<number> {
		const startTime = this.startCounter();

		try {
			// Connect to queue system
			await this.adapter.connect();
			this.logger.log(`Connected to ${this.adapter.provider} queue system`);

			// Find all workflows with queue triggers
			const queueWorkflows = this.getQueueWorkflows();

			if (queueWorkflows.length === 0) {
				this.logger.log("No workflows with queue triggers found");
				return this.endCounter(startTime);
			}

			// Subscribe to each topic
			for (const workflow of queueWorkflows) {
				const config = workflow.config.trigger?.queue as QueueTriggerOpts;
				this.logger.log(
					`Subscribing to topic: ${config.topic} for workflow: ${workflow.path}`,
				);

				await this.adapter.subscribe(config, async (message) => {
					await this.handleMessage(message, workflow, config);
				});
			}

			this.logger.log(
				`Queue trigger started. Listening to ${queueWorkflows.length} topic(s)`,
			);

			// Enable HMR in development mode
			if (process.env.BLOK_HMR === "true" || process.env.NODE_ENV === "development") {
				await this.enableHotReload();
			}

			return this.endCounter(startTime);
		} catch (error) {
			this.logger.error(`Failed to start queue trigger: ${(error as Error).message}`);
			throw error;
		}
	}

	/**
	 * Stop the queue consumer
	 */
	async stop(): Promise<void> {
		await this.adapter.disconnect();
		this.logger.log("Queue trigger stopped");
	}

	protected override async onHmrWorkflowChange(): Promise<void> {
		this.logger.log("[HMR] Queue workflow changed, reloading...");
		await this.waitForInFlightRequests();
		await this.stop();
		this.loadWorkflows();
		await this.listen();
	}

	/**
	 * Get all workflows that have queue triggers
	 */
	protected getQueueWorkflows(): QueueWorkflowModel[] {
		const workflows: QueueWorkflowModel[] = [];

		for (const [path, workflow] of Object.entries(this.nodeMap.workflows || {})) {
			// HelperResponse has a protected _config property we need to access
			// We use type assertion to access the workflow configuration
			const workflowConfig = (workflow as unknown as { _config: QueueWorkflowModel["config"] })._config;

			if (workflowConfig?.trigger) {
				const triggerType = Object.keys(workflowConfig.trigger)[0];

				if (triggerType === "queue" && workflowConfig.trigger.queue) {
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
	 * Handle an incoming message
	 */
	protected async handleMessage(
		message: QueueMessage,
		workflow: QueueWorkflowModel,
		config: QueueTriggerOpts,
	): Promise<void> {
		const id = message.id || uuid();
		const defaultMeter = metrics.getMeter("default");
		const queueMessages = defaultMeter.createCounter("queue_messages", {
			description: "Queue messages processed",
		});
		const queueErrors = defaultMeter.createCounter("queue_errors", {
			description: "Queue message processing errors",
		});

		await this.tracer.startActiveSpan(`queue:${config.topic}`, async (span: Span) => {
			try {
				const start = performance.now();

				// Initialize configuration for this workflow
				await this.configuration.init(workflow.path, this.nodeMap);

				// Create context
				const ctx: Context = this.createContext(undefined, workflow.path, id);

				// Populate request with message data
				ctx.request = {
					body: message.body,
					headers: message.headers,
					query: {},
					params: {
						topic: message.topic,
						partition: String(message.partition ?? ""),
						offset: message.offset ?? "",
						messageId: message.id,
					},
				} as unknown as RequestContext;

				// Store raw message in context for advanced use cases
				if (!ctx.vars) ctx.vars = {};
				ctx.vars["_queue_message"] = {
					topic: message.topic,
					partition: String(message.partition ?? ""),
					offset: message.offset ?? "",
					timestamp: message.timestamp?.toISOString() ?? "",
					headers: JSON.stringify(message.headers),
				};

				ctx.logger.log(`Processing message from ${config.topic}: ${id}`);

				// Execute workflow
				const response: TriggerResponse = await this.run(ctx);
				const end = performance.now();

				// Set span attributes
				span.setAttribute("success", true);
				span.setAttribute("message_id", id);
				span.setAttribute("topic", config.topic);
				span.setAttribute("provider", config.provider);
				span.setAttribute("elapsed_ms", end - start);
				span.setStatus({ code: SpanStatusCode.OK });

				// Record metrics
				queueMessages.add(1, {
					env: process.env.NODE_ENV,
					topic: config.topic,
					provider: config.provider,
					workflow_name: this.configuration.name,
					success: "true",
				});

				ctx.logger.log(
					`Message processed in ${(end - start).toFixed(2)}ms: ${id}`,
				);

				// Acknowledge message if configured
				if (config.ack !== false) {
					await message.ack();
					ctx.logger.log(`Message acknowledged: ${id}`);
				}
			} catch (error) {
				const errorMessage = (error as Error).message;

				// Set span error
				span.setAttribute("success", false);
				span.recordException(error as Error);
				span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage });

				// Record error metrics
				queueErrors.add(1, {
					env: process.env.NODE_ENV,
					topic: config.topic,
					provider: config.provider,
					workflow_name: this.configuration?.name || "unknown",
				});

				this.logger.error(
					`Failed to process message ${id}: ${errorMessage}`,
					(error as Error).stack,
				);

				// Nack message (requeue for retry)
				if (config.ack !== false) {
					await message.nack(true);
					this.logger.log(`Message nacked (will retry): ${id}`);
				}
			} finally {
				span.end();
			}
		});
	}
}

export default QueueTrigger;
