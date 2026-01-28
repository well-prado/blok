/**
 * Audit Logger for Blok Framework
 *
 * Provides comprehensive audit logging for security and compliance:
 * - All authentication attempts (success and failure)
 * - Authorization decisions
 * - Workflow executions
 * - Node executions
 * - Configuration changes
 * - System events
 *
 * Supports multiple output destinations via AuditSink interface.
 *
 * @example
 * ```typescript
 * const audit = new AuditLogger({
 *   sinks: [
 *     new ConsoleAuditSink(),
 *     new FileAuditSink({ path: "./audit.log" }),
 *   ],
 *   includeTimestamp: true,
 *   includeRequestId: true,
 * });
 *
 * audit.logAuth({
 *   action: "login",
 *   success: true,
 *   identity: { sub: "user-123", provider: "jwt" },
 *   ip: "192.168.1.1",
 * });
 * ```
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export type AuditCategory =
	| "auth"
	| "authz"
	| "workflow"
	| "node"
	| "trigger"
	| "config"
	| "system"
	| "security";

export type AuditSeverity = "info" | "warn" | "error" | "critical";

export interface AuditEntry {
	/** Unique entry ID */
	id: string;
	/** ISO 8601 timestamp */
	timestamp: string;
	/** Audit category */
	category: AuditCategory;
	/** Severity level */
	severity: AuditSeverity;
	/** Action performed */
	action: string;
	/** Whether the action succeeded */
	success: boolean;
	/** Actor who performed the action */
	actor?: {
		sub: string;
		name?: string;
		ip?: string;
		userAgent?: string;
		provider?: string;
	};
	/** Target resource */
	resource?: {
		type: string;
		id: string;
		name?: string;
	};
	/** Additional details */
	details?: Record<string, unknown>;
	/** Request ID for correlation */
	requestId?: string;
	/** Duration in ms (for execution events) */
	durationMs?: number;
	/** Error information if action failed */
	error?: {
		message: string;
		code?: string | number;
	};
}

/**
 * Interface for audit log output destinations
 */
export interface AuditSink {
	/** Unique name for this sink */
	readonly name: string;
	/** Write an audit entry */
	write(entry: AuditEntry): Promise<void> | void;
	/** Flush any buffered entries */
	flush?(): Promise<void>;
	/** Close the sink */
	close?(): Promise<void>;
}

export interface AuditLoggerConfig {
	/** Output sinks for audit entries */
	sinks: AuditSink[];
	/** Include request ID in entries (default: true) */
	includeRequestId?: boolean;
	/** Minimum severity to log (default: "info") */
	minSeverity?: AuditSeverity;
	/** Buffer size before flushing (default: 100) */
	bufferSize?: number;
	/** Auto-flush interval in ms (default: 5000) */
	flushIntervalMs?: number;
	/** Service name for identification */
	serviceName?: string;
}

const SEVERITY_ORDER: Record<AuditSeverity, number> = {
	info: 0,
	warn: 1,
	error: 2,
	critical: 3,
};

export class AuditLogger {
	private config: Required<AuditLoggerConfig>;
	private buffer: AuditEntry[] = [];
	private flushTimer: NodeJS.Timeout | null = null;
	private entryCounter = 0;
	private pendingFlush: Promise<void> | null = null;

	constructor(config: AuditLoggerConfig) {
		this.config = {
			includeRequestId: true,
			minSeverity: "info",
			bufferSize: 100,
			flushIntervalMs: 5000,
			serviceName: "blok",
			...config,
		};

		// Start auto-flush timer
		if (this.config.flushIntervalMs > 0) {
			this.flushTimer = setInterval(() => this.flush(), this.config.flushIntervalMs);
			// Don't block Node.js from exiting
			if (this.flushTimer.unref) {
				this.flushTimer.unref();
			}
		}
	}

	/**
	 * Log an authentication event
	 */
	logAuth(params: {
		action: "login" | "logout" | "token_refresh" | "api_key_verify";
		success: boolean;
		identity?: { sub: string; provider?: string; name?: string };
		ip?: string;
		userAgent?: string;
		error?: string;
		requestId?: string;
	}): void {
		this.log({
			category: "auth",
			severity: params.success ? "info" : "warn",
			action: params.action,
			success: params.success,
			actor: params.identity
				? {
						sub: params.identity.sub,
						name: params.identity.name,
						ip: params.ip,
						userAgent: params.userAgent,
						provider: params.identity.provider,
					}
				: undefined,
			error: params.error ? { message: params.error } : undefined,
			requestId: params.requestId,
		});
	}

	/**
	 * Log an authorization event
	 */
	logAuthz(params: {
		action: string;
		resource: { type: string; id: string; name?: string };
		roles: string[];
		allowed: boolean;
		actor: { sub: string; name?: string; ip?: string };
		requestId?: string;
	}): void {
		this.log({
			category: "authz",
			severity: params.allowed ? "info" : "warn",
			action: params.action,
			success: params.allowed,
			actor: params.actor,
			resource: params.resource,
			details: { roles: params.roles },
			requestId: params.requestId,
		});
	}

	/**
	 * Log a workflow execution event
	 */
	logWorkflowExecution(params: {
		workflowName: string;
		workflowPath: string;
		success: boolean;
		durationMs: number;
		actor?: { sub: string; ip?: string };
		error?: string;
		requestId?: string;
	}): void {
		this.log({
			category: "workflow",
			severity: params.success ? "info" : "error",
			action: "execute",
			success: params.success,
			actor: params.actor,
			resource: {
				type: "workflow",
				id: params.workflowPath,
				name: params.workflowName,
			},
			durationMs: params.durationMs,
			error: params.error ? { message: params.error } : undefined,
			requestId: params.requestId,
		});
	}

