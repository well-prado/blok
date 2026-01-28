/**
 * PubSubTrigger - Base class for pub/sub-based workflow triggers
 *
 * Extends TriggerBase to support pub/sub triggers:
 * - GCP Pub/Sub
 * - AWS SNS (via SQS subscription)
 * - Azure Service Bus
 *
 * Pattern:
 * 1. loadNodes() - Load available nodes into NodeMap
 * 2. loadWorkflows() - Load workflows with pubsub triggers
 * 3. startSubscriber() - Connect to pub/sub and start receiving messages
 * 4. For each message:
 *    - Match workflow by trigger config (topic/subscription)
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
import type { HelperResponse, PubSubTriggerOpts, PubSubProvider } from "@nanoservice-ts/helper";
import { trace, metrics, type Span, SpanStatusCode } from "@opentelemetry/api";
import { v4 as uuid } from "uuid";

/**
 * Message received from pub/sub
 */
export interface PubSubMessage {
	/** Unique message ID */
	id: string;
	/** Message body (parsed) */
	body: unknown;
	/** Message attributes/metadata */
	attributes: Record<string, string>;
	/** Original raw message from provider */
	raw: unknown;
	/** Topic name */
	topic: string;
	/** Subscription name */
	subscription?: string;
	/** Publish timestamp */
	publishTime?: Date;
	/** Acknowledge the message */
	ack: () => Promise<void>;
	/** Reject/nack the message */
	nack: () => Promise<void>;
}

/**
 * Pub/Sub adapter interface - implemented by each provider
 */
export interface PubSubAdapter {
	/** Provider name */
	readonly provider: PubSubProvider;

	/** Connect to the pub/sub system */
	connect(): Promise<void>;

	/** Disconnect from the pub/sub system */
	disconnect(): Promise<void>;

	/** Subscribe to a topic and receive messages */
	subscribe(
		config: PubSubTriggerOpts,
		handler: (message: PubSubMessage) => Promise<void>,
	): Promise<void>;

	/** Unsubscribe from a topic */
	unsubscribe(subscription: string): Promise<void>;

	/** Check if connected */
	isConnected(): boolean;

	/** Health check */
	healthCheck(): Promise<boolean>;
}

/**
 * Workflow model with pub/sub trigger configuration
 */
interface PubSubWorkflowModel {
	path: string;
	config: {
		name: string;
		version: string;
		trigger?: {
			pubsub?: PubSubTriggerOpts;
			[key: string]: unknown;
		};
		[key: string]: unknown;
	};
}

/**
 * PubSubTrigger - Abstract base class for pub/sub-based triggers
 */
export abstract class PubSubTrigger extends TriggerBase {
	protected nodeMap: GlobalOptions = {} as GlobalOptions;
	protected readonly tracer = trace.getTracer(
		process.env.PROJECT_NAME || "trigger-pubsub-workflow",
		process.env.PROJECT_VERSION || "0.0.1",
	);
	protected readonly logger = new DefaultLogger();
	protected abstract adapter: PubSubAdapter;

	// Subclasses provide these
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
	 * Start the pub/sub subscriber - main entry point
	 */
	async listen(): Promise<number> {
		const startTime = this.startCounter();

		try {
			// Connect to pub/sub system
			await this.adapter.connect();
			this.logger.log(`Connected to ${this.adapter.provider} pub/sub system`);

			// Find all workflows with pub/sub triggers
			const pubsubWorkflows = this.getPubSubWorkflows();

			if (pubsubWorkflows.length === 0) {
				this.logger.log("No workflows with pub/sub triggers found");
				return this.endCounter(startTime);
			}

			// Subscribe to each topic/subscription
			for (const workflow of pubsubWorkflows) {
				const config = workflow.config.trigger?.pubsub as PubSubTriggerOpts;
				this.logger.log(
					`Subscribing to topic: ${config.topic}, subscription: ${config.subscription} for workflow: ${workflow.path}`,
				);

				await this.adapter.subscribe(config, async (message) => {
					await this.handleMessage(message, workflow, config);
				});
			}

			this.logger.log(
				`Pub/Sub trigger started. Listening to ${pubsubWorkflows.length} subscription(s)`,
			);

			// Enable HMR in development mode
			if (process.env.BLOK_HMR === "true" || process.env.NODE_ENV === "development") {
				await this.enableHotReload();
			}

			return this.endCounter(startTime);
		} catch (error) {
			this.logger.error(`Failed to start pub/sub trigger: ${(error as Error).message}`);
			throw error;
		}
	}

