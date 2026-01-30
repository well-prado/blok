import Configuration from "./Configuration";
import ConfigurationResolver from "./ConfigurationResolver";
import DefaultLogger from "./DefaultLogger";
import LocalStorage from "./LocalStorage";
import ResolverBase from "./ResolverBase";
import Runner from "./Runner";
import TriggerBase from "./TriggerBase";

import { RuntimeAdapterNode } from "./RuntimeAdapterNode";
// Runtime adapters
import { RuntimeRegistry } from "./RuntimeRegistry";
import { BunRuntimeAdapter } from "./adapters/BunRuntimeAdapter";
import { DockerRuntimeAdapter } from "./adapters/DockerRuntimeAdapter";
import { HttpRuntimeAdapter } from "./adapters/HttpRuntimeAdapter";
import { NodeJsRuntimeAdapter } from "./adapters/NodeJsRuntimeAdapter";
import type { ExecutionResult, RuntimeAdapter, RuntimeKind } from "./adapters/RuntimeAdapter";
import { WasmRuntimeAdapter } from "./adapters/WasmRuntimeAdapter";

// Function-first node API
import { type FnNodeDefinition, FunctionNode, defineNode } from "./defineNode";

import { CircuitBreaker, CircuitOpenError } from "./monitoring/CircuitBreaker";
// Monitoring infrastructure
import { HealthCheck } from "./monitoring/HealthCheck";
import { bootstrapPrometheus, resetPrometheusBootstrap } from "./monitoring/PrometheusBootstrap";
import { PrometheusMetricsBridge } from "./monitoring/PrometheusMetricsBridge";
import { RateLimiter } from "./monitoring/RateLimiter";
import { TriggerMetricsCollector } from "./monitoring/TriggerMetricsCollector";

import { RuntimeAutoScaler } from "./marketplace/RuntimeAutoScaler";
// Marketplace infrastructure
import { RuntimeCatalog } from "./marketplace/RuntimeCatalog";
import { RuntimeDiscovery } from "./marketplace/RuntimeDiscovery";
import { RuntimeHealthMonitor } from "./marketplace/RuntimeHealthMonitor";
import { RuntimeMetricsDashboard } from "./marketplace/RuntimeMetricsDashboard";

// Hot Module Replacement (HMR)
import { FileWatcher } from "./hmr/FileWatcher";
import { HmrDevConsole } from "./hmr/HmrDevConsole";
import { HotReloadManager } from "./hmr/HotReloadManager";

import { ABACEngine, createDefaultABAC } from "./security/ABAC";
import { AuditLogger, ConsoleAuditSink, FileAuditSink, InMemoryAuditSink } from "./security/AuditLogger";
// Security
import { APIKeyAuthProvider, AuthMiddleware, JWTAuthProvider } from "./security/AuthMiddleware";
import { OAuthOIDCProvider, TokenCache } from "./security/OAuthProvider";
import { RBAC, createDefaultRBAC } from "./security/RBAC";
import {
	AWSSecretsProvider,
	EnvironmentSecretProvider,
	GCPSecretProvider,
	InMemorySecretProvider,
	SecretManager,
	VaultSecretProvider,
} from "./security/SecretManager";

// OpenAPI
import { OpenAPIGenerator } from "./openapi/OpenAPIGenerator";

// GraphQL
import { GraphQLSchemaGenerator } from "./graphql/GraphQLSchemaGenerator";

import { NodeDependencyGraph } from "./visualization/NodeDependencyGraph";
// Visualization
import { WorkflowVisualizer } from "./visualization/WorkflowVisualizer";

// Performance Profiling
import { PerformanceProfiler } from "./monitoring/PerformanceProfiler";

// Tracing (Blok Studio)
import { RunTracker } from "./tracing/RunTracker";
import { registerTraceRoutes } from "./tracing/TraceRouter";
import { TracingLogger } from "./tracing/TracingLogger";
import { sanitize as traceSanitize } from "./tracing/sanitize";

// Cost Estimation
import { CostEstimator } from "./cost/CostEstimator";
import { DEFAULT_DURATIONS, DEFAULT_MEMORY, PRICING, getRuntimeCategory } from "./cost/pricing";

// Integrations
import { SentryIntegration } from "./integrations/SentryIntegration";

// Cache
import { InMemoryCache, NodeResultCache } from "./cache/NodeResultCache";