	/**
	 * Log a configuration change event
	 */
	logConfigChange(params: {
		action: "create" | "update" | "delete";
		resourceType: string;
		resourceId: string;
		actor: { sub: string; name?: string };
		details?: Record<string, unknown>;
	}): void {
		this.log({
			category: "config",
			severity: "warn",
			action: `config.${params.action}`,
			success: true,
			actor: params.actor,
			resource: {
				type: params.resourceType,
				id: params.resourceId,
			},
			details: params.details,
		});
	}

	/**
	 * Log a security event
	 */
	logSecurityEvent(params: {
		action: string;
		severity: AuditSeverity;
		details: Record<string, unknown>;
		actor?: { sub: string; ip?: string };
		requestId?: string;
	}): void {
		this.log({
			category: "security",
			severity: params.severity,
			action: params.action,
			success: false,
			actor: params.actor,
			details: params.details,
			requestId: params.requestId,
		});
	}

	/**
	 * Core logging method
	 */
	log(params: Omit<AuditEntry, "id" | "timestamp">): void {
		// Check severity threshold
		if (SEVERITY_ORDER[params.severity] < SEVERITY_ORDER[this.config.minSeverity]) {
			return;
		}

		const entry: AuditEntry = {
			id: `${this.config.serviceName}-${Date.now()}-${++this.entryCounter}`,
			timestamp: new Date().toISOString(),
			...params,
		};

		this.buffer.push(entry);

		// Flush if buffer is full
		if (this.buffer.length >= this.config.bufferSize) {
			this.pendingFlush = this.flush();
		}
	}

	/**
	 * Flush buffered entries to all sinks
	 */
	async flush(): Promise<void> {
		// Wait for any auto-triggered flush to complete
		if (this.pendingFlush) {
			const pending = this.pendingFlush;
			this.pendingFlush = null;
			await pending;
		}

		if (this.buffer.length === 0) return;

		const entries = [...this.buffer];
		this.buffer = [];

		for (const sink of this.config.sinks) {
			for (const entry of entries) {
				try {
					await sink.write(entry);
				} catch {
					// Don't let sink errors break the audit log
				}
			}
			try {
				await sink.flush?.();
			} catch {
				// Silent
			}
		}
	}

	/**
	 * Close the audit logger and flush remaining entries
	 */
	async close(): Promise<void> {
		if (this.flushTimer) {
			clearInterval(this.flushTimer);
			this.flushTimer = null;
		}

		await this.flush();

		for (const sink of this.config.sinks) {
			try {
				await sink.close?.();
			} catch {
				// Silent
			}
		}
	}

	/**
	 * Get entry count since creation
	 */
	getEntryCount(): number {
		return this.entryCounter;
	}
}

/**
 * Console audit sink - outputs audit entries to stdout as JSON
 */
export class ConsoleAuditSink implements AuditSink {
	readonly name = "console";

	write(entry: AuditEntry): void {
		const output = JSON.stringify(entry);
		if (entry.severity === "error" || entry.severity === "critical") {
			console.error(`[AUDIT] ${output}`);
		} else if (entry.severity === "warn") {
			console.warn(`[AUDIT] ${output}`);
		} else {
			console.log(`[AUDIT] ${output}`);
		}
	}
}

/**
 * File audit sink - appends audit entries as JSONL to a file
 */
export class FileAuditSink implements AuditSink {
	readonly name = "file";
	private filePath: string;
	private buffer: string[] = [];
	private initialized = false;

	constructor(config: { path: string }) {
		this.filePath = config.path;
	}

	async write(entry: AuditEntry): Promise<void> {
		this.buffer.push(JSON.stringify(entry));
	}

	async flush(): Promise<void> {
		if (this.buffer.length === 0) return;

		if (!this.initialized) {
			await mkdir(dirname(this.filePath), { recursive: true });
			this.initialized = true;
		}

		const data = this.buffer.join("\n") + "\n";
		this.buffer = [];
		await appendFile(this.filePath, data, "utf-8");
	}

	async close(): Promise<void> {
		await this.flush();
	}
}

/**
 * In-memory audit sink - stores entries in memory (useful for testing)
 */
export class InMemoryAuditSink implements AuditSink {
	readonly name = "memory";
	private entries: AuditEntry[] = [];
	private maxEntries: number;

	constructor(maxEntries = 10000) {
		this.maxEntries = maxEntries;
	}

	write(entry: AuditEntry): void {
		this.entries.push(entry);
		// Ring buffer behavior
		if (this.entries.length > this.maxEntries) {
			this.entries.shift();
		}
	}

	getEntries(): AuditEntry[] {
		return [...this.entries];
	}

	query(filter: {
		category?: AuditCategory;
		severity?: AuditSeverity;
		actorSub?: string;
		action?: string;
		since?: string;
		limit?: number;
	}): AuditEntry[] {
		let results = this.entries;

		if (filter.category) results = results.filter((e) => e.category === filter.category);
		if (filter.severity) results = results.filter((e) => e.severity === filter.severity);
		if (filter.actorSub) results = results.filter((e) => e.actor?.sub === filter.actorSub);
		if (filter.action) results = results.filter((e) => e.action === filter.action);
		if (filter.since) results = results.filter((e) => e.timestamp >= filter.since);
		if (filter.limit) results = results.slice(-filter.limit);

		return results;
	}

	clear(): void {
		this.entries = [];
	}
}
