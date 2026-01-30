import type { LoggerContext } from "@blok/shared";
import { RunTracker } from "./RunTracker";

/**
 * Wraps an existing LoggerContext to forward log entries to RunTracker
 * for trace correlation. All log calls are passed through to the inner
 * logger unchanged, so existing behavior is fully preserved.
 */
export class TracingLogger implements LoggerContext {
	private inner: LoggerContext;
	private runId: string;
	private tracker: RunTracker;

	constructor(inner: LoggerContext, runId: string, tracker?: RunTracker) {
		this.inner = inner;
		this.runId = runId;
		this.tracker = tracker || RunTracker.getInstance();
	}

	log(message: string): void {
		this.inner.log(message);
		this.forwardToTracker("info", message);
	}

	logLevel(level: string, message: string): void {
		this.inner.logLevel(level, message);
		this.forwardToTracker(this.normalizeLevel(level), message);
	}

	error(message: string, stack?: string): void {
		this.inner.error(message, stack || "");
		this.forwardToTracker("error", message, stack ? { stack } : undefined);
	}

	getLogs(): string[] {
		return this.inner.getLogs();
	}

	getLogsAsText(): string {
		return this.inner.getLogsAsText();
	}

	getLogsAsBase64(): string {
		return this.inner.getLogsAsBase64();
	}

	private forwardToTracker(
		level: "debug" | "info" | "warn" | "error",
		message: string,
		data?: Record<string, unknown>,
	): void {
		if (!this.tracker.active) return;
		this.tracker.addLog({
			runId: this.runId,
			level,
			message,
			data,
		});
	}

	private normalizeLevel(level: string): "debug" | "info" | "warn" | "error" {
		switch (level.toLowerCase()) {
			case "debug":
				return "debug";
			case "warn":
			case "warning":
				return "warn";
			case "error":
			case "fatal":
				return "error";
			default:
				return "info";
		}
	}
}
