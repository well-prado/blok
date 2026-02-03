/**
 * StructuredLogger - Production-grade JSON structured logging with trace context
 *
 * Outputs machine-parseable JSON log lines with standardized fields compatible
 * with Grafana Loki, ELK Stack, CloudWatch Logs, and DataDog Logs.
 *
 * Key features:
 * - JSON-structured output with consistent field ordering
 * - OpenTelemetry trace context correlation (trace_id, span_id)
 * - Log levels: debug, info, warn, error, fatal
 * - Child loggers with inherited context
 * - Configurable transports (stdout, stderr, callback)
 * - Respects BLOK_LOG_LEVEL and CONSOLE_LOG_ACTIVE env vars
 *
 * @example
 * ```typescript
 * import { StructuredLogger } from "@blokjs/runner";
 *
 * const logger = new StructuredLogger({
 *   service: "blok-http",
 *   environment: "production",
 * });
 *
 * logger.info("Workflow started", { workflow: "user-api", requestId: "abc" });
 * // Output: {"timestamp":"2026-01-29T...","level":"info","service":"blok-http",
 * //          "message":"Workflow started","workflow":"user-api","requestId":"abc"}
 *
 * // Child logger with persistent fields
 * const reqLogger = logger.child({ requestId: "abc", workflow: "user-api" });
 * reqLogger.info("Node executed", { node: "db-query", durationMs: 42 });
 * ```
 */

import { type Span, trace } from "@opentelemetry/api";

export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
	fatal: 4,
};

export interface StructuredLoggerConfig {
	/** Service name */
	service: string;
	/** Deployment environment (defaults to NODE_ENV) */
	environment?: string;
	/** Minimum log level (defaults to BLOK_LOG_LEVEL env or "info") */
	level?: LogLevel;
	/** Custom transport function (defaults to console.log/console.error) */
	transport?: (entry: LogEntry) => void;
	/** Additional fields added to every log entry */
	defaultFields?: Record<string, unknown>;
}

export interface LogEntry {
	/** ISO 8601 timestamp */
	timestamp: string;
	/** Log level */
	level: LogLevel;
	/** Service name */
	service: string;
	/** Environment */
	env: string;
	/** Log message */
	message: string;
	/** OpenTelemetry trace ID (if available) */
	trace_id?: string;
	/** OpenTelemetry span ID (if available) */
	span_id?: string;
	/** Additional structured fields */
	[key: string]: unknown;
}

export class StructuredLogger {
	private config: Required<Pick<StructuredLoggerConfig, "service" | "environment" | "level">>;
	private transport: (entry: LogEntry) => void;
	private defaultFields: Record<string, unknown>;
	private minLevelPriority: number;

	/** Collected log entries (kept for getLogs() compatibility) */
	private logs: LogEntry[] = [];
	private maxLogBuffer: number;

	constructor(config: StructuredLoggerConfig) {
		this.config = {
			service: config.service,
			environment: config.environment || process.env.NODE_ENV || "development",
			level: config.level || (process.env.BLOK_LOG_LEVEL as LogLevel) || "info",
		};

		this.minLevelPriority = LOG_LEVEL_PRIORITY[this.config.level] ?? 1;
		this.defaultFields = config.defaultFields ?? {};
		this.maxLogBuffer = 1000;

		this.transport =
			config.transport ??
			((entry: LogEntry) => {
				const json = JSON.stringify(entry);
				if (entry.level === "error" || entry.level === "fatal") {
					process.stderr.write(`${json}\n`);
				} else {
					process.stdout.write(`${json}\n`);
				}
			});
	}

	/**
	 * Create a child logger with additional persistent context fields.
	 * Useful for request-scoped logging.
	 */
	child(fields: Record<string, unknown>): StructuredLogger {
		const child = new StructuredLogger({
			service: this.config.service,
			environment: this.config.environment,
			level: this.config.level,
			transport: this.transport,
			defaultFields: { ...this.defaultFields, ...fields },
		});
		return child;
	}

	/**
	 * Log at debug level.
	 */
	debug(message: string, fields?: Record<string, unknown>): void {
		this.write("debug", message, fields);
	}

	/**
	 * Log at info level.
	 */
	info(message: string, fields?: Record<string, unknown>): void {
		this.write("info", message, fields);
	}

	/**
	 * Log at warn level.
	 */
	warn(message: string, fields?: Record<string, unknown>): void {
		this.write("warn", message, fields);
	}

	/**
	 * Log at error level, optionally with an Error object.
	 */
	error(message: string, fields?: Record<string, unknown> & { error?: Error }): void {
		const extra: Record<string, unknown> = { ...fields };
		if (extra.error instanceof Error) {
			extra.error_message = extra.error.message;
			extra.error_stack = extra.error.stack;
			extra.error_name = extra.error.name;
			extra.error = undefined;
		}
		this.write("error", message, extra);
	}

	/**
	 * Log at fatal level.
	 */
	fatal(message: string, fields?: Record<string, unknown>): void {
		this.write("fatal", message, fields);
	}

	/**
	 * Log with an explicit span for trace correlation.
	 * Use when you have a reference to the active span.
	 */
	withSpan(span: Span, level: LogLevel, message: string, fields?: Record<string, unknown>): void {
		const spanCtx = span.spanContext();
		this.write(level, message, {
			...fields,
			trace_id: spanCtx.traceId,
			span_id: spanCtx.spanId,
		});
	}

	/**
	 * Get collected log entries.
	 */
	getLogs(): LogEntry[] {
		return [...this.logs];
	}

	/**
	 * Get collected logs as newline-delimited JSON (NDJSON).
	 */
	getLogsAsNDJSON(): string {
		return this.logs.map((entry) => JSON.stringify(entry)).join("\n");
	}

	/**
	 * Clear the log buffer.
	 */
	clearLogs(): void {
		this.logs = [];
	}

	/**
	 * Get current minimum log level.
	 */
	getLevel(): LogLevel {
		return this.config.level;
	}

	/**
	 * Set minimum log level at runtime.
	 */
	setLevel(level: LogLevel): void {
		this.config.level = level;
		this.minLevelPriority = LOG_LEVEL_PRIORITY[level] ?? 1;
	}

	/**
	 * Check if a given level is enabled (at or above current minimum).
	 */
	isLevelEnabled(level: LogLevel): boolean {
		return (LOG_LEVEL_PRIORITY[level] ?? 0) >= this.minLevelPriority;
	}

	// --- Internal ---

	private write(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
		// Check CONSOLE_LOG_ACTIVE
		if (process.env.CONSOLE_LOG_ACTIVE === "false") return;

		// Check minimum level
		if ((LOG_LEVEL_PRIORITY[level] ?? 0) < this.minLevelPriority) return;

		const entry: LogEntry = {
			timestamp: new Date().toISOString(),
			level,
			service: this.config.service,
			env: this.config.environment,
			message,
			...this.defaultFields,
			...fields,
		};

		// Inject OpenTelemetry trace context if available and not already set
		if (!entry.trace_id) {
			const activeSpan = trace.getActiveSpan();
			if (activeSpan) {
				const spanCtx = activeSpan.spanContext();
				if (spanCtx.traceId !== "00000000000000000000000000000000") {
					entry.trace_id = spanCtx.traceId;
					entry.span_id = spanCtx.spanId;
				}
			}
		}

		// Buffer for getLogs()
		this.logs.push(entry);
		if (this.logs.length > this.maxLogBuffer) {
			this.logs = this.logs.slice(-Math.floor(this.maxLogBuffer / 2));
		}

		// Transport
		this.transport(entry);
	}
}
