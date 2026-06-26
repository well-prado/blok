/**
 * Generic error sink — a process-wide hook for forwarding unhandled errors to an
 * external service (Sentry, Rollbar, a webhook, …). Deliberately NOT Sentry-
 * specific: Sentry is one adapter ({@link SentryIntegration}). Inert until an
 * adapter is installed via {@link setErrorSink} (the trigger does this at boot
 * only when `SENTRY_DSN` is set), so the default behaviour is unchanged.
 */

export interface ErrorSink {
	/** Report an error to the sink. MUST NOT throw. */
	captureException(error: unknown, context?: Record<string, unknown>): void;
	/** Best-effort flush of buffered events; resolves true when drained. */
	flush(timeoutMs?: number): Promise<boolean>;
}

let _sink: ErrorSink | null = null;

/** Install (or clear, with `null`) the process-wide error sink. */
export function setErrorSink(sink: ErrorSink | null): void {
	_sink = sink;
}

/** The currently-installed sink, or null when none is configured. */
export function getErrorSink(): ErrorSink | null {
	return _sink;
}

/**
 * Report an error to the configured sink, if any. NEVER throws — error
 * reporting must not be able to crash the application it's observing. A no-op
 * when no sink is installed.
 */
export function captureError(error: unknown, context?: Record<string, unknown>): void {
	if (!_sink) return;
	try {
		_sink.captureException(error, context);
	} catch {
		// Reporting failures are swallowed by design.
	}
}