// Testing Framework
import { NodeTestHarness } from "./testing/TestHarness";
import { TestLogger } from "./testing/TestLogger";
import { WorkflowTestRunner } from "./testing/WorkflowTestRunner";

// types

import BlokService from "./Blok";
import BlokResponse, { IBlokResponse } from "./BlokResponse";
import NodeMap from "./NodeMap";
import RunnerSteps from "./RunnerSteps";
import Average from "./types/Average";
import Condition from "./types/Condition";
import Conditions from "./types/Conditions";
import Config from "./types/Config";
import Flow from "./types/Flow";
import GlobalOptions from "./types/GlobalOptions";
import Inputs from "./types/Inputs";
import JsonLikeObject from "./types/JsonLikeObject";
import Node from "./types/Node";
import ParamsDictionary from "./types/ParamsDictionary";
import Properties from "./types/Properties";
import Targets from "./types/Targets";
import Trigger from "./types/Trigger";
import TriggerHttp from "./types/TriggerHttp";
import TriggerResponse from "./types/TriggerResponse";
import Triggers from "./types/Triggers";

export {
	Configuration,
	Runner,
	ConfigurationResolver,
	DefaultLogger,
	LocalStorage,
	ResolverBase,
	TriggerBase,
	// Runtime adapters
	RuntimeRegistry,
	RuntimeAdapterNode,
	NodeJsRuntimeAdapter,
	DockerRuntimeAdapter,
	HttpRuntimeAdapter,
	BunRuntimeAdapter,
	WasmRuntimeAdapter,
	// Function-first API
	defineNode,
	FunctionNode,
	// Monitoring
	HealthCheck,
	RateLimiter,
	CircuitBreaker,
	CircuitOpenError,
	TriggerMetricsCollector,
	PrometheusMetricsBridge,
	bootstrapPrometheus,
	resetPrometheusBootstrap,
	// Marketplace
	RuntimeCatalog,
	RuntimeDiscovery,
	RuntimeHealthMonitor,
	RuntimeMetricsDashboard,
	RuntimeAutoScaler,
	// HMR
	FileWatcher,
	HotReloadManager,
	HmrDevConsole,
	// Security
	AuthMiddleware,
	JWTAuthProvider,
	APIKeyAuthProvider,
	RBAC,
	createDefaultRBAC,
	ABACEngine,
	createDefaultABAC,
	AuditLogger,
	ConsoleAuditSink,
	FileAuditSink,
	InMemoryAuditSink,
	// OAuth 2.0 / OIDC
	OAuthOIDCProvider,
	TokenCache,
	// Secret Management
	SecretManager,
	EnvironmentSecretProvider,
	InMemorySecretProvider,
	VaultSecretProvider,
	AWSSecretsProvider,
	GCPSecretProvider,
	// OpenAPI
	OpenAPIGenerator,
	// GraphQL
	GraphQLSchemaGenerator,
	// Visualization
	WorkflowVisualizer,
	NodeDependencyGraph,
	// Performance Profiling
	PerformanceProfiler,
	// Tracing (Blok Studio)
	RunTracker,
	registerTraceRoutes,
	TracingLogger,
	traceSanitize,
	// Cost Estimation
	CostEstimator,
	PRICING,
	DEFAULT_DURATIONS,
	DEFAULT_MEMORY,
	getRuntimeCategory,
	// Integrations
	SentryIntegration,
	// Cache
	InMemoryCache,
	NodeResultCache,
	// Testing
	NodeTestHarness,
	WorkflowTestRunner,
	TestLogger,
	// Types
	Condition,
	Conditions,
	Config,
	Flow,
	Inputs,
	Node,
	Properties,
	Targets,
	Trigger,
	TriggerHttp,
	Triggers,
	ParamsDictionary,
	GlobalOptions,
	NodeMap,
	JsonLikeObject,
	BlokService,
	BlokResponse,
	IBlokResponse,
	RunnerSteps,
	Average,
	TriggerResponse,
};