	/**
	 * Stop the pub/sub subscriber
	 */
	async stop(): Promise<void> {
		await this.adapter.disconnect();
		this.logger.log("Pub/Sub trigger stopped");
	}

	protected override async onHmrWorkflowChange(): Promise<void> {
		this.logger.log("[HMR] Pub/Sub workflow changed, reloading...");
		await this.waitForInFlightRequests();
		await this.stop();
		this.loadWorkflows();
		await this.listen();
	}

	/**
	 * Get all workflows that have pub/sub triggers
	 */
	protected getPubSubWorkflows(): PubSubWorkflowModel[] {
		const workflows: PubSubWorkflowModel[] = [];

		for (const [path, workflow] of Object.entries(this.nodeMap.workflows || {})) {
			// HelperResponse has a protected _config property
			const workflowConfig = (workflow as unknown as { _config: PubSubWorkflowModel["config"] })._config;

			if (workflowConfig?.trigger) {
				const triggerType = Object.keys(workflowConfig.trigger)[0];

				if (triggerType === "pubsub" && workflowConfig.trigger.pubsub) {
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
		message: PubSubMessage,
		workflow: PubSubWorkflowModel,
		config: PubSubTriggerOpts,
	): Promise<void> {
		const id = message.id || uuid();
		const defaultMeter = metrics.getMeter("default");
		const pubsubMessages = defaultMeter.createCounter("pubsub_messages", {
			description: "Pub/Sub messages processed",
		});
		const pubsubErrors = defaultMeter.createCounter("pubsub_errors", {
			description: "Pub/Sub message processing errors",
		});

		await this.tracer.startActiveSpan(`pubsub:${config.topic}`, async (span: Span) => {
			try {
				const start = performance.now();

				// Initialize configuration for this workflow
				await this.configuration.init(workflow.path, this.nodeMap);

				// Create context
				const ctx: Context = this.createContext(undefined, workflow.path, id);

				// Populate request with message data
				ctx.request = {
					body: message.body,
					headers: message.attributes,
					query: {},
					params: {
						topic: message.topic,
						subscription: message.subscription || "",
						messageId: message.id,
					},
				} as unknown as RequestContext;

				// Store message metadata in context
				if (!ctx.vars) ctx.vars = {};
				ctx.vars["_pubsub_message"] = {
					topic: message.topic,
					subscription: message.subscription || "",
					publishTime: message.publishTime?.toISOString() ?? "",
					attributes: JSON.stringify(message.attributes),
				};

				ctx.logger.log(`Processing message from ${config.topic}: ${id}`);

				// Execute workflow
				const response: TriggerResponse = await this.run(ctx);
				const end = performance.now();

				// Set span attributes
				span.setAttribute("success", true);
				span.setAttribute("message_id", id);
				span.setAttribute("topic", config.topic);
				span.setAttribute("subscription", config.subscription);
				span.setAttribute("provider", config.provider);
				span.setAttribute("elapsed_ms", end - start);
				span.setStatus({ code: SpanStatusCode.OK });

				// Record metrics
				pubsubMessages.add(1, {
					env: process.env.NODE_ENV,
					topic: config.topic,
					subscription: config.subscription,
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
				pubsubErrors.add(1, {
					env: process.env.NODE_ENV,
					topic: config.topic,
					subscription: config.subscription,
					provider: config.provider,
					workflow_name: this.configuration?.name || "unknown",
				});

				this.logger.error(
					`Failed to process message ${id}: ${errorMessage}`,
					(error as Error).stack,
				);

				// Nack message
				if (config.ack !== false) {
					await message.nack();
					this.logger.log(`Message nacked: ${id}`);
				}
			} finally {
				span.end();
			}
		});
	}
}

export default PubSubTrigger;
