/**
 * WebhookTrigger - Handle webhook events from external services
 *
 * Extends TriggerBase to process webhook events from:
 * - GitHub (push, pull_request, issues, etc.)
 * - Stripe (payment_intent, checkout.session, etc.)
 * - Shopify (orders, products, customers)
 * - Custom webhooks
 *
 * Features:
 * - Signature verification for security
 * - Event type filtering
 * - Retry support
 * - Dead letter handling
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
import type { HelperResponse, WebhookTriggerOpts } from "@nanoservice-ts/helper";
import { trace, metrics, type Span, SpanStatusCode } from "@opentelemetry/api";
import crypto from "crypto";
import { v4 as uuid } from "uuid";

/**
 * Webhook event structure
 */
export interface WebhookEvent {
	/** Unique event ID */
	id: string;
	/** Source service (github, stripe, shopify, custom) */
	source: string;
	/** Event type (e.g., push, payment_intent.succeeded) */
	eventType: string;
	/** Event payload */
	payload: unknown;
	/** Request headers */
	headers: Record<string, string>;
	/** Signature (if provided) */
	signature?: string;
	/** Timestamp */
	timestamp: Date;
	/** Raw request body */
	rawBody: string;
}

/**
 * Signature verification result
 */
export interface VerificationResult {
	valid: boolean;
	error?: string;
}

/**
 * Webhook source handlers
 */
export interface WebhookSourceHandler {
	/** Extract event type from request */
	getEventType(headers: Record<string, string>, body: unknown): string;
	/** Get signature from request */
	getSignature(headers: Record<string, string>): string | undefined;
	/** Verify signature */
	verifySignature(rawBody: string, signature: string, secret: string): VerificationResult;
	/** Get event ID */
	getEventId(headers: Record<string, string>, body: unknown): string;
}

/**
 * Workflow model with webhook trigger configuration
 */
interface WebhookWorkflowModel {
	path: string;
	config: {
		name: string;
		version: string;
		trigger?: {
			webhook?: WebhookTriggerOpts;
			[key: string]: unknown;
		};
		[key: string]: unknown;
	};
}

/**
 * Built-in source handlers
 */
const sourceHandlers: Record<string, WebhookSourceHandler> = {
	github: {
		getEventType: (headers) => headers["x-github-event"] || "unknown",
		getSignature: (headers) => headers["x-hub-signature-256"] || headers["x-hub-signature"],
		verifySignature: (rawBody, signature, secret) => {
			const hmac = crypto.createHmac("sha256", secret);
			const digest = "sha256=" + hmac.update(rawBody).digest("hex");
			const sigBuffer = Buffer.from(signature);
			const digestBuffer = Buffer.from(digest);
			// Length check first to avoid timing attack on length
			if (sigBuffer.length !== digestBuffer.length) {
				return { valid: false, error: "Invalid GitHub signature" };
			}
			const valid = crypto.timingSafeEqual(sigBuffer, digestBuffer);
			return { valid, error: valid ? undefined : "Invalid GitHub signature" };
		},
		getEventId: (headers) => headers["x-github-delivery"] || uuid(),
	},

	stripe: {
		getEventType: (_, body) => (body as { type?: string })?.type || "unknown",
		getSignature: (headers) => headers["stripe-signature"],
		verifySignature: (rawBody, signature, secret) => {
			// Stripe signature format: t=timestamp,v1=signature
			const parts = signature.split(",").reduce(
				(acc, part) => {
					const [key, value] = part.split("=");
					acc[key] = value;
					return acc;
				},
				{} as Record<string, string>,
			);

			const timestamp = parts["t"];
			const expectedSig = parts["v1"];

			if (!timestamp || !expectedSig) {
				return { valid: false, error: "Invalid Stripe signature format" };
			}

			const payload = `${timestamp}.${rawBody}`;
			const hmac = crypto.createHmac("sha256", secret);
			const computedSig = hmac.update(payload).digest("hex");

			const sigBuffer = Buffer.from(expectedSig);
			const computedBuffer = Buffer.from(computedSig);
			if (sigBuffer.length !== computedBuffer.length) {
				return { valid: false, error: "Invalid Stripe signature" };
			}
			const valid = crypto.timingSafeEqual(sigBuffer, computedBuffer);
			return { valid, error: valid ? undefined : "Invalid Stripe signature" };
		},
		getEventId: (_, body) => (body as { id?: string })?.id || uuid(),
	},

	shopify: {
		getEventType: (headers) => headers["x-shopify-topic"] || "unknown",
		getSignature: (headers) => headers["x-shopify-hmac-sha256"],
		verifySignature: (rawBody, signature, secret) => {
			const hmac = crypto.createHmac("sha256", secret);
			const digest = hmac.update(rawBody, "utf8").digest("base64");
			const sigBuffer = Buffer.from(signature, "base64");
			const digestBuffer = Buffer.from(digest, "base64");
			if (sigBuffer.length !== digestBuffer.length) {
				return { valid: false, error: "Invalid Shopify signature" };
			}
			const valid = crypto.timingSafeEqual(sigBuffer, digestBuffer);
			return { valid, error: valid ? undefined : "Invalid Shopify signature" };
		},
		getEventId: (headers) => headers["x-shopify-webhook-id"] || uuid(),
	},

	custom: {
		getEventType: (headers, body) =>
			headers["x-event-type"] || (body as { event?: string })?.event || "custom",
		getSignature: (headers) => headers["x-signature"] || headers["x-webhook-signature"],
		verifySignature: (rawBody, signature, secret) => {
			// Default: HMAC-SHA256
			const hmac = crypto.createHmac("sha256", secret);
			const digest = hmac.update(rawBody).digest("hex");
			const valid = signature === digest || signature === `sha256=${digest}`;
			return { valid, error: valid ? undefined : "Invalid signature" };
		},
		getEventId: (headers, body) =>
			headers["x-event-id"] || (body as { id?: string })?.id || uuid(),
	},
};

