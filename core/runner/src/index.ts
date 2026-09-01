/**
 * @packageDocumentation
 * @deprecated Prefer `@blokjs/core`. The full engine surface is re-exported from
 * `@blokjs/core/runtime` (and the light authoring DSL from `@blokjs/core`), so a
 * project only needs the one package (#374/#378). `@blokjs/runner` stays
 * published as a back-compat alias — existing imports keep working unchanged —
 * but new code should import from `@blokjs/core`.
 */
import Configuration from "./Configuration";
import ConfigurationResolver from "./ConfigurationResolver";
import DefaultLogger from "./DefaultLogger";
import LocalStorage from "./LocalStorage";
import ManualTrigger from "./ManualTrigger";
import ResolverBase from "./ResolverBase";
import Runner from "./Runner";
import TriggerBase from "./TriggerBase";
import { DebugController } from "./debug/DebugController";

import { RuntimeAdapterNode } from "./RuntimeAdapterNode";
// Runtime adapters
import { RuntimeRegistry } from "./RuntimeRegistry";
import { BunRuntimeAdapter } from "./adapters/BunRuntimeAdapter";
import { DockerRuntimeAdapter } from "./adapters/DockerRuntimeAdapter";
import { NodeJsRuntimeAdapter } from "./adapters/NodeJsRuntimeAdapter";
import type { ExecutionResult, RuntimeAdapter, RuntimeKind } from "./adapters/RuntimeAdapter";
import { WasmRuntimeAdapter } from "./adapters/WasmRuntimeAdapter";
import { DEFAULT_HEALTH_SERVICE_CONFIG, buildChannelOptions } from "./adapters/grpc/GrpcChannelOptions";
import { GrpcClientPool, buildCredentials } from "./adapters/grpc/GrpcClientPool";
import {
	bufferToJson,
	decodeExecuteResponse,
	encodeExecuteRequest,
	getNodeRuntimeService,
	jsonToBuffer,
} from "./adapters/grpc/GrpcCodec";
import {
	GRPC_STATUS_MAP,
	categoryToGrpcStatus,
	toBlokError as grpcToBlokError,
	isServiceError,
} from "./adapters/grpc/GrpcErrors";
import { GrpcRuntimeAdapter } from "./adapters/grpc/GrpcRuntimeAdapter";
import { DEFAULT_GRPC_PORTS, GRPC_DEFAULTS } from "./adapters/grpc/types";
import { assertGrpcOnlyTransport } from "./adapters/transport";
import { browserArtifactFilePath, saveBrowserScreenshot } from "./browserArtifacts";
import type { BrowserScreenshotArtifact } from "./browserArtifacts";
import {
	registerContextCleanup,
	registerShutdownCleanup,
	runContextCleanups,
	runShutdownCleanups,
} from "./contextCleanup";

// Function-first node API
import { type FnNodeDefinition, FunctionNode, defineNode } from "./defineNode";

// Handle-DSL authoring runtime (#421) — the eventual @blokjs/core surface.
// branch + typed comparators (#418, ADR 0003/0004); tpl (#425).
import {
	branch,
	forEach as callbackForEach,
	switchOn as callbackSwitchOn,
	tryCatch as callbackTryCatch,
	eq as condEq,
	gt as condGt,
	gte as condGte,
	lt as condLt,
	lte as condLte,
	ne as condNe,
	not as condNot,
	makeHandle,
	state,
	step,
	subworkflow,
	tpl,
	workflowCallback,
} from "./stepBuilder";

import { CircuitBreaker, CircuitOpenError } from "./monitoring/CircuitBreaker";
// Monitoring infrastructure
import { HealthCheck } from "./monitoring/HealthCheck";
import { bootstrapPrometheus, resetPrometheusBootstrap } from "./monitoring/PrometheusBootstrap";
import { PrometheusMetricsBridge } from "./monitoring/PrometheusMetricsBridge";
import { RateLimiter } from "./monitoring/RateLimiter";
import {
	type TracingBootstrapConfig,
	type TracingBootstrapResult,
	bootstrapTracing,
	resetTracingBootstrap,
} from "./monitoring/TracingBootstrap";
import { TriggerMetricsCollector } from "./monitoring/TriggerMetricsCollector";

