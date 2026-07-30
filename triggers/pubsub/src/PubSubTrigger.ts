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

import type { PubSubProvider, PubSubTriggerOpts, WorkflowV2Builder } from "@blokjs/helper";
import {
	type BlokService,
	DefaultLogger,
	type GlobalOptions,
	NodeMap,
	TriggerBase,
	type TriggerResponse,
} from "@blokjs/runner";
import { type Context, type NodeBase, type RequestContext, isNonRetryableValidationError } from "@blokjs/shared";
import { type Span, SpanStatusCode, metrics, trace } from "@opentelemetry/api";
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
	subscribe(config: PubSubTriggerOpts, handler: (message: PubSubMessage) => Promise<void>): Promise<void>;

	/** Unsubscribe from a topic */
	unsubscribe(subscription: string): Promise<void>;

	/**
	 * v0.7 PR 6 — publish a single message to a topic. Used by the
	 * `@blokjs/pubsub-publish` helper and any workflow that fan-outs
	 * events to subscribers. Provider-portable: each adapter wraps its
	 * native producer client.
	 *
	 * Optional `partitionKey` / `orderingKey` is honored by providers
	 * that support per-key ordering (Kafka, GCP Pub/Sub ordered
	 * delivery). Ignored otherwise.
	 */
	publish(topic: string, payload: unknown, opts?: { partitionKey?: string; orderingKey?: string }): Promise<void>;

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
	/**
	 * ADR 0015 — a pub/sub message body IS producer-supplied input the workflow's
	 * `input` schema describes, so it is validated. A malformed message fails a
	 * deterministic 400 that `handleMessage` dead-letters/drops (never nacks into
	 * a poison loop) via `isNonRetryableValidationError`. Use `.passthrough()` to
	 * keep message fields outside the schema.
	 */
	protected validatesDeclaredInput(): boolean {
		return true;
	}

	protected nodeMap: GlobalOptions = {} as GlobalOptions;
	protected readonly tracer = trace.getTracer(
		process.env.PROJECT_NAME || "trigger-pubsub-workflow",
		process.env.PROJECT_VERSION || "0.0.1",
	);
	protected readonly logger = new DefaultLogger();

	/**
	 * v0.7 PR 6 — back-compat default adapter. When subclasses set
	 * `protected adapter = new GCPPubSubAdapter()` (pre-v0.7 pattern),
	 * ALL workflows route through it regardless of their `provider`
	 * field. When unset, each workflow's `provider` is resolved via
	 * the factory.
	 */
	protected adapter?: PubSubAdapter;

	/**
	 * v0.7 PR 6 — adapter pool, keyed by provider. Populated lazily in
	 * `listen()` as workflows are matched to providers. Drained in
	 * `stop()`. One adapter (one broker connection) per provider.
	 */
	protected adapterPool: Map<string, PubSubAdapter> = new Map();

	// Subclasses provide these
	protected abstract nodes: Record<string, BlokService<unknown>>;
	protected abstract workflows: Record<string, WorkflowV2Builder>;

	/**
	 * Load nodes into the node map
	 */
	loadNodes(): void {
		this.nodeMap.nodes = new NodeMap();
		// Register each node under its own node.name (the canonical use: ref, ADR
		// 0002) — the Nodes.ts map keys are cosmetic; the collision guard catches dups.
		this.nodeMap.nodes.addNodes(Object.values(this.nodes) as unknown as NodeBase[]);
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

		// Initialize nodes and workflows (called here because subclass properties
		// aren't available in parent constructor)
		this.loadNodes();
		this.loadWorkflows();

		// F5 · install crash/orphan/janitor/shutdown handlers so a
		// pubsub-only process gets the same run-state integrity + storage
		// hygiene guarantees as HTTP/Worker. Each handler is idempotent.
		this.installOperationalHandlers(this.logger);

		// F6 · feed the WorkflowRegistry from the nodeMap so `subworkflow:`
		// steps + trigger/workflow/process-global middleware resolve in a
		// pubsub-only deployment.
		this.registerWorkflowsFromNodeMap(this.logger);

		// F14 · seed the process-global middleware chain from
		// `BLOK_GLOBAL_MIDDLEWARE` (idempotent — programmatic
		// setGlobalMiddleware takes precedence).
		this.seedGlobalMiddlewareFromEnv(this.logger);

		try {
			// Find all workflows with pub/sub triggers
			const pubsubWorkflows = this.getPubSubWorkflows();

			if (pubsubWorkflows.length === 0) {
				this.logger.log("No workflows with pub/sub triggers found");
				return this.endCounter(startTime);
			}

			// Subscribe to each topic via the adapter that owns its
			// provider. Per-workflow `provider` field with subclass-
			// adapter back-compat (handled in resolveAdapterForWorkflow).
			for (const workflow of pubsubWorkflows) {
				const config = workflow.config.trigger?.pubsub as PubSubTriggerOpts;
				const adapter = await this.resolveAdapterForWorkflow(config);
				this.logger.log(
					`Subscribing to topic: ${config.topic} via ${adapter.provider} (subscription: ${config.subscription ?? "<auto>"}, group: ${config.consumerGroup ?? "<fan-out>"})`,
				);

				await adapter.subscribe(config, async (message) => {
					await this.handleMessage(message, workflow, config);
				});
			}

			this.logger.log(`Pub/Sub trigger started. Listening to ${pubsubWorkflows.length} subscription(s)`);

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
	 * Stop the pub/sub subscriber — drains every adapter in the pool
	 * plus the subclass-set adapter (if any).
	 */
	async stop(): Promise<void> {
		for (const adapter of this.adapterPool.values()) {
			try {
				await adapter.disconnect();
			} catch (err) {
				this.logger.error(`[blok][pubsub] disconnect failed: ${(err as Error).message}`);
			}
		}
		this.adapterPool.clear();
		this.logger.log("Pub/Sub trigger stopped");
	}

	/**
	 * v0.7 PR 6 — pick the adapter for a workflow's `provider` field.
	 *
	 * Resolution order:
	 *   1. Subclass-set `this.adapter` (back-compat).
	 *   2. Per-workflow `provider` field via the factory.
	 *   3. `BLOK_PUBSUB_ADAPTER` env var.
	 *   4. `"nats"` fallback.
	 *
	 * Adapters are connected on first use and pooled per provider.
	 */
	protected async resolveAdapterForWorkflow(config: PubSubTriggerOpts): Promise<PubSubAdapter> {
		if (this.adapter) {
			if (!this.adapter.isConnected()) {
				await this.adapter.connect();
				this.logger.log(`Connected to ${this.adapter.provider} pub/sub system (subclass adapter)`);
			}
			this.adapterPool.set(this.adapter.provider, this.adapter);
			return this.adapter;
		}
		const { resolveProvider, createPubSubAdapter } = await import("./adapters/factory");
		const provider = resolveProvider(config.provider);
		let adapter = this.adapterPool.get(provider);
		if (!adapter) {
			adapter = createPubSubAdapter(provider);
			await adapter.connect();
			this.logger.log(`Connected to ${adapter.provider} pub/sub system`);
			this.adapterPool.set(provider, adapter);
		}
		return adapter;
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
			// WorkflowV2Builder exposes a _config property
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
				ctx.vars._pubsub_message = {
					topic: message.topic,
					subscription: message.subscription || "",
					publishTime: message.publishTime?.toISOString() ?? "",
					attributes: JSON.stringify(message.attributes),
				};

				ctx.logger.log(`Processing message from ${config.topic}: ${id}`);

				// F1 · apply the merged middleware chain (process-global →
				// workflow-level → trigger-level) before the main workflow
				// body, after ctx.request is populated so middleware sees the
				// real body/headers. A throwing middleware propagates to the
				// outer catch (nack). Pre-fix pubsub silently skipped ALL
				// middleware — including auth gates.
				await this.applyMiddlewareChain(ctx, this.nodeMap);

				// Execute workflow
				const response: TriggerResponse = await this.run(ctx);
				const end = performance.now();

				// Set span attributes
				span.setAttribute("success", true);
				span.setAttribute("message_id", id);
				span.setAttribute("topic", config.topic);
				span.setAttribute("subscription", config.subscription ?? "<auto>");
				span.setAttribute("provider", config.provider ?? "<default>");
				span.setAttribute("elapsed_ms", end - start);
				span.setStatus({ code: SpanStatusCode.OK });

				// Record metrics
				pubsubMessages.add(1, {
					env: process.env.NODE_ENV,
					topic: config.topic,
					subscription: config.subscription ?? "<auto>",
					provider: config.provider ?? "<default>",
					workflow_name: this.configuration.name,
					success: "true",
				});

				ctx.logger.log(`Message processed in ${(end - start).toFixed(2)}ms: ${id}`);

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
					subscription: config.subscription ?? "<auto>",
					provider: config.provider ?? "<default>",
					workflow_name: this.configuration?.name || "unknown",
				});

				// ADR 0015 — a deterministic input-validation failure (the gate's
				// tagged GlobalError, or a node's BlokError.validation) fails
				// identically on every redelivery. Nacking it forever is a
				// poison-message loop — NATS/Redis/Kafka have no built-in delivery
				// cap. ACK to stop redelivery; route to the configured
				// deadLetterTopic first when set, else drop with a warning.
				const nonRetryable = isNonRetryableValidationError(error);
				if (nonRetryable) {
					if (config.deadLetterTopic) {
						try {
							const dlqAdapter = await this.resolveAdapterForWorkflow(config);
							await dlqAdapter.publish(config.deadLetterTopic, message.body);
							this.logger.error(
								`Message ${id} failed input validation (400) → dead-lettered to ${config.deadLetterTopic}: ${errorMessage}`,
							);
						} catch (dlqErr) {
							this.logger.error(
								`Message ${id} DLQ publish to ${config.deadLetterTopic} failed; dropping to avoid a poison loop: ${(dlqErr as Error).message}`,
							);
						}
					} else {
						this.logger.error(
							`Message ${id} failed input validation (400) → dropped, no retry (set trigger.pubsub.deadLetterTopic to retain): ${errorMessage}`,
						);
					}
				} else {
					this.logger.error(`Failed to process message ${id}: ${errorMessage}`, (error as Error).stack);
				}

				if (config.ack !== false) {
					if (nonRetryable) {
						// ACK a non-retryable message → consume/commit so the broker
						// stops redelivering it (also unblocks Kafka's partition head).
						await message.ack();
						this.logger.log(`Message ack-dropped (non-retryable validation): ${id}`);
					} else {
						await message.nack();
						this.logger.log(`Message nacked: ${id}`);
					}
				}
			} finally {
				span.end();
			}
		});
	}
}

export default PubSubTrigger;