/**
 * WebhookTrigger - Handle webhook events
 */
export abstract class WebhookTrigger extends TriggerBase {
	protected nodeMap: GlobalOptions = {} as GlobalOptions;
	protected readonly tracer = trace.getTracer(
		process.env.PROJECT_NAME || "trigger-webhook-workflow",
		process.env.PROJECT_VERSION || "0.0.1",
	);
	protected readonly logger = new DefaultLogger();
	protected webhookWorkflows: WebhookWorkflowModel[] = [];

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
	 * Initialize webhook trigger (call after loading workflows)
	 */
	async listen(): Promise<number> {
		const startTime = this.startCounter();

		// Find all workflows with webhook triggers
		this.webhookWorkflows = this.getWebhookWorkflows();

		if (this.webhookWorkflows.length === 0) {
			this.logger.log("No workflows with webhook triggers found");
		} else {
			this.logger.log(
				`Webhook trigger initialized. ${this.webhookWorkflows.length} workflow(s) registered`,
			);
		}

		return this.endCounter(startTime);
	}

	/**
	 * Stop the webhook trigger
	 */
	async stop(): Promise<void> {
		this.webhookWorkflows = [];
		this.logger.log("Webhook trigger stopped");
	}

	/**
	 * Process an incoming webhook request
	 * Call this from your HTTP endpoint handler
	 */
	async handleWebhook(
		source: string,
		rawBody: string,
		headers: Record<string, string>,
	): Promise<TriggerResponse | null> {
		const handler = sourceHandlers[source] || sourceHandlers.custom;

		// Parse body
		let body: unknown;
		try {
			body = JSON.parse(rawBody);
		} catch {
			body = rawBody;
		}

		// Create webhook event
		const event: WebhookEvent = {
			id: handler.getEventId(headers, body),
			source,
			eventType: handler.getEventType(headers, body),
			payload: body,
			headers,
			signature: handler.getSignature(headers),
			timestamp: new Date(),
			rawBody,
		};

		// Find matching workflow
		const workflow = this.findMatchingWorkflow(event);
		if (!workflow) {
			this.logger.log(
				`No matching workflow for webhook: ${source}/${event.eventType}`,
			);
			return null;
		}

		const config = workflow.config.trigger?.webhook as WebhookTriggerOpts;

		// Verify signature if secret is configured
		if (config.secret && event.signature) {
			const verification = handler.verifySignature(rawBody, event.signature, config.secret);
			if (!verification.valid) {
				this.logger.error(`Webhook signature verification failed: ${verification.error}`);
				throw new Error(`Signature verification failed: ${verification.error}`);
			}
		} else if (config.secret && !event.signature) {
			this.logger.error("Webhook signature missing but secret is configured");
			throw new Error("Signature missing");
		}

		return this.executeWorkflow(event, workflow, config);
	}

