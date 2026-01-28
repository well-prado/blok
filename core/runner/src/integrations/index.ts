/**
 * External Integrations for Blok Framework
 *
 * Provides integrations with third-party services:
 * - Sentry: Error tracking and performance monitoring
 *
 * All integrations use lazy-loading to avoid hard dependencies.
 */

export { SentryIntegration } from "./SentryIntegration";
export type {
	SentryConfig,
	WorkflowErrorContext,
	SentryClient,
	SentryTransaction,
	SentrySpan,
} from "./SentryIntegration";
