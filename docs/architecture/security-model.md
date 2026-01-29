---
title: "Security Model"
description: "Architecture documentation for authentication, authorization, secret management, and audit logging in Blok"
---

# Security Model

Blok provides a comprehensive security architecture covering authentication, authorization, secret management, encryption, PII detection, TLS configuration, and audit logging. All security components are located in `core/runner/src/security/` and are exported from `@nanoservice-ts/runner`.

## Architecture Overview

```
                    Incoming Request
                          |
                    TLS Termination
                    (mTLS optional)
                          |
                  AuthMiddleware Pipeline
                  +-------------------+
                  | 1. Path exclusion |
                  | 2. JWT verify     |
                  | 3. API Key check  |
                  | 4. OAuth/OIDC     |
                  +-------------------+
                          |
                    AuthIdentity
                    {sub, roles, claims}
                          |
                  RBAC Authorization
                  +-------------------+
                  | Role hierarchy    |
                  | Permission check  |
                  | Resource policies |
                  +-------------------+
                          |
                    Workflow Execution
                          |
                  Secret Resolution
                  +-------------------+
                  | Provider chain    |
                  | ${secret:KEY}     |
                  | Caching layer     |
                  +-------------------+
                          |
                    Audit Logger
                  (all events recorded)
```

## Authentication

### AuthMiddleware

The `AuthMiddleware` class orchestrates authentication by trying multiple providers in order until one succeeds:

```typescript
import {
  AuthMiddleware,
  JWTAuthProvider,
  APIKeyAuthProvider,
  OAuthOIDCProvider,
} from "@nanoservice-ts/runner";

const auth = new AuthMiddleware({
  providers: [
    new OAuthOIDCProvider({
      issuerUrl: "https://auth.example.com",
      clientId: "my-app",
      audience: "https://api.example.com",
    }),
    new JWTAuthProvider({
      secret: process.env.JWT_SECRET!,
      issuer: "blok",
      audience: "api",
      clockToleranceSec: 30,
    }),
    new APIKeyAuthProvider({
      keys: new Map([
        ["sk_live_abc123", { name: "service-a", roles: ["admin"] }],
        ["sk_test_xyz789", { name: "ci-runner", roles: ["service"] }],
      ]),
    }),
  ],
  excludePaths: ["/health-check", "/metrics", "/health", "/liveness", "/readiness"],
  required: true,
});
```

### AuthIdentity

Every successful authentication produces an `AuthIdentity`:

```typescript
interface AuthIdentity {
  sub: string;                        // Unique subject identifier
  name?: string;                      // Display name
  email?: string;                     // Email address
  roles: string[];                    // Assigned roles
  claims: Record<string, unknown>;    // All token claims
  provider: string;                   // Which provider verified this
  issuedAt?: number;                  // Token issued at (Unix seconds)
  expiresAt?: number;                 // Token expires at (Unix seconds)
}
```

### JWT Authentication

The `JWTAuthProvider` verifies JWT tokens from the `Authorization: Bearer` header using HS256 (HMAC-SHA256) with timing-safe comparison:

```typescript
const jwt = new JWTAuthProvider({
  secret: process.env.JWT_SECRET!,
  issuer: "my-issuer",         // Validate iss claim
  audience: "my-api",          // Validate aud claim
  headerName: "authorization", // Header to read (default)
  clockToleranceSec: 30,       // Clock skew tolerance
  rolesClaim: "roles",         // Claim containing user roles
});
```

Validation checks performed:
1. Bearer token extraction from header
2. HS256 signature verification (timing-safe)
3. Expiration (`exp`) with clock tolerance
4. Not-before (`nbf`) with clock tolerance
5. Issuer (`iss`) validation
6. Audience (`aud`) validation
7. Role extraction from configured claim

### API Key Authentication

The `APIKeyAuthProvider` validates API keys from headers or query parameters:

```typescript
const apiKey = new APIKeyAuthProvider({
  keys: new Map([
    ["sk_live_abc123", {
      name: "production-service",
      roles: ["admin", "service"],
      metadata: { team: "backend" },
      expiresAt: 1735689600,  // Unix timestamp
    }],
  ]),
  headerName: "x-api-key",     // Header name (default)
  queryParam: "api_key",       // Query parameter name (default)
  validate: async (key) => {   // Custom async validator (e.g., database lookup)
    return await db.apiKeys.findByKey(key);
  },
});
```

API keys are checked in order:
1. Header (`x-api-key` by default)
2. Query parameter (`api_key` by default)
3. Custom validator function (if provided)
4. Static key map

### OAuth 2.0 / OpenID Connect

The `OAuthOIDCProvider` provides full OIDC-compliant authentication:

```typescript
const oidc = new OAuthOIDCProvider({
  issuerUrl: "https://accounts.google.com",
  clientId: "my-client-id",
  clientSecret: "my-client-secret",    // Required for token introspection
  audience: "https://api.example.com",
  allowedAlgorithms: ["RS256", "ES256"],
  rolesClaim: "roles",
  scopesClaim: "scope",
  clockToleranceSec: 30,
  cacheJWKS: true,
  cacheDiscovery: true,
});
```

OIDC features:
- **Auto-discovery**: Fetches `/.well-known/openid-configuration` to resolve endpoints
- **JWKS verification**: RS256 (RSA) and ES256 (ECDSA) signature verification using Node.js `crypto`
- **Key rotation**: Automatically refreshes JWKS when a `kid` is not found in cache
- **Token introspection**: Falls back to RFC 7662 introspection for opaque tokens
- **Token caching**: LRU cache with TTL derived from token expiry (SHA-256 keyed)
- **Zero dependencies**: Uses only `node:crypto` and `node:buffer`

### Express Middleware Integration

The `AuthMiddleware` provides a drop-in Express middleware:

```typescript
import express from "express";

const app = express();
app.use(auth.expressMiddleware());

app.get("/api/users", (req, res) => {
  // req.auth contains the AuthIdentity
  console.log("Authenticated user:", req.auth.sub);
  console.log("Roles:", req.auth.roles);
});
```

## Authorization (RBAC)

The `RBAC` class provides Role-Based Access Control with hierarchical roles, wildcard permissions, and resource-pattern matching.

### Role Hierarchy

```
        admin
       (all: *)
          |
      developer
   (workflows: CRUD + execute)
   (nodes: CRUD + execute)
      inherits: viewer
          |
    +-----+-----+
    |             |
 operator      viewer
 (execute,     (read-only)
  monitor)
    |
 service
 (execute only)
```

### Defining Roles

```typescript
import { RBAC, createDefaultRBAC } from "@nanoservice-ts/runner";

// Use preconfigured roles
const rbac = createDefaultRBAC();

// Or define custom roles
const rbac = new RBAC();

rbac.addRole({
  name: "admin",
  description: "Full access to all resources",
  permissions: [
    { resource: "*", actions: ["*"] },
  ],
});

rbac.addRole({
  name: "developer",
  description: "Can manage and execute workflows",
  permissions: [
    { resource: "workflow", actions: ["read", "create", "update", "execute"] },
    { resource: "node", actions: ["read", "create", "update", "execute"] },
    { resource: "trigger", actions: ["read"] },
    { resource: "runtime", actions: ["read", "execute"] },
  ],
  inherits: ["viewer"],  // Inherits all viewer permissions
});

rbac.addRole({
  name: "viewer",
  description: "Read-only access",
  permissions: [
    { resource: "workflow", actions: ["read"] },
    { resource: "node", actions: ["read"] },
    { resource: "metrics", actions: ["read"] },
    { resource: "health", actions: ["read"] },
  ],
});
```

### Default Roles

The `createDefaultRBAC()` factory provides five roles out of the box:

| Role | Resources | Actions |
|---|---|---|
| `admin` | `*` | `*` (full access) |
| `developer` | workflow, node, trigger, runtime | read, create, update, execute |
| `operator` | workflow, node, trigger, runtime, metrics, health | read, execute |
| `viewer` | workflow, node, metrics, health | read |
| `service` | workflow, node | execute |

