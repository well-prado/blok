import Configuration from "./Configuration";
import ConfigurationResolver from "./ConfigurationResolver";
import DefaultLogger from "./DefaultLogger";
import LocalStorage from "./LocalStorage";
import ResolverBase from "./ResolverBase";
import Runner from "./Runner";
import TriggerBase from "./TriggerBase";

// Runtime adapters
import { RuntimeRegistry } from "./RuntimeRegistry";
import { RuntimeAdapterNode } from "./RuntimeAdapterNode";
import type { RuntimeAdapter, RuntimeKind, ExecutionResult } from "./adapters/RuntimeAdapter";
import { NodeJsRuntimeAdapter } from "./adapters/NodeJsRuntimeAdapter";
import { Python3RuntimeAdapter } from "./adapters/Python3RuntimeAdapter";
import { DockerRuntimeAdapter } from "./adapters/DockerRuntimeAdapter";
import { BunRuntimeAdapter } from "./adapters/BunRuntimeAdapter";
import { WasmRuntimeAdapter } from "./adapters/WasmRuntimeAdapter";

// Function-first node API
import { defineNode, FunctionNode, type FnNodeDefinition } from "./defineNode";

// Monitoring infrastructure
import { HealthCheck } from "./monitoring/HealthCheck";
import { RateLimiter } from "./monitoring/RateLimiter";
import { CircuitBreaker, CircuitOpenError } from "./monitoring/CircuitBreaker";
import { TriggerMetricsCollector } from "./monitoring/TriggerMetricsCollector";

// Marketplace infrastructure
import { RuntimeCatalog } from "./marketplace/RuntimeCatalog";
import { RuntimeDiscovery } from "./marketplace/RuntimeDiscovery";
import { RuntimeHealthMonitor } from "./marketplace/RuntimeHealthMonitor";
import { RuntimeMetricsDashboard } from "./marketplace/RuntimeMetricsDashboard";
import { RuntimeAutoScaler } from "./marketplace/RuntimeAutoScaler";

// Hot Module Replacement (HMR)
import { FileWatcher } from "./hmr/FileWatcher";
import { HotReloadManager } from "./hmr/HotReloadManager";
import { HmrDevConsole } from "./hmr/HmrDevConsole";

// Security
import { AuthMiddleware, JWTAuthProvider, APIKeyAuthProvider } from "./security/AuthMiddleware";
import { RBAC, createDefaultRBAC } from "./security/RBAC";
import { AuditLogger, ConsoleAuditSink, FileAuditSink, InMemoryAuditSink } from "./security/AuditLogger";
import { OAuthOIDCProvider, TokenCache } from "./security/OAuthProvider";
import { SecretManager, EnvironmentSecretProvider, InMemorySecretProvider, VaultSecretProvider, AWSSecretsProvider, GCPSecretProvider } from "./security/SecretManager";

// OpenAPI
import { OpenAPIGenerator } from "./openapi/OpenAPIGenerator";

// GraphQL
import { GraphQLSchemaGenerator } from "./graphql/GraphQLSchemaGenerator";

// Visualization
import { WorkflowVisualizer } from "./visualization/WorkflowVisualizer";

// Integrations
import { SentryIntegration } from "./integrations/SentryIntegration";

// Cache
import { InMemoryCache, NodeResultCache } from "./cache/NodeResultCache";

// Testing Framework
import { NodeTestHarness } from "./testing/TestHarness";
import { WorkflowTestRunner } from "./testing/WorkflowTestRunner";
import { TestLogger } from "./testing/TestLogger";

// types

import NanoService from "./NanoService";
import NanoServiceResponse, { INanoServiceResponse } from "./NanoServiceResponse";
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
	Python3RuntimeAdapter,
	DockerRuntimeAdapter,
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
	NanoService,
	NanoServiceResponse,
	INanoServiceResponse,
	RunnerSteps,
	Average,
	TriggerResponse,
};

// Export types
export type { RuntimeAdapter, RuntimeKind, ExecutionResult, FnNodeDefinition };
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
