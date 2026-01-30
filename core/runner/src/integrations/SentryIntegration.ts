/**
 * Sentry Error Tracking Integration for Blok
 *
 * Provides error tracking and performance monitoring via Sentry.
 * Captures workflow execution errors, node failures, and trigger issues
 * with full context (workflow name, node, request ID, etc.).
 *
 * Uses a lightweight adapter pattern so Sentry SDK is loaded lazily
 * and the framework doesn't hard-depend on @sentry/node.
 *
 * @example
 * ```typescript
 * import { SentryIntegration } from "@blok/runner";
 *
 * const sentry = new SentryIntegration({
 *   dsn: process.env.SENTRY_DSN!,
 *   environment: process.env.NODE_ENV || "development",
 *   release: "blok@1.0.0",
 *   tracesSampleRate: 0.1,
 * });
 *
 * await sentry.init();
 *
 * // In error handler
 * sentry.captureWorkflowError(error, {
 *   workflowName: "get-user",
 *   workflowPath: "/users/:id",
 *   requestId: ctx.id,
 * });
 * ```
 */

export interface SentryConfig {
	/** Sentry DSN (Data Source Name) */
	dsn: string;
	/** Environment (e.g., "production", "staging", "development") */
	environment?: string;
	/** Release version */
	release?: string;
	/** Server name */
	serverName?: string;
	/** Sample rate for error events (0.0 to 1.0, default: 1.0) */
	sampleRate?: number;
	/** Sample rate for performance/transaction traces (0.0 to 1.0, default: 0.1) */
	tracesSampleRate?: number;
	/** Tags to add to all events */
	tags?: Record<string, string>;
	/** Enable debug mode */
	debug?: boolean;
}

export interface WorkflowErrorContext {
	workflowName: string;
	workflowPath: string;
	workflowVersion?: string;
	requestId?: string;
	nodeName?: string;
	nodeType?: string;
	triggerType?: string;
	durationMs?: number;
	userId?: string;
}

export interface SentryClient {
	captureException(error: Error, context?: Record<string, unknown>): string;
	captureMessage(message: string, level: "info" | "warning" | "error" | "fatal"): string;
	setTag(key: string, value: string): void;
	setUser(user: { id: string; email?: string; username?: string } | null): void;
	startTransaction(context: { name: string; op: string }): SentryTransaction;
	flush(timeout: number): Promise<boolean>;
}

export interface SentryTransaction {
	setTag(key: string, value: string): void;
	setData(key: string, value: unknown): void;
	finish(): void;
	startChild(context: { op: string; description: string }): SentrySpan;
}

export interface SentrySpan {
	setTag(key: string, value: string): void;
	setData(key: string, value: unknown): void;
	setStatus(status: string): void;
	finish(): void;
}

export class SentryIntegration {
	private config: SentryConfig;
	private client: SentryClient | null = null;
	private initialized = false;
	private eventCount = 0;
	private errorCount = 0;

	constructor(config: SentryConfig) {
		this.config = {
			environment: process.env.NODE_ENV || "development",
			sampleRate: 1.0,
			tracesSampleRate: 0.1,
			debug: false,
			...config,
		};
	}

	/**
	 * Initialize Sentry SDK (lazy-loads @sentry/node)
	 */
	async init(): Promise<boolean> {
		if (this.initialized) return true;

		try {
			// Dynamic import to avoid hard dependency — @sentry/node is optional
			// @ts-expect-error: @sentry/node types not installed; loaded lazily at runtime
			const Sentry = await import("@sentry/node");

			Sentry.init({
				dsn: this.config.dsn,
				environment: this.config.environment,
				release: this.config.release,
				serverName: this.config.serverName,
				sampleRate: this.config.sampleRate,
				tracesSampleRate: this.config.tracesSampleRate,
				debug: this.config.debug,
			});

			// Set global tags
			if (this.config.tags) {
				for (const [key, value] of Object.entries(this.config.tags)) {
					Sentry.setTag(key, value);
				}
			}

			Sentry.setTag("framework", "blok");

			// Create adapter
			this.client = {
				captureException: (error: Error, context?: Record<string, unknown>) => {
					return Sentry.captureException(error, {
						extra: context,
					});
				},
				captureMessage: (message: string, level: "info" | "warning" | "error" | "fatal") => {
					return Sentry.captureMessage(message, level);
				},
				setTag: (key: string, value: string) => Sentry.setTag(key, value),
				setUser: (user) => Sentry.setUser(user),
				startTransaction: (context) => {
					return Sentry.startSpan(context, (span: unknown) => span) as unknown as SentryTransaction;
				},
				flush: (timeout: number) => Sentry.flush(timeout),
			};

			this.initialized = true;
			return true;
		} catch {
			// @sentry/node not installed - that's OK, fail silently
			this.initialized = false;
			return false;
		}
	}

	/**
	 * Set a custom Sentry client (useful for testing)
	 */
	setClient(client: SentryClient): void {
		this.client = client;
		this.initialized = true;
	}

	/**
	 * Capture a workflow execution error
	 */
	captureWorkflowError(error: Error, context: WorkflowErrorContext): string | null {
		if (!this.client) return null;

		this.errorCount++;
		this.eventCount++;

		const eventId = this.client.captureException(error, {
			workflow_name: context.workflowName,
			workflow_path: context.workflowPath,
			workflow_version: context.workflowVersion,
			request_id: context.requestId,
			node_name: context.nodeName,
			node_type: context.nodeType,
			trigger_type: context.triggerType,
			duration_ms: context.durationMs,
		});

		return eventId;
	}

	/**
	 * Capture a node execution error
	 */
	captureNodeError(
		error: Error,
		nodeName: string,
		nodeType: string,
		context?: { workflowName?: string; requestId?: string },
	): string | null {
		if (!this.client) return null;

		this.errorCount++;
		this.eventCount++;

		return this.client.captureException(error, {
			node_name: nodeName,
			node_type: nodeType,
			workflow_name: context?.workflowName,
			request_id: context?.requestId,
		});
	}

	/**
	 * Capture a trigger error
	 */
	captureTriggerError(error: Error, triggerType: string, context?: Record<string, unknown>): string | null {
		if (!this.client) return null;

		this.errorCount++;
		this.eventCount++;

		return this.client.captureException(error, {
			trigger_type: triggerType,
			...context,
		});
	}

	/**
	 * Capture a warning message
	 */
	captureWarning(message: string, context?: Record<string, unknown>): string | null {
		if (!this.client) return null;
		this.eventCount++;

		return this.client.captureMessage(context ? `${message} | ${JSON.stringify(context)}` : message, "warning");
	}

	/**
	 * Set current user context
	 */
	setUser(user: { id: string; email?: string; username?: string } | null): void {
		this.client?.setUser(user);
	}

	/**
	 * Add a tag to all future events
	 */
	setTag(key: string, value: string): void {
		this.client?.setTag(key, value);
	}

	/**
	 * Flush pending events to Sentry
	 */
	async flush(timeoutMs = 2000): Promise<boolean> {
		if (!this.client) return true;
		return this.client.flush(timeoutMs);
	}

	/**
	 * Check if Sentry is initialized
	 */
	isInitialized(): boolean {
		return this.initialized;
	}

	/**
	 * Get stats about captured events
	 */
	getStats(): { initialized: boolean; eventCount: number; errorCount: number } {
		return {
			initialized: this.initialized,
			eventCount: this.eventCount,
			errorCount: this.errorCount,
		};
	}
}