### Permission Checks

```typescript
// Single role check
const result = rbac.can("developer", "workflow", "execute");
// { allowed: true, role: "developer", resource: "workflow", action: "execute" }

// Multi-role check (any role)
const result = rbac.canAny(["viewer", "developer"], "workflow", "delete");
// { allowed: false, reason: "None of roles [...] have 'delete' permission on 'workflow'" }

// Workflow-specific check with resource ID
const result = rbac.canAccessWorkflow(
  identity.roles,
  "/api/admin/users",
  "execute"
);
```

### Resource Policies

Apply workflow-specific access policies:

```typescript
rbac.addPolicy("/api/admin/*", {
  workflows: {
    "/api/admin/*": {
      allowedRoles: ["admin"],
      actions: ["*"],
    },
  },
  defaultPolicy: "deny",
});
```

### Serialization

RBAC configurations can be exported and imported as JSON:

```typescript
// Export
const config = rbac.toJSON();
fs.writeFileSync("rbac.json", JSON.stringify(config, null, 2));

// Import
const config = JSON.parse(fs.readFileSync("rbac.json", "utf-8"));
rbac.fromJSON(config);
```

## Secret Management

The `SecretManager` provides a unified interface for retrieving secrets from multiple backends with a provider chain, caching, and audit events.

### Provider Chain

Secrets are resolved by querying providers in order -- the first provider that returns a value wins:

```typescript
import { SecretManager } from "@nanoservice-ts/runner";

const secrets = new SecretManager({
  providers: [
    // 1. Try HashiCorp Vault first
    {
      type: "vault",
      config: {
        address: "https://vault.internal:8200",
        token: process.env.VAULT_TOKEN,
        mountPath: "secret",
      },
    },
    // 2. Fall back to AWS Secrets Manager
    {
      type: "aws",
      config: {
        region: "us-east-1",
      },
    },
    // 3. Fall back to GCP Secret Manager
    {
      type: "gcp",
      config: {
        projectId: "my-project",
      },
    },
    // 4. Last resort: environment variables
    {
      type: "environment",
      config: {
        prefix: "BLOK_SECRET_",
      },
    },
  ],
  cache: {
    enabled: true,
    ttlMs: 300_000,  // 5 minutes
    maxSize: 500,    // LRU eviction
  },
  auditLog: true,
});
```

### Supported Providers

| Provider | Type Key | Backend | Auth Mechanism |
|---|---|---|---|
| `EnvironmentSecretProvider` | `environment` | `process.env` | N/A |
| `InMemorySecretProvider` | `memory` | In-memory Map | N/A (testing) |
| `VaultSecretProvider` | `vault` | HashiCorp Vault KV v2 | Token (`X-Vault-Token`) |
| `AWSSecretsProvider` | `aws` | AWS Secrets Manager | IAM / Access Keys |
| `GCPSecretProvider` | `gcp` | GCP Secret Manager | Service Account |

### Template Resolution

Resolve `${secret:KEY}` patterns in configuration strings:

```typescript
const connectionString = await secrets.resolveTemplate(
  "postgres://${secret:DB_USER}:${secret:DB_PASSWORD}@${secret:DB_HOST}:5432/app"
);
// All ${secret:...} placeholders are replaced with actual values
```

### Audit Events

When `auditLog: true`, every secret access emits a `secretAccess` event:

```typescript
secrets.on("secretAccess", (event) => {
  console.log(JSON.stringify(event));
  // {
  //   operation: "get",
  //   key: "DB_PASSWORD",
  //   provider: "vault",
  //   success: true,
  //   cached: false,
  //   timestamp: "2024-01-15T10:30:00.000Z"
  // }
});
```

## Encryption at Rest (AES-256-GCM)

Blok uses AES-256-GCM for encrypting sensitive data at rest:

```typescript
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Encryption
const key = randomBytes(32);      // 256-bit key
const iv = randomBytes(12);        // 96-bit IV (recommended for GCM)
const cipher = createCipheriv("aes-256-gcm", key, iv);

let encrypted = cipher.update(plaintext, "utf8", "base64");
encrypted += cipher.final("base64");
const authTag = cipher.getAuthTag();  // 128-bit authentication tag

// Decryption
const decipher = createDecipheriv("aes-256-gcm", key, iv);
decipher.setAuthTag(authTag);
let decrypted = decipher.update(encrypted, "base64", "utf8");
decrypted += decipher.final("utf8");
```

Key characteristics:
- **Algorithm**: AES-256-GCM (authenticated encryption)
- **Key size**: 256 bits (32 bytes)
- **IV size**: 96 bits (12 bytes) -- unique per encryption
- **Auth tag**: 128 bits -- ensures integrity and authenticity

## PII Detection and Masking

Blok includes PII detection patterns for log sanitization:

| Pattern | Description | Masking |
|---|---|---|
| Email addresses | `user@example.com` | `u***@example.com` |
| Credit card numbers | `4111-1111-1111-1111` | `****-****-****-1111` |
| Social Security Numbers | `123-45-6789` | `***-**-6789` |
| API keys | `sk_live_...` | `sk_live_****` |
| JWT tokens | `eyJhbGci...` | `[REDACTED_JWT]` |
| IP addresses | `192.168.1.1` | `192.168.*.* ` |

PII masking is applied automatically in structured logging and audit trail outputs when configured.

## TLS Configuration

Configure TLS for trigger endpoints:

```typescript
import { readFileSync } from "node:fs";

const trigger = new HttpTrigger({
  tls: {
    enabled: true,
    cert: readFileSync("/certs/server.crt"),
    key: readFileSync("/certs/server.key"),
    ca: readFileSync("/certs/ca.crt"),        // For mTLS
    requestCert: true,                         // Require client certificates
    rejectUnauthorized: true,                  // Enforce valid certificates
    minVersion: "TLSv1.2",                     // Minimum TLS version
    ciphers: [
      "TLS_AES_128_GCM_SHA256",
      "TLS_AES_256_GCM_SHA384",
      "TLS_CHACHA20_POLY1305_SHA256",
    ].join(":"),
  },
});
```

Environment variables for TLS:

| Variable | Description |
|---|---|
| `BLOK_TLS_CERT` | Path to TLS certificate |
| `BLOK_TLS_KEY` | Path to TLS private key |
| `BLOK_TLS_CA` | Path to CA certificate (mTLS) |
| `BLOK_TLS_MIN_VERSION` | Minimum TLS version (default: `TLSv1.2`) |

## Audit Logging

The `AuditLogger` provides a structured audit trail with configurable sinks and buffering:

```typescript
import {
  AuditLogger,
  ConsoleAuditSink,
  FileAuditSink,
} from "@nanoservice-ts/runner";

const audit = new AuditLogger({
  sinks: [
    new ConsoleAuditSink(),
    new FileAuditSink({ path: "./logs/audit.jsonl" }),
  ],
  minSeverity: "info",      // Minimum severity to log
  bufferSize: 100,           // Flush after 100 entries
  flushIntervalMs: 5000,     // Auto-flush every 5s
  serviceName: "blok-api",   // Service identifier in entries
});
```

### Audit Categories

| Category | Events |
|---|---|
| `auth` | Login, logout, token refresh, API key verification |
| `authz` | Permission checks, access grants/denials |
| `workflow` | Workflow executions (start, complete, error) |
| `node` | Individual node executions |
| `trigger` | Trigger lifecycle events |
| `config` | Configuration changes (create, update, delete) |
| `security` | Security-relevant events (rate limit, circuit open) |
| `system` | System lifecycle events |

### Logging Methods

