/**
 * External Integrations for Blok Framework
 *
 * Provides integrations with third-party services:
 * - Sentry: Error tracking and performance monitoring
 * - APM: DataDog, New Relic, and generic OTLP backends
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

export { APMIntegration } from "./APMIntegration";
export type {
	APMVendor,
	APMConfig,
	APMBootstrapResult,
} from "./APMIntegration";