// Marketplace infrastructure

// Hot Module Replacement (HMR)
import { FileWatcher } from "./hmr/FileWatcher";
import { HmrDevConsole } from "./hmr/HmrDevConsole";
import { HotReloadManager } from "./hmr/HotReloadManager";

// Security

// OpenAPI

// GraphQL

import { NodeDependencyGraph } from "./visualization/NodeDependencyGraph";
// Visualization
import { WorkflowVisualizer } from "./visualization/WorkflowVisualizer";

// Performance Profiling
import { PerformanceProfiler } from "./monitoring/PerformanceProfiler";

// Tracing (Blok Studio)
import { Janitor } from "./tracing/Janitor";
import { type RoutingDiagnostic, RoutingDiagnostics } from "./tracing/RoutingDiagnostics";
import { RunTracker } from "./tracing/RunTracker";
import { registerTraceRoutes } from "./tracing/TraceRouter";
import { TracingLogger } from "./tracing/TracingLogger";
import { redactSensitive as traceRedactSensitive, sanitize as traceSanitize } from "./tracing/sanitize";

// Workflow registry (Tier 2 sub-workflow primitive)
import { type RegisteredWorkflow, type WorkflowAuthorizeFn, WorkflowRegistry } from "./workflow/WorkflowRegistry";

// Nearest-miss "did you mean…?" helper, shared by every by-name/by-route
// lookup that can fail (#693): HTTP catch-all, RPC mount, subworkflow lookup.
import { type MatchCandidate, type RankedMatch, levenshteinDistance, nearestMatches } from "./workflow/NearestMatch";
export {
	authorizeStep,
	hasPolicyExecution,
	InMemoryAuditSink,
	InMemorySecretResolver,
	InMemoryPolicyProvider,
	installPolicyExecution,
	PolicyAuditError,
	PolicyDeniedError,
	PolicyInteractionRequiredError,
	propagatePolicyExecution,
	recordPostExecution,
	resolveSecret,
	SecretResolutionError,
	type PolicyExecutionOptions,
	type PolicyToken,
	type SandboxVerifier,
} from "./policy/PolicyPipeline";
export {
	DurableInteractionPort,
	InMemoryInteractionStore,
	InteractionAuthorizationError,
	InteractionConflictError,
} from "./policy/InteractionStore";

// Concurrency gate (Tier 2 #6)
import {
	ConcurrencyLimitError,
	type ConcurrencyLimitInfo,
	isConcurrencyLimitError,
} from "./concurrency/ConcurrencyLimitError";
// Queue-mode TTL expiry (PR 1-5 polish · 410 Gone vs 429)
import { QueueExpiredError, type QueueExpiredInfo, isQueueExpiredError } from "./concurrency/QueueExpiredError";
// Resolved-key guard (#706) — expression-shaped keys never degrade to constants
import { UnresolvableKeyExpressionError, assertResolvableKey } from "./idempotency/resolveIdempotencyKey";

import {
	CONCURRENCY_DEFAULTS,
	type NormalizedConcurrencyConfig,
	readConcurrencyConfig,
} from "./concurrency/readConcurrencyConfig";
// Per-step timeout (Tier 2 quick-wins)
import { StepTimeoutError, isStepTimeoutError } from "./timeouts/StepTimeoutError";

// Cooperative cancellation (Tier 2 follow-up)
import { RunCancelledError, isRunCancelledError } from "./RunCancelledError";

// Durable-scheduler payload size cap (PR 2 A4)
import { PayloadTooLargeError, isPayloadTooLargeError } from "./PayloadTooLargeError";