	/**
	 * Get all workflows that have webhook triggers
	 */
	protected getWebhookWorkflows(): WebhookWorkflowModel[] {
		const workflows: WebhookWorkflowModel[] = [];

		for (const [path, workflow] of Object.entries(this.nodeMap.workflows || {})) {
			const workflowConfig = (workflow as unknown as { _config: WebhookWorkflowModel["config"] })._config;

			if (workflowConfig?.trigger) {
				const triggerType = Object.keys(workflowConfig.trigger)[0];

				if (triggerType === "webhook" && workflowConfig.trigger.webhook) {
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
	 * Find workflow matching the webhook event
	 */
	protected findMatchingWorkflow(event: WebhookEvent): WebhookWorkflowModel | null {
		for (const workflow of this.webhookWorkflows) {
			const config = workflow.config.trigger?.webhook;
			if (!config) continue;

			// Check source match
			if (config.source !== event.source) continue;

			// Check event type match
			if (config.events && config.events.length > 0) {
				const matches = config.events.some((pattern) => {
					// Support wildcards (e.g., "push", "pull_request.*")
					if (pattern === "*") return true;
					if (pattern.endsWith(".*")) {
						const prefix = pattern.slice(0, -2);
						return event.eventType.startsWith(prefix);
					}
					return pattern === event.eventType;
				});
				if (!matches) continue;
			}

			return workflow;
		}

		return null;
	}

	/**
	 * Execute a workflow for a webhook event
	 */
	protected async executeWorkflow(
		event: WebhookEvent,
		workflow: WebhookWorkflowModel,
		config: WebhookTriggerOpts,
	): Promise<TriggerResponse> {
		const executionId = uuid();

		const defaultMeter = metrics.getMeter("default");
		const webhookExecutions = defaultMeter.createCounter("webhook_executions", {
			description: "Webhook executions",
		});
		const webhookErrors = defaultMeter.createCounter("webhook_errors", {
			description: "Webhook execution errors",
		});

		return new Promise((resolve) => {
			this.tracer.startActiveSpan(`webhook:${event.source}/${event.eventType}`, async (span: Span) => {
				try {
					const start = performance.now();

					// Initialize configuration for this workflow
					await this.configuration.init(workflow.path, this.nodeMap);

					// Create context
					const ctx: Context = this.createContext(undefined, workflow.path, executionId);

					// Populate request with webhook event
					ctx.request = {
						body: event.payload,
						headers: event.headers,
						query: {},
						params: {
							source: event.source,
							eventType: event.eventType,
							eventId: event.id,
						},
					} as unknown as RequestContext;

					// Store webhook context in vars
					if (!ctx.vars) ctx.vars = {};
					ctx.vars["_webhook_event"] = {
						id: event.id,
						source: event.source,
						eventType: event.eventType,
						timestamp: event.timestamp.toISOString(),
						hasSignature: String(!!event.signature),
					};

					ctx.logger.log(
						`Processing webhook: ${event.source}/${event.eventType} (${event.id})`,
					);

					// Execute workflow
					const response: TriggerResponse = await this.run(ctx);
					const end = performance.now();

					// Set span attributes
					span.setAttribute("success", true);
					span.setAttribute("event_id", event.id);
					span.setAttribute("source", event.source);
					span.setAttribute("event_type", event.eventType);
					span.setAttribute("workflow_path", workflow.path);
					span.setAttribute("elapsed_ms", end - start);
					span.setStatus({ code: SpanStatusCode.OK });

					// Record metrics
					webhookExecutions.add(1, {
						env: process.env.NODE_ENV,
						source: event.source,
						event_type: event.eventType,
						workflow_name: this.configuration.name,
						success: "true",
					});

					ctx.logger.log(
						`Webhook processed in ${(end - start).toFixed(2)}ms: ${event.id}`,
					);

					resolve(response);
				} catch (error) {
					const errorMessage = (error as Error).message;

					// Set span error
					span.setAttribute("success", false);
					span.recordException(error as Error);
					span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage });

					// Record error metrics
					webhookErrors.add(1, {
						env: process.env.NODE_ENV,
						source: event.source,
						event_type: event.eventType,
						workflow_name: this.configuration?.name || "unknown",
					});

					this.logger.error(
						`Webhook failed ${event.id}: ${errorMessage}`,
						(error as Error).stack,
					);

					throw error;
				} finally {
					span.end();
				}
			});
		});
	}

	/**
	 * Register a custom source handler
	 */
	static registerSourceHandler(source: string, handler: WebhookSourceHandler): void {
		sourceHandlers[source] = handler;
	}
}

export default WebhookTrigger;
export { sourceHandlers };
