import type { LoggerContext } from "@blokjs/shared";
import { isSpanContextValid, trace } from "@opentelemetry/api";
import { RunTracker } from "./RunTracker";

/** Loggers (e.g. DefaultLogger) that accept OBS-03 correlation keys. */
interface CorrelatableLogger {
	setRunId?(runId?: string): void;
	setTraceContext?(traceId?: string, spanId?: string): void;
}

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

		// OBS-03 — stamp correlation keys onto the inner (stdout) logger so a log
		// line can be joined to its Studio run + Tempo trace. `runId` is known
		// here; the trace/span ids come from the active span, which IS active at
		// construction (this runs inside the trigger's `startActiveSpan` callback)
		// when distributed tracing is enabled — otherwise they're simply omitted.
		const correlatable = inner as CorrelatableLogger;
		correlatable.setRunId?.(runId);
		const sc = trace.getActiveSpan()?.spanContext();
		if (sc && isSpanContextValid(sc)) {
			correlatable.setTraceContext?.(sc.traceId, sc.spanId);
		}
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