// Export types
export type { RuntimeAdapter, RuntimeKind, ExecutionResult, FnNodeDefinition };
export type { HttpRuntimeAdapterOptions } from "./adapters/HttpRuntimeAdapter";
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
export type {
	RuntimePackageManifest,
	RuntimeNodeInfo,
	CatalogSearchOptions,
	CatalogSearchResult,
	CatalogStats,
} from "./marketplace/RuntimeCatalog";
export type {
	CompatibilityInfo,
	DiscoveryResult,
	ResolveOptions,
} from "./marketplace/RuntimeDiscovery";
export type {
	RuntimeHealthStatus,
	HealthMonitorConfig,
	HealthCheckRecord,
	HealthChangeListener,
} from "./marketplace/RuntimeHealthMonitor";
export type {
	RuntimeExecutionMetrics,
	LatencyPercentiles,
	ThroughputMetrics,
	ResourceMetrics,
	DashboardSnapshot,
	AggregateMetrics,
} from "./marketplace/RuntimeMetricsDashboard";
export type {
	ScalingPolicy,
	ScalingDecision,
	ScalingMetrics,
	ScalingHistory,
	AutoScalerConfig,
	ScalingListener,
} from "./marketplace/RuntimeAutoScaler";

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
export type {
	AuthMiddlewareConfig,
	AuthProvider,
	AuthIdentity,
	AuthRequest,
	AuthResult,
	JWTAuthProviderConfig,
	APIKeyAuthProviderConfig,
	APIKeyInfo,
} from "./security/AuthMiddleware";
export type {
	Action,
	Permission,
	RoleDefinition,
	AccessCheckResult,
	RBACPolicy,
} from "./security/RBAC";
export type {
	ABACOperator,
	ABACEffect,
	ABACCondition,
	ABACConditionGroup,
	ABACPolicyTarget,
	ABACPolicy,
	SubjectAttributes,
	ResourceAttributes,
	EnvironmentAttributes,
	ABACRequest,
	ABACResult,
} from "./security/ABAC";
export type {
	AuditEntry,
	AuditCategory,
	AuditSeverity,
	AuditSink,
	AuditLoggerConfig,
} from "./security/AuditLogger";

// OAuth 2.0 / OIDC types
export type {
	OAuthOIDCConfig,
	OIDCDiscoveryDocument,
	JWK,
	JWKS,
	TokenCacheStats,
} from "./security/OAuthProvider";

// Secret Management types
export type {
	SecretProvider,
	SecretMetadata,
	SecretAccessEvent,
	SecretManagerConfig,
	SecretCacheConfig,
	SecretProviderConfig,
	EnvironmentProviderConfig,
	InMemoryProviderConfig,
	VaultProviderConfig,
	AWSSecretsProviderConfig,
	GCPSecretProviderConfig,
} from "./security/SecretManager";

// OpenAPI types
export type {
	OpenAPIGeneratorConfig,
	OpenAPISecurityScheme,
	WorkflowDefinition,
	OpenAPISpec,
} from "./openapi/OpenAPIGenerator";

// GraphQL types
export type {
	GraphQLGeneratorConfig,
	GqlWorkflowDefinition,
	GqlFieldDef,
	GraphQLSchemaJSON,
	GraphQLTypeInfo,
	GraphQLFieldInfo,
} from "./graphql/GraphQLSchemaGenerator";

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
export type {
	SentryConfig,
	WorkflowErrorContext,
	SentryClient,
	SentryTransaction,
	SentrySpan,
} from "./integrations/SentryIntegration";

// Cache types
export type {
	CacheProvider,
	CacheEntry,
	CacheSetOptions,
	CacheStats,
	InMemoryCacheConfig,
	CacheKeyStrategy,
	CustomKeyFn,
	CacheResult,
	NodeResultCacheConfig,
} from "./cache/NodeResultCache";

// Testing types
export type { LogEntry } from "./testing/TestLogger";
export type { TestContextOverrides, TestResult, TestMetrics } from "./testing/TestHarness";
export type {
	WorkflowTestConfig,
	WorkflowTestResult,
	ExecutionTrace,
	WorkflowExecuteOptions,
} from "./testing/WorkflowTestRunner";

// Tracing types (Blok Studio)
export type {
	WorkflowRun,
	WorkflowRunStatus,
	NodeRun,
	NodeRunStatus,
	RunEvent,
	RunEventType,
	TraceLogEntry,
	WorkflowSummary as TraceWorkflowSummary,
	WorkflowDetail as TraceWorkflowDetail,
	PaginatedResult,
	StartRunOptions,
	StartNodeOptions,
} from "./tracing/types";