// Wait step primitive (PR 4)
import { WaitDispatchRequest, isWaitDispatchRequest } from "./WaitDispatchRequest";

// Concurrency / scheduling OTel metrics (Tier 2 follow-up)
import { ConcurrencyMetrics } from "./monitoring/ConcurrencyMetrics";
// Janitor sweep OTel metrics (PR 3 D3)
import { JanitorMetrics } from "./monitoring/JanitorMetrics";

// Scheduling — delay / TTL / debounce (Tier 2 #5 + #7) + cross-process debounce (Tier C #1)
import { DebounceCoordinator } from "./scheduling/DebounceCoordinator";
import {
	type DeferredDispatchInfo,
	DeferredDispatchSignal,
	isDeferredDispatchSignal,
} from "./scheduling/DeferredDispatchSignal";
import {
	DeferredRunScheduler,
	type DeferredScheduleOptions,
	getSchedulerClaimLeaseMs,
} from "./scheduling/DeferredRunScheduler";

import {
	type NormalizedDebounceConfig,
	type NormalizedSchedulingConfig,
	SCHEDULING_DEFAULTS,
	readSchedulingConfig,
} from "./scheduling/readSchedulingConfig";

// Cost Estimation
import { CostEstimator } from "./cost/CostEstimator";
import { DEFAULT_DURATIONS, DEFAULT_MEMORY, PRICING, getRuntimeCategory } from "./cost/pricing";

// Integrations

// Cache

// Testing Framework
import { NodeTestHarness } from "./testing/TestHarness";
import { TestLogger } from "./testing/TestLogger";
import { WorkflowTestRunner } from "./testing/WorkflowTestRunner";

// types

import BlokService from "./Blok";
import BlokResponse, { type IBlokResponse } from "./BlokResponse";
import NodeMap from "./NodeMap";
import RunnerSteps from "./RunnerSteps";
import { discoverNodes } from "./discoverNodes";
// These `types/*` modules are `type X = {...}; export default X;` — a type
// alias, not a runtime value. Bun's per-file source loader (used by `bun -e
// import(...)`, in-monorepo scripts, and bundler source-aliasing) can't see
// into the target file to know that, unlike a full bundler or tsc; a plain
// value `import`/`export` of these names round-trips through a synthesized
// re-export that Bun rejects with "export default cannot be used with
// export *". `import type` here (and `type` on the corresponding `export {
// }` entries below) makes the type-only-ness explicit so no runtime binding
// is ever synthesized. See #702.
import type Average from "./types/Average";
import type Condition from "./types/Condition";
import type Conditions from "./types/Conditions";
import type Config from "./types/Config";
import type Flow from "./types/Flow";
import type GlobalOptions from "./types/GlobalOptions";
import type Inputs from "./types/Inputs";
import type JsonLikeObject from "./types/JsonLikeObject";
import type Node from "./types/Node";
import type ParamsDictionary from "./types/ParamsDictionary";
import type Properties from "./types/Properties";
import type Targets from "./types/Targets";
import type Trigger from "./types/Trigger";
import type TriggerHttp from "./types/TriggerHttp";
import type TriggerResponse from "./types/TriggerResponse";
import type Triggers from "./types/Triggers";

