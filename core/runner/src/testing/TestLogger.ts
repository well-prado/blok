import { GlobalLogger } from "@blok/shared";

/**
 * A log entry captured during test execution.
 */
export interface LogEntry {
	/** Log level: "info" | "warn" | "error" | "debug" */
	level: string;
	/** The log message */
	message: string;
	/** Timestamp when the log was recorded (ms since epoch) */
	timestamp: number;
}

/**
 * TestLogger - A logger that captures log output for testing.
 *
 * Extends GlobalLogger to be compatible with the Context.logger interface
 * while storing all log entries in memory for assertion and inspection.
 *
 * @example
 * ```typescript
 * const logger = new TestLogger();
 * logger.info("User created");
 * logger.warn("Rate limit approaching");
 *
 * // Assert specific messages were logged
 * logger.assertLogged("User created", "info");
 * logger.assertLogged(/rate limit/i, "warn");
 *
 * // Inspect all logs
 * const errors = logger.getLogsByLevel("error");
 * ```
 */
export class TestLogger extends GlobalLogger {
	private entries: LogEntry[];

	constructor() {
		super();
		this.entries = [];
	}

	/**
	 * Log an info-level message.
	 */
	info(message: string): void {
		this.addEntry("info", message);
	}

	/**
	 * Log a warning-level message.
	 */
	warn(message: string): void {
		this.addEntry("warn", message);
	}

	/**
	 * Log a debug-level message.
	 */
	debug(message: string): void {
		this.addEntry("debug", message);
	}

	/**
	 * Implementation of GlobalLogger.log - logs at info level.
	 */
	log(message: string): void {
		this.addEntry("info", message);
	}

	/**
	 * Implementation of GlobalLogger.logLevel.
	 */
	logLevel(level: string, message: string): void {
		this.addEntry(level, message);
	}

	/**
	 * Implementation of GlobalLogger.error.
	 */
	error(message: string, _stack = ""): void {
		this.addEntry("error", message);
	}

	/**
	 * Get all logged entries.
	 */
	getLogs(): string[] {
		return this.entries.map((entry) => entry.message);
	}

	/**
	 * Get all log entries with full metadata.
	 */
	getEntries(): LogEntry[] {
		return [...this.entries];
	}

	/**
	 * Get log entries filtered by level.
	 *
	 * @param level - The log level to filter by ("info", "warn", "error", "debug")
	 * @returns Array of matching log entries
	 */
	getLogsByLevel(level: string): LogEntry[] {
		return this.entries.filter((entry) => entry.level === level);
	}

	/**
	 * Assert that a specific message was logged.
	 *
	 * @param message - String or RegExp to match against log messages
	 * @param level - Optional level to restrict the search to
	 * @throws Error if no matching log entry is found
	 */
	assertLogged(message: string | RegExp, level?: string): void {
		const searchEntries = level ? this.getLogsByLevel(level) : this.entries;

		const found = searchEntries.some((entry) => {
			if (typeof message === "string") {
				return entry.message.includes(message);
			}
			return message.test(entry.message);
		});

		if (!found) {
			const levelInfo = level ? ` at level "${level}"` : "";
			const loggedMessages = searchEntries.map((e) => `  [${e.level}] ${e.message}`).join("\n");
			throw new Error(
				`Expected log message matching ${message}${levelInfo} but none was found.\n` +
					`Logged messages:\n${loggedMessages || "  (none)"}`,
			);
		}
	}

	/**
	 * Assert that a specific message was NOT logged.
	 *
	 * @param message - String or RegExp to match against log messages
	 * @param level - Optional level to restrict the search to
	 * @throws Error if a matching log entry is found
	 */
	assertNotLogged(message: string | RegExp, level?: string): void {
		const searchEntries = level ? this.getLogsByLevel(level) : this.entries;

		const found = searchEntries.some((entry) => {
			if (typeof message === "string") {
				return entry.message.includes(message);
			}
			return message.test(entry.message);
		});

		if (found) {
			const levelInfo = level ? ` at level "${level}"` : "";
			throw new Error(`Expected log message matching ${message}${levelInfo} to NOT be present, but it was found.`);
		}
	}

	/**
	 * Clear all captured log entries.
	 */
	clear(): void {
		this.entries = [];
		this.logs = [];
	}

	/**
	 * Get the total number of log entries.
	 */
	get count(): number {
		return this.entries.length;
	}

	/**
	 * Internal helper to add a log entry.
	 */
	private addEntry(level: string, message: string): void {
		const entry: LogEntry = {
			level,
			message,
			timestamp: Date.now(),
		};
		this.entries.push(entry);
		this.logs.push(message);
	}
}
