/**
 * External Integrations for Blok Framework
 *
 * Provides integrations with third-party services:
 * - Sentry: Error tracking and performance monitoring
 * - APM: DataDog, New Relic, and generic OTLP backends
 * - CloudWatch: AWS CloudWatch metrics, logs, and traces (via ADOT → X-Ray)
 * - Azure Monitor: Azure Application Insights traces, metrics, and events
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

export { CloudWatchIntegration } from "./CloudWatchIntegration";
export type {
	CloudWatchConfig,
	CloudWatchUnit,
	CloudWatchLogEntry,
	CloudWatchStats,
} from "./CloudWatchIntegration";

export { AzureMonitorIntegration } from "./AzureMonitorIntegration";
export type {
	AzureMonitorConfig,
	AzureMonitorStats,
} from "./AzureMonitorIntegration";