export {
	Configuration,
	Runner,
	ConfigurationResolver,
	DefaultLogger,
	LocalStorage,
	ManualTrigger,
	DebugController,
	ResolverBase,
	TriggerBase,
	// Runtime adapters
	RuntimeRegistry,
	RuntimeAdapterNode,
	browserArtifactFilePath,
	saveBrowserScreenshot,
	registerContextCleanup,
	runContextCleanups,
	registerShutdownCleanup,
	runShutdownCleanups,
	NodeJsRuntimeAdapter,
	DockerRuntimeAdapter,
	BunRuntimeAdapter,
	WasmRuntimeAdapter,
	// gRPC runtime adapter
	GrpcRuntimeAdapter,
	GrpcClientPool,
	buildCredentials,
	buildChannelOptions,
	getNodeRuntimeService,
	encodeExecuteRequest,
	decodeExecuteResponse,
	jsonToBuffer,
	bufferToJson,
	GRPC_STATUS_MAP,
	GRPC_DEFAULTS,
	DEFAULT_GRPC_PORTS,
	DEFAULT_HEALTH_SERVICE_CONFIG,
	categoryToGrpcStatus,
	isServiceError,
	grpcToBlokError,
	assertGrpcOnlyTransport,
	// Function-first API
	defineNode,
	discoverNodes,
	FunctionNode,
	// Handle-DSL authoring runtime (#421)
	step,
	subworkflow,
	makeHandle,
	// Read-only escape hatch to a dynamically-published state key (#333)
	state,
	tpl,
	workflowCallback,
	// branch + typed comparators (#418, ADR 0003/0004)
	branch,
	condEq as eq,
	condNe as ne,
	condGt as gt,
	condGte as gte,
	condLt as lt,
	condLte as lte,
	condNot as not,
	// forEach over handles (#329 / #343)
	callbackForEach as forEach,
	// switchOn over handles (#319)
	callbackSwitchOn as switchOn,
	// tryCatch over handles (#317)
	callbackTryCatch as tryCatch,
	// Monitoring
	HealthCheck,
	RateLimiter,
	CircuitBreaker,
	CircuitOpenError,
	TriggerMetricsCollector,
	PrometheusMetricsBridge,
	bootstrapPrometheus,
	resetPrometheusBootstrap,
	bootstrapTracing,
	resetTracingBootstrap,
	type TracingBootstrapConfig,
	type TracingBootstrapResult,
	// Marketplace
	// HMR
	FileWatcher,
	HotReloadManager,
	HmrDevConsole,
	// Security
	// OAuth 2.0 / OIDC
	// Secret Management
	// OpenAPI
	// GraphQL
	// Visualization
	WorkflowVisualizer,
	NodeDependencyGraph,
	// Performance Profiling
	PerformanceProfiler,
	// Tracing (Blok Studio)
	RunTracker,
	Janitor,
	RoutingDiagnostics,
	type RoutingDiagnostic,
	registerTraceRoutes,
	WorkflowRegistry,
	type RegisteredWorkflow,
	type WorkflowAuthorizeFn,
	// Nearest-miss "did you mean…?" helper (#693)
	nearestMatches,
	levenshteinDistance,
	type MatchCandidate,
	type RankedMatch,
	// Concurrency gate (Tier 2 #6)
	ConcurrencyLimitError,
	type ConcurrencyLimitInfo,
	isConcurrencyLimitError,
	// Queue-mode TTL expiry (PR 1-5 polish)
	QueueExpiredError,
	type QueueExpiredInfo,
	isQueueExpiredError,
	// Resolved-key guard (#706)
	UnresolvableKeyExpressionError,
	assertResolvableKey,
	readConcurrencyConfig,
	type NormalizedConcurrencyConfig,
	CONCURRENCY_DEFAULTS,
	// Per-step timeout (Tier 2 quick-wins)
	StepTimeoutError,
	isStepTimeoutError,
	// Cooperative cancellation (Tier 2 follow-up)
	RunCancelledError,
	isRunCancelledError,
	// Durable-scheduler payload size cap (PR 2 A4)
	PayloadTooLargeError,
	isPayloadTooLargeError,
	// Wait step primitive (PR 4)
	WaitDispatchRequest,
	isWaitDispatchRequest,
	// Concurrency / scheduling OTel metrics (Tier 2 follow-up)
	ConcurrencyMetrics,
	// Janitor sweep OTel metrics (PR 3 D3)
	JanitorMetrics,
	// Scheduling — delay / TTL / debounce (Tier 2 #5 + #7)
	DeferredDispatchSignal,
	type DeferredDispatchInfo,
	isDeferredDispatchSignal,
	DeferredRunScheduler,
	type DeferredScheduleOptions,
	getSchedulerClaimLeaseMs,
	DebounceCoordinator,
	readSchedulingConfig,
	type NormalizedDebounceConfig,
	type NormalizedSchedulingConfig,
	SCHEDULING_DEFAULTS,
	TracingLogger,
	traceSanitize,
	traceRedactSensitive,
	// Cost Estimation
	CostEstimator,
	PRICING,
	DEFAULT_DURATIONS,
	DEFAULT_MEMORY,
	getRuntimeCategory,
	// Integrations
	// Cache
	// Testing
	NodeTestHarness,
	WorkflowTestRunner,
	TestLogger,
	// Types
	type Condition,
	type Conditions,
	type Config,
	type Flow,
	type Inputs,
	type Node,
	type Properties,
	type Targets,
	type Trigger,
	type TriggerHttp,
	type Triggers,
	type ParamsDictionary,
	type GlobalOptions,
	NodeMap,
	type JsonLikeObject,
	BlokService,
	BlokResponse,
	type IBlokResponse,
	RunnerSteps,
	type Average,
	type TriggerResponse,
};

