/**
 * Security Module for Blok Framework
 *
 * Provides authentication, authorization, and audit logging:
 * - AuthMiddleware: Pluggable auth with JWT and API Key providers
 * - RBAC: Role-based access control with hierarchical roles
 * - AuditLogger: Comprehensive audit trail with multiple sinks
 *
 * @example
 * ```typescript
 * import {
 *   AuthMiddleware,
 *   JWTAuthProvider,
 *   APIKeyAuthProvider,
 *   RBAC,
 *   createDefaultRBAC,
 *   AuditLogger,
 *   ConsoleAuditSink,
 *   FileAuditSink,
 * } from "@nanoservice-ts/runner";
 *
 * // Set up auth
 * const auth = new AuthMiddleware({
 *   providers: [
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
