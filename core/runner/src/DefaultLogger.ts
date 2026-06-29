import { GlobalLogger } from "@blokjs/shared";

/**
 * Severity ranking for `BLOK_LOG_LEVEL` filtering. Higher = more severe.
 * A message is emitted only when its level ranks at or above the configured
 * threshold, so `BLOK_LOG_LEVEL=warn` suppresses `info`/`debug` but keeps
 * `warn`/`error`. Unknown levels rank as `info` (the default channel).
 * Mirrors `StructuredLogger`'s ordering — kept local to avoid coupling the
 * runtime logger to the structured-logging module.
 */
const LEVEL_RANK: Record<string, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	warning: 2,
	error: 3,
	fatal: 4,
};

/**
 * DefaultLogger class extends GlobalLogger to provide logging functionality
 * with additional metadata such as workflow name, workflow path, request ID,
 * environment, and application name.
 */
export default class DefaultLogger extends GlobalLogger {
	/**
	 * The name of the workflow.
	 */
	workflowName: string | undefined = "";

	/**
	 * The path of the workflow.
	 */
	workflowPath: string | undefined = "";

	/**
	 * The ID of the request.
	 */
	requestId: string | undefined = "";

	/**
	 * The environment in which the application is running.
	 */
	env: string | undefined = "";

	/**
	 * The name of the application.
	 */
	appName: string | undefined = "";

	/**
	 * OBS-03 — correlation keys. `runId` ties a stdout line to the Studio run;
	 * `traceId`/`spanId` tie it to the OTel trace in Tempo. Set by `TracingLogger`
	 * after `tracker.startRun()` (run id) + from the active span (trace ids), so
	 * Studio ↔ Tempo ↔ Loki become one joined view. Unset → simply omitted.
	 */
	runId: string | undefined = undefined;
	traceId: string | undefined = undefined;
	spanId: string | undefined = undefined;

	/** OBS-03 — set the Studio run id on subsequent log lines. */
	setRunId(runId?: string): void {
		this.runId = runId;
	}

	/** OBS-03 — set the active OTel trace/span ids on subsequent log lines. */
	setTraceContext(traceId?: string, spanId?: string): void {
		this.traceId = traceId;
		this.spanId = spanId;
	}

	/**
	 * Constructs a new DefaultLogger instance.
	 *
	 * @param workflowName - The name of the workflow.
	 * @param workflowPath - The path of the workflow.
	 * @param requestId - The ID of the request.
	 */
	constructor(workflowName?: string, workflowPath?: string, requestId?: string) {
		super();
		this.workflowName = workflowName;
		this.workflowPath = workflowPath;
		this.requestId = requestId;
		this.env = process.env.NODE_ENV;
		this.appName = process.env.APP_NAME;
	}

	/**
	 * Whether a message at `level` should be emitted given `BLOK_LOG_LEVEL`.
	 * Read per-call so the threshold honors env changes at runtime; defaults
	 * to `info` when the env var is unset or names an unknown level.
	 */
	private shouldEmit(level: string): boolean {
		if (process.env.CONSOLE_LOG_ACTIVE === "false") return false;
		const threshold = LEVEL_RANK[(process.env.BLOK_LOG_LEVEL ?? "info").toLowerCase()] ?? LEVEL_RANK.info;
		return (LEVEL_RANK[level.toLowerCase()] ?? LEVEL_RANK.info) >= threshold;
	}

	/**
	 * Logs a message to the console with metadata.
	 *
	 * @param message - The message to log.
	 */
	log(message: string) {
		if (!this.shouldEmit("info")) return;
		console.log(this.injectMetadata(message));
	}

	/**
	 * Logs a message to the console with a specified log level and metadata.
	 *
	 * @param level - The log level (e.g., "info", "error").
	 * @param message - The message to log.
	 */
	logLevel(level: string, message: string): void {
		if (!this.shouldEmit(level)) return;
		console.log(this.injectMetadata(message, level));
	}

	/**
	 * Logs an error message to the console with metadata.
	 *
	 * @param message - The error message to log.
	 * @param stack - The stack trace (optional).
	 */
	error(message: string, stack = ""): void {
		if (!this.shouldEmit("error")) return;
		console.error(this.injectMetadata(message, "error", stack));
	}

	/**
	 * Injects metadata into a log message.
	 *
	 * @param message - The message to inject metadata into.
	 * @param level - The log level (default is "info").
	 * @param stack - The stack trace (optional).
	 * @returns The message with injected metadata.
	 */
	injectMetadata(message: string, level = "info", stack = ""): string {
		const logEntry: Record<string, unknown> = {
			level,
			app: this.appName,
			env: this.env,
			message,
		};

		if (this.workflowName) logEntry.workflow_name = this.workflowName;
		if (this.workflowPath) logEntry.workflow_path = this.workflowPath;
		if (this.requestId) logEntry.request_id = this.requestId;
		// OBS-03 — correlation keys so a log line joins to its Studio run + Tempo trace.
		if (this.runId) logEntry.run_id = this.runId;
		if (this.traceId) logEntry.trace_id = this.traceId;
		if (this.spanId) logEntry.span_id = this.spanId;
		if (stack !== "") logEntry.stack = stack;

		return JSON.stringify(logEntry);
	}
}