// Export types
export type { RuntimeAdapter, RuntimeKind, ExecutionResult, FnNodeDefinition };
export type { BrowserArtifact } from "./tracing/types";
export type { BrowserScreenshotArtifact };

// Typed-handle type foundation (ADR 0006 / 0007). TYPES ONLY — `step()` (#421)
// and the `{$ref}` recorder ship the runtime that consumes these.
export type {
	Handle,
	EphemeralHandle,
	SpreadHandle,
	ErrorHandle,
	Refable,
	NodeTypeWitness,
	InputOf,
	OutputOf,
	RuntimeNode,
} from "./handles";
// `runtimeNode` is a REAL value (#424) — `step()` lowers it to a runtime step.
export { runtimeNode } from "./handles";
export type {
	StepOptions,
	TriggerHandle,
	// Per-trigger entry handles (#336)
	HttpEntry,
	WebhookEntry,
	CronEntry,
	WorkerEntry,
	PubSubEntry,
	GrpcEntry,
	SseEntry,
	WsEntry,
	McpEntry,
	ManualEntry,
	BranchCondition,
	BranchArms,
	ForEachOptions,
	SwitchArms,
	SwitchCaseArm,
	TryCatchArms,
} from "./stepBuilder";

// Security review FW-1 · trace API authorize hook signature
export type { TraceAuthorizeFn, TraceRouterOptions } from "./tracing/TraceRouter";

// gRPC adapter types
export type {
	GrpcAdapterConfig,
	KeepaliveConfig,
	TlsConfig,
	Transport,
} from "./adapters/grpc/types";
export type {
	DecodedExecuteResponse,
	DecodedLogLine,
	DecodedMetrics,
	DecodedNodeError,
	ExecuteRequestProto,
	ExecuteResponseProto,
	LogLineProto,
	MetricsProto,
	NodeErrorProto,
	NodeRefProto,
	RuntimeStateProto,
	StepInfoProto,
	TriggerInfoProto,
	WorkflowInfoProto,
	ExecuteOptionsProto,
} from "./adapters/grpc/GrpcCodec";
export type { GrpcErrorContext } from "./adapters/grpc/GrpcErrors";
export type {
	HealthStatus,
	HealthCheckResult,
	DependencyHealth,
	DependencyCheckFn,
} from "./monitoring/HealthCheck";
export type { RateLimitConfig, RateLimitResult } from "./monitoring/RateLimiter";
export type {
	CircuitState,
	CircuitBreakerConfig,
	CircuitBreakerStats,
	CircuitBreakerEvent,
	CircuitBreakerEventType,
	CircuitBreakerListener,
} from "./monitoring/CircuitBreaker";
export type {
	TriggerMetrics,
	LatencyStats,
	ErrorStats,
	ThroughputStats,
} from "./monitoring/TriggerMetricsCollector";
export type {
	PrometheusMetricsBridgeConfig,
	ExecutionLabels,
} from "./monitoring/PrometheusMetricsBridge";
export type {
	PrometheusBootstrapConfig,
	PrometheusBootstrapResult,
} from "./monitoring/PrometheusBootstrap";