```typescript
// Authentication event
audit.logAuth({
  action: "login",
  success: true,
  identity: { sub: "user-123", provider: "jwt" },
  ip: "192.168.1.1",
  userAgent: "Mozilla/5.0...",
  requestId: ctx.id,
});

// Authorization event
audit.logAuthz({
  action: "execute",
  resource: { type: "workflow", id: "/api/admin/users", name: "admin-users" },
  roles: ["developer"],
  allowed: false,
  actor: { sub: "user-123", ip: "192.168.1.1" },
});

// Workflow execution
audit.logWorkflowExecution({
  workflowName: "get-users",
  workflowPath: "/api/users",
  success: true,
  durationMs: 42.5,
  actor: { sub: "user-123" },
  requestId: ctx.id,
});

// Security event
audit.logSecurityEvent({
  action: "rate_limit_exceeded",
  severity: "warn",
  details: { ip: "192.168.1.1", endpoint: "/api/users", limit: 100 },
});
```

### Audit Entry Structure

```typescript
interface AuditEntry {
  id: string;                  // "blok-api-1705312200000-42"
  timestamp: string;           // ISO 8601
  category: AuditCategory;     // "auth", "authz", "workflow", etc.
  severity: AuditSeverity;     // "info", "warn", "error", "critical"
  action: string;              // What happened
  success: boolean;            // Whether the action succeeded
  actor?: {                    // Who performed the action
    sub: string;
    name?: string;
    ip?: string;
    userAgent?: string;
    provider?: string;
  };
  resource?: {                 // Target resource
    type: string;
    id: string;
    name?: string;
  };
  details?: Record<string, unknown>;
  requestId?: string;          // Correlation ID
  durationMs?: number;         // For execution events
  error?: { message: string; code?: string | number };
}
```

### Available Sinks

| Sink | Output | Use Case |
|---|---|---|
| `ConsoleAuditSink` | stdout/stderr (JSON) | Development, debugging |
| `FileAuditSink` | JSONL file | Production, compliance |
| `InMemoryAuditSink` | In-memory array | Testing, querying |

## Security Middleware Pipeline

For production deployments, compose the full security pipeline:

```typescript
import {
  AuthMiddleware,
  JWTAuthProvider,
  OAuthOIDCProvider,
  RBAC,
  createDefaultRBAC,
  AuditLogger,
  ConsoleAuditSink,
  FileAuditSink,
  SecretManager,
} from "@nanoservice-ts/runner";

// 1. Secret management
const secrets = new SecretManager({
  providers: [
    { type: "vault", config: { address: process.env.VAULT_ADDR!, token: process.env.VAULT_TOKEN } },
    { type: "environment", config: { prefix: "BLOK_SECRET_" } },
  ],
  cache: { enabled: true, ttlMs: 300_000, maxSize: 500 },
  auditLog: true,
});

// 2. Authentication
const jwtSecret = await secrets.getSecretOrThrow("JWT_SECRET");
const auth = new AuthMiddleware({
  providers: [
    new OAuthOIDCProvider({
      issuerUrl: process.env.OIDC_ISSUER!,
      clientId: process.env.OIDC_CLIENT_ID!,
    }),
    new JWTAuthProvider({ secret: jwtSecret }),
  ],
});

// 3. Authorization
const rbac = createDefaultRBAC();

// 4. Audit logging
const audit = new AuditLogger({
  sinks: [
    new ConsoleAuditSink(),
    new FileAuditSink({ path: "./logs/audit.jsonl" }),
  ],
});

// 5. Compose in request handler
app.use(auth.expressMiddleware());

app.use(async (req, res, next) => {
  const identity = req.auth;

  // Authorization check
  const access = rbac.canAccessWorkflow(identity.roles, req.path, "execute");

  // Audit the decision
  audit.logAuthz({
    action: "execute",
    resource: { type: "workflow", id: req.path },
    roles: identity.roles,
    allowed: access.allowed,
    actor: { sub: identity.sub, ip: req.ip },
    requestId: req.headers["x-request-id"],
  });

  if (!access.allowed) {
    return res.status(403).json({ error: access.reason });
  }

  next();
});
```

## See Also

- [Trigger System](/docs/architecture/trigger-system) -- how triggers integrate with authentication
- [Observability](/docs/architecture/observability) -- monitoring security events
- [Runtime Adapters](/docs/architecture/runtime-adapters) -- cross-runtime security considerations
