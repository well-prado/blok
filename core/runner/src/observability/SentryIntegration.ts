import { createRequire } from "node:module";
import type { ErrorSink } from "./ErrorSink";

/** The slice of @sentry/node's API this adapter uses. */
interface SentryLike {
	init(opts: { dsn: string; tracesSampleRate?: number; environment?: string }): void;
	captureException(error: unknown, hint?: { extra?: Record<string, unknown> }): void;
	flush(timeoutMs?: number): Promise<boolean>;
}

/**
 * An {@link ErrorSink} backed by Sentry. `@sentry/node` is an OPTIONAL peer dep,
 * loaded via a sync `require` so a runner without it still boots — when it's
 * absent this returns an INERT sink (warns once). The caller gates construction
 * on `SENTRY_DSN`, so an unset DSN means this is never built and behaviour is
 * unchanged.
 */
export function createSentryErrorSink(dsn: string): ErrorSink {
	let sentry: SentryLike | null = null;
	try {
		const req = createRequire(import.meta.url);
		sentry = req("@sentry/node") as SentryLike;
		sentry.init({ dsn, tracesSampleRate: 0, environment: process.env.NODE_ENV });
	} catch {
		sentry = null;
		console.warn(
			"[blok][error-sink] SENTRY_DSN is set but @sentry/node isn't installed — the Sentry sink is inert. Run `npm i @sentry/node` to enable it.",
		);
	}

	return {
		captureException(error, context) {
			if (!sentry) return;
			sentry.captureException(error, context ? { extra: context } : undefined);
		},
		async flush(timeoutMs = 2000) {
			return sentry ? sentry.flush(timeoutMs) : true;
		},
	};
}