// HMR — the dev-loop contract. `classifyChange` is the single source of truth
// for hot-vs-restart and is consumed by both the in-process watcher and
// `blokctl dev`'s restart watcher.
export { classifyChange } from "./hmr/classifyChange";
export type { ChangeAction, ChangeClassification, ClassifyRoots } from "./hmr/classifyChange";
export { loadDotenvFiles, parseDotenv, resetDotenvLoader } from "./utils/loadDotenv";

// HMR types
export type {
	FileWatcherConfig,
	HMREvent,
	HMREventType,
} from "./hmr/FileWatcher";
export type {
	HotReloadManagerConfig,
	HotReloadStats,
	ReloadHandler,
} from "./hmr/HotReloadManager";

// Security types

// OAuth 2.0 / OIDC types

// Secret Management types

// OpenAPI types

// GraphQL types

// Visualization types
export type {
	VisualizerConfig,
	WorkflowDef as VisualizerWorkflowDef,
	StepDef as VisualizerStepDef,
	ConditionDef as VisualizerConditionDef,
	WorkflowSummary,
} from "./visualization/WorkflowVisualizer";

// Node Dependency Graph types
export type {
	StepRef,
	DependencyNode,
	DependencyEdge,
	DependencyGraphConfig,
	DependencyStats,
} from "./visualization/NodeDependencyGraph";

// Performance Profiler types
export type {
	NodeProfile,
	WorkflowProfile,
	ProfileConfig,
} from "./monitoring/PerformanceProfiler";

// Cost Estimation types
export type {
	NodeCostEstimate,
	WorkflowCostEstimate,
	CostEstimatorConfig,
} from "./cost/CostEstimator";
export type {
	CloudProvider,
	RuntimeCostCategory,
	RuntimeCostModel,
} from "./cost/pricing";

// Integration types

// Cache types

// Testing types
export type { LogEntry } from "./testing/TestLogger";
export type { TestContextOverrides, TestResult, TestMetrics } from "./testing/TestHarness";
export type {
	WorkflowTestConfig,
	WorkflowTestResult,
	ExecutionTrace,
	WorkflowExecuteOptions,
} from "./testing/WorkflowTestRunner";
export type { DebugAction, DebugControlResult, DebugSessionHandle } from "./debug/DebugController";

// Tracing types (Blok Studio)
export type {
	WorkflowRun,
	WorkflowRunStatus,
	NodeRun,
	NodeRunStatus,
	RunEvent,
	RunEventType,
	BrowserRunEventType,
	TraceLogEntry,
	WorkflowSummary as TraceWorkflowSummary,
	WorkflowDetail as TraceWorkflowDetail,
	PaginatedResult,
	StartRunOptions,
	StartNodeOptions,
	ScheduledDispatchRow,
} from "./tracing/types";
export type { JanitorStats } from "./tracing/Janitor";

// Tracing store factory + concrete stores — exposed so the CLI's
// standalone `blokctl studio` mode can spin up its own SQLite-backed
// tracker without proxying to a live trigger. See
// `packages/cli/src/commands/trace/startStudio.ts` for the call site.
export { createStore, InMemoryRunStore, SqliteRunStore } from "./tracing";
// Error sink (MO-ALERTS) — generic process-wide error forwarding + the Sentry adapter.
export { type ErrorSink, captureError, getErrorSink, setErrorSink } from "./observability/ErrorSink";
export { createSentryErrorSink } from "./observability/SentryIntegration";
export type { CreateStoreOptions, StoreType } from "./tracing";
