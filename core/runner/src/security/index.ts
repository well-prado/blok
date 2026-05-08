/**
 * Security Module for Blok Framework
 *
 * Provides authentication, authorization, audit logging, and secret management:
 * - AuthMiddleware: **Deprecated as of v0.4.1; removed in v0.5.** Use
 *   `jose`, `hono/jwt`, or `node-jsonwebtoken` at the workflow layer
 *   instead. See `docs/d/security/cookbook.mdx`.
 * - OAuthOIDCProvider: OAuth 2.0 / OIDC authentication with JWKS verification
 * - RBAC: Role-based access control with hierarchical roles
 * - ABAC: Attribute-based access control with policy engine
 * - AuditLogger: Comprehensive audit trail with multiple sinks
 * - SecretManager: Unified secret management across multiple providers
 * - EncryptionAtRest: AES-256-GCM encryption/decryption with key rotation
 * - PIIDetector: PII detection and masking for text and structured data
 * - TLSConfig: TLS/SSL configuration with mTLS and certificate management
 *
 * @example
 * ```typescript
 * import {
 *   AuthMiddleware,
 *   JWTAuthProvider,
 *   APIKeyAuthProvider,
 *   OAuthOIDCProvider,
 *   RBAC,
 *   createDefaultRBAC,
 *   AuditLogger,
 *   ConsoleAuditSink,
 *   FileAuditSink,
 *   SecretManager,
 *   EnvironmentSecretProvider,
 * } from "@blokjs/runner";
 *
 * // Set up auth
 * const auth = new AuthMiddleware({
 *   providers: [
 *     new OAuthOIDCProvider({
 *       issuerUrl: "https://auth.example.com",
 *       clientId: "my-app",
 *     }),
 *     new JWTAuthProvider({ secret: process.env.JWT_SECRET! }),
 *     new APIKeyAuthProvider({
 *       keys: new Map([["my-key", { name: "svc", roles: ["service"] }]]),
 *     }),
 *   ],
 * });
 *
 * // Set up RBAC
 * const rbac = createDefaultRBAC();
 *
 * // Set up audit logging
 * const audit = new AuditLogger({
 *   sinks: [new ConsoleAuditSink(), new FileAuditSink({ path: "./audit.log" })],
 * });
 *
 * // Set up secret management
 * const secrets = new SecretManager({
 *   providers: [
 *     { type: "environment", config: { prefix: "BLOK_SECRET_" } },
 *   ],
 *   cache: { enabled: true, ttlMs: 60_000, maxSize: 100 },
 * });
 * ```
 */

// Authentication
export {
	AuthMiddleware,
	JWTAuthProvider,
	APIKeyAuthProvider,
} from "./AuthMiddleware";
export type {
	AuthMiddlewareConfig,
	AuthProvider,
	AuthIdentity,
	AuthRequest,
	AuthResult,
	JWTAuthProviderConfig,
	APIKeyAuthProviderConfig,
	APIKeyInfo,
} from "./AuthMiddleware";

// Authorization (RBAC)
export { RBAC, createDefaultRBAC } from "./RBAC";
export type {
	Action,
	Permission,
	RoleDefinition,
	AccessCheckResult,
	RBACPolicy,
} from "./RBAC";

// Authorization (ABAC)
export { ABACEngine, createDefaultABAC } from "./ABAC";
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
} from "./ABAC";

// OAuth 2.0 / OIDC
export { OAuthOIDCProvider, TokenCache } from "./OAuthProvider";
export type {
	OAuthOIDCConfig,
	OIDCDiscoveryDocument,
	JWK,
	JWKS,
	TokenCacheStats,
} from "./OAuthProvider";

// Audit Logging
export {
	AuditLogger,
	ConsoleAuditSink,
	FileAuditSink,
	InMemoryAuditSink,
} from "./AuditLogger";
export type {
	AuditEntry,
	AuditCategory,
	AuditSeverity,
	AuditSink,
	AuditLoggerConfig,
} from "./AuditLogger";

// Secret Management
export {
	SecretManager,
	EnvironmentSecretProvider,
	InMemorySecretProvider,
	VaultSecretProvider,
	AWSSecretsProvider,
	GCPSecretProvider,
} from "./SecretManager";
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
} from "./SecretManager";

// Encryption at Rest
export { EncryptionAtRest } from "./EncryptionAtRest";
export type {
	EncryptedPayload,
	EncryptionConfig,
	KeyDerivationConfig,
} from "./EncryptionAtRest";

// PII Detection
export { PIIDetector, PIIType } from "./PIIDetector";
export type {
	PIIPattern,
	PIIMatch,
	PIIScanResult,
	PIIDetectorConfig,
} from "./PIIDetector";

// TLS Configuration
export { TLSConfig } from "./TLSConfig";
export type {
	TLSConfigOptions,
	TLSValidationResult,
	CertificateInfo,
	SelfSignedOptions,
	MutualTLSOptions,
} from "./TLSConfig";
