# SOC 2 Compliance Guide for Blok

This guide describes how to achieve and maintain SOC 2 compliance when building applications with the Blok framework. It maps Blok's built-in security primitives to the Trust Service Criteria and provides actionable implementation guidance.

---

## Table of Contents

- [Overview](#overview)
  - [SOC 2 Type I vs Type II](#soc-2-type-i-vs-type-ii)
  - [Trust Service Criteria](#trust-service-criteria)
- [How Blok Addresses TSC](#how-blok-addresses-tsc)
  - [Security (Common Criteria)](#security-common-criteria)
  - [Availability](#availability)
  - [Processing Integrity](#processing-integrity)
  - [Confidentiality](#confidentiality)
  - [Privacy](#privacy)
- [Built-in Security Controls](#built-in-security-controls)
  - [Authentication](#authentication)
  - [Role-Based Access Control](#role-based-access-control)
  - [Audit Logging](#audit-logging)
  - [Secret Management](#secret-management)
  - [Encryption at Rest](#encryption-at-rest)
- [Monitoring and Alerting](#monitoring-and-alerting)
- [Change Management](#change-management)
- [Incident Response Procedures](#incident-response-procedures)
- [Evidence Collection Checklist](#evidence-collection-checklist)
- [Annual Review Requirements](#annual-review-requirements)

---

## Overview

### SOC 2 Type I vs Type II

| Aspect | Type I | Type II |
|--------|--------|---------|
| **Scope** | Design of controls at a point in time | Design and operating effectiveness over a period (typically 6-12 months) |
| **Assessment** | Are controls suitably designed? | Are controls operating effectively over time? |
| **Evidence** | Policies, configurations, architecture | Logs, change records, monitoring data, incident reports |
| **Timeline** | Snapshot (single date) | Observation window (minimum 6 months) |

Most organizations begin with a **Type I** report and then progress to **Type II** once controls have been operating consistently.

### Trust Service Criteria

SOC 2 is structured around five Trust Service Criteria (TSC):

1. **Security** (Common Criteria) -- Protection of system resources against unauthorized access
2. **Availability** -- System is available for operation and use as committed
3. **Processing Integrity** -- System processing is complete, valid, accurate, timely, and authorized
4. **Confidentiality** -- Information designated as confidential is protected
5. **Privacy** -- Personal information is collected, used, retained, disclosed, and disposed of in accordance with commitments

---

## How Blok Addresses TSC

### Security (Common Criteria)

Blok provides layered security controls at the framework level:

| TSC Control | Blok Implementation | Module Path |
|---|---|---|
| CC6.1 Logical access security | `AuthMiddleware`, `JWTAuthProvider`, `APIKeyAuthProvider`, `OAuthOIDCProvider` | `core/runner/src/security/AuthMiddleware.ts`, `core/runner/src/security/OAuthProvider.ts` |
| CC6.2 Prior to issuing credentials | API key management with expiration, JWT with configurable issuers | `core/runner/src/security/AuthMiddleware.ts` |
| CC6.3 Role-based access | `RBAC` with hierarchical roles and resource-level permissions | `core/runner/src/security/RBAC.ts` |
| CC6.6 System boundaries | Excluded path configuration, rate limiting | `core/runner/src/monitoring/RateLimiter.ts` |
| CC6.8 Controls against malicious software | Circuit breaker pattern, input validation | `core/runner/src/monitoring/CircuitBreaker.ts` |
| CC7.1 Monitoring | `PrometheusMetricsBridge`, `SentryIntegration`, `CloudWatchIntegration` | `core/runner/src/monitoring/`, `core/runner/src/integrations/` |
| CC7.2 Anomaly detection | `AuditLogger` with severity levels, `StructuredLogger` | `core/runner/src/security/AuditLogger.ts`, `core/runner/src/monitoring/StructuredLogger.ts` |

**Implementation example -- securing all triggers:**

```typescript
import {
  AuthMiddleware,
  JWTAuthProvider,
  APIKeyAuthProvider,
  OAuthOIDCProvider,
} from "@blok/runner";

const auth = new AuthMiddleware({
  providers: [
    // Primary: OIDC (e.g., Auth0, Okta, Azure AD)
    new OAuthOIDCProvider({
      issuerUrl: "https://auth.example.com",
      clientId: "blok-api",
      audience: "https://api.example.com",
    }),
    // Secondary: JWT for internal service-to-service
    new JWTAuthProvider({
      secret: process.env.JWT_SECRET!,
      issuer: "blok-internal",
      audience: "blok-api",
    }),
    // Tertiary: API keys for external integrations
    new APIKeyAuthProvider({
      keys: new Map([
        [process.env.PARTNER_API_KEY!, { name: "partner-svc", roles: ["service"] }],
      ]),
    }),
  ],
  excludePaths: ["/health-check", "/metrics", "/health", "/liveness", "/readiness"],
  required: true,
});

// Attach to Express
app.use(auth.expressMiddleware());
```

### Availability

| TSC Control | Blok Implementation | Module Path |
|---|---|---|
| A1.1 Processing capacity | `RateLimiter` with configurable limits | `core/runner/src/monitoring/RateLimiter.ts` |
| A1.2 Environmental protections | `HealthCheck` with dependency monitoring | `core/runner/src/monitoring/HealthCheck.ts` |
| A1.3 Recovery operations | `CircuitBreaker` for graceful degradation | `core/runner/src/monitoring/CircuitBreaker.ts` |

**Health check configuration:**

```typescript
import { HealthCheck } from "@blok/runner";

const health = new HealthCheck();

// Register dependency checks
health.addCheck("database", async () => {
  const start = Date.now();
  await db.ping();
  return { status: "healthy", latencyMs: Date.now() - start };
});

health.addCheck("redis", async () => {
  await redis.ping();
  return { status: "healthy" };
});

// Expose on /health-check endpoint
app.get("/health-check", async (req, res) => {
  const result = await health.check();
  res.status(result.status === "healthy" ? 200 : 503).json(result);
});
```

### Processing Integrity

| TSC Control | Blok Implementation |
|---|---|
| PI1.1 Inputs are complete and accurate | Workflow schema validation, node input/output contracts |
| PI1.2 System processing | `AuditLogger.logWorkflowExecution()` tracks every execution |
| PI1.3 Outputs are complete | `BlokResponse` standardized output format |
| PI1.4 Error handling | `CircuitBreaker`, `SentryIntegration` for error capture |

### Confidentiality

| TSC Control | Blok Implementation | Module Path |
|---|---|---|
| C1.1 Identification of confidential information | `PIIDetector` scans for PII patterns | Custom implementation (see [Data Protection](#encryption-at-rest)) |
| C1.2 Disposal of confidential information | `SecretManager.deleteSecret()` across all providers | `core/runner/src/security/SecretManager.ts` |

### Privacy

| TSC Control | Blok Implementation |
|---|---|
| P1-P8 Privacy criteria | See the [GDPR Compliance Guide](./GDPR.md) for data subject rights implementation |

---

## Built-in Security Controls

### Authentication

Blok supports three authentication mechanisms out of the box, all implemented through the `AuthMiddleware` class:

**JWT Authentication (JWTAuthProvider)**

```typescript
import { JWTAuthProvider } from "@blok/runner";

const jwtAuth = new JWTAuthProvider({
  secret: process.env.JWT_SECRET!,   // HS256 shared secret
  issuer: "https://auth.example.com", // Validate iss claim
  audience: "blok-api",               // Validate aud claim
  clockToleranceSec: 30,              // Tolerance for clock skew
  rolesClaim: "roles",                // JWT claim for roles extraction
});
```

**API Key Authentication (APIKeyAuthProvider)**

```typescript
import { APIKeyAuthProvider } from "@blok/runner";

const apiKeyAuth = new APIKeyAuthProvider({
  keys: new Map([
    ["sk_prod_abc123", {
      name: "partner-integration",
      roles: ["service", "read-only"],
      expiresAt: Math.floor(Date.now() / 1000) + 86400 * 365, // 1 year
    }],
  ]),
  headerName: "x-api-key",    // Header to read
  queryParam: "api_key",       // Query parameter fallback
  validate: async (key) => {   // Custom DB-backed validation
    return await db.apiKeys.findByHash(hashKey(key));
  },
});
```

**OAuth 2.0 / OIDC (OAuthOIDCProvider)**

```typescript
import { OAuthOIDCProvider } from "@blok/runner";

const oidcAuth = new OAuthOIDCProvider({
  issuerUrl: "https://auth.example.com",
  clientId: "blok-api",
  clientSecret: process.env.OIDC_CLIENT_SECRET,
  audience: "https://api.example.com",
  allowedAlgorithms: ["RS256", "ES256"],
  rolesClaim: "roles",
  scopesClaim: "scope",
  clockToleranceSec: 30,
  cacheJWKS: true,
  cacheDiscovery: true,
});
```

### Role-Based Access Control

Blok's `RBAC` class implements hierarchical role-based access control with resource-level granularity:

```typescript
import { RBAC, createDefaultRBAC } from "@blok/runner";

// Use the built-in default roles (admin, developer, operator, viewer, service)
const rbac = createDefaultRBAC();

// Or define custom roles
const rbac = new RBAC();

rbac.addRole({
  name: "admin",
  description: "Full access to all resources",
  permissions: [{ resource: "*", actions: ["*"] }],
});

rbac.addRole({
  name: "developer",
  description: "Read, create, update, and execute workflows",
  permissions: [
    { resource: "workflow", actions: ["read", "create", "update", "execute"] },
    { resource: "node", actions: ["read", "create", "update", "execute"] },
    { resource: "trigger", actions: ["read"] },
    { resource: "runtime", actions: ["read", "execute"] },
  ],
  inherits: ["viewer"],
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

// Check permissions
const result = rbac.can("developer", "workflow", "execute");
// result.allowed === true

// Check multiple roles (e.g., from JWT claims)
const check = rbac.canAny(["developer", "viewer"], "workflow", "delete");
// check.allowed === false, check.reason explains why

// Workflow-specific access control
const access = rbac.canAccessWorkflow(["operator"], "/api/users", "execute");
```

**RBAC integration with AuthMiddleware:**

```typescript
app.use(auth.expressMiddleware());

app.post("/workflows/:name/execute", (req, res) => {
  const identity = req.auth; // Attached by AuthMiddleware
  const check = rbac.canAny(identity.roles, "workflow", "execute", req.params.name);

  if (!check.allowed) {
    audit.logAuthz({
      action: "execute",
      resource: { type: "workflow", id: req.params.name },
      roles: identity.roles,
      allowed: false,
      actor: { sub: identity.sub, ip: req.ip },
    });
    return res.status(403).json({ error: check.reason });
  }

  // Proceed with execution
});
```

### Audit Logging

The `AuditLogger` provides tamper-evident audit trails required for SOC 2:

```typescript
import {
  AuditLogger,
  ConsoleAuditSink,
  FileAuditSink,
} from "@blok/runner";

const audit = new AuditLogger({
  sinks: [
    new ConsoleAuditSink(),                    // Structured JSON to stdout
    new FileAuditSink({ path: "/var/log/blok/audit.log" }), // JSONL file
  ],
  includeRequestId: true,
  minSeverity: "info",
  bufferSize: 100,           // Flush after 100 entries
  flushIntervalMs: 5000,     // Or every 5 seconds
  serviceName: "blok-api",
});

// Log authentication events
audit.logAuth({
  action: "login",
  success: true,
  identity: { sub: "user-123", provider: "oauth-oidc", name: "Jane Doe" },
  ip: "192.168.1.100",
  userAgent: "Mozilla/5.0...",
  requestId: "req-abc-123",
});

// Log authorization decisions
audit.logAuthz({
  action: "execute",
  resource: { type: "workflow", id: "/api/orders", name: "create-order" },
  roles: ["developer"],
  allowed: true,
  actor: { sub: "user-123", name: "Jane Doe", ip: "192.168.1.100" },
  requestId: "req-abc-123",
});

// Log workflow executions
audit.logWorkflowExecution({
  workflowName: "create-order",
  workflowPath: "/api/orders",
  success: true,
  durationMs: 234,
  actor: { sub: "user-123", ip: "192.168.1.100" },
  requestId: "req-abc-123",
});

// Log configuration changes
audit.logConfigChange({
  action: "update",
  resourceType: "workflow",
  resourceId: "/api/orders",
  actor: { sub: "admin-1", name: "Admin" },
  details: { previousVersion: "1.0", newVersion: "1.1" },
});

// Log security events
audit.logSecurityEvent({
  action: "brute_force_detected",
  severity: "critical",
  details: { ip: "10.0.0.5", attempts: 15, window: "5m" },
  actor: { sub: "unknown", ip: "10.0.0.5" },
});
```

**Audit entry structure (JSONL output):**

```json
{
  "id": "blok-api-1706500000000-1",
  "timestamp": "2026-01-29T00:00:00.000Z",
  "category": "auth",
  "severity": "info",
  "action": "login",
  "success": true,
  "actor": {
    "sub": "user-123",
    "name": "Jane Doe",
    "ip": "192.168.1.100",
    "provider": "oauth-oidc"
  },
  "requestId": "req-abc-123"
}
```

### Secret Management

The `SecretManager` provides a unified interface with provider chaining:

```typescript
import { SecretManager } from "@blok/runner";

const secrets = new SecretManager({
  providers: [
    // Priority 1: HashiCorp Vault for production secrets
    {
      type: "vault",
      config: {
        address: "https://vault.internal:8200",
        token: process.env.VAULT_TOKEN,
        mountPath: "secret",
        namespace: "production",
      },
    },
    // Priority 2: AWS Secrets Manager as fallback
    {
      type: "aws",
      config: {
        region: "us-east-1",
      },
    },
    // Priority 3: Environment variables for local development
    {
      type: "environment",
      config: {
        prefix: "BLOK_SECRET_",
      },
    },
  ],
  cache: {
    enabled: true,
    ttlMs: 300_000,  // 5-minute cache
    maxSize: 500,
  },
  auditLog: true, // Emit secretAccess events
});

// Listen for secret access events (for SOC 2 audit trail)
secrets.on("secretAccess", (event) => {
  audit.logSecurityEvent({
    action: `secret.${event.operation}`,
    severity: event.success ? "info" : "error",
    details: {
      key: event.key,
      provider: event.provider,
      cached: event.cached,
    },
  });
});

// Retrieve secrets
const dbPassword = await secrets.getSecretOrThrow("DB_PASSWORD");

// Resolve templates
const connectionString = await secrets.resolveTemplate(
  "postgres://app:${secret:DB_PASSWORD}@${secret:DB_HOST}:5432/production"
);
```

### Encryption at Rest

Protect sensitive data with AES-256-GCM encryption:

```typescript
import { EncryptionAtRest } from "@blok/runner";

const encryption = new EncryptionAtRest({
  algorithm: "aes-256-gcm",
  keyDerivation: {
    iterations: 100_000,
    saltLength: 16,
    digest: "sha512",
  },
  encoding: "base64",
});

// Encrypt sensitive data
const payload = encryption.encrypt("SSN: 123-45-6789", encryptionKey);
// payload: { iv, ciphertext, tag, algorithm }

// Decrypt
const plaintext = encryption.decrypt(payload, encryptionKey);

// Encrypt/decrypt JSON objects
const encrypted = encryption.encryptObject(
  { ssn: "123-45-6789", name: "Jane Doe" },
  encryptionKey
);
const record = encryption.decryptObject<{ ssn: string; name: string }>(
  encrypted,
  encryptionKey
);

// Key rotation
const rotated = encryption.rotateKey(encrypted, oldKey, newKey);
```

---

## Monitoring and Alerting

SOC 2 requires continuous monitoring. Blok integrates with the industry-standard observability stack:

### Prometheus Metrics

```typescript
import {
  PrometheusMetricsBridge,
  TriggerMetricsCollector,
  bootstrapPrometheus,
} from "@blok/runner";

// Bootstrap Prometheus with OpenTelemetry
const prom = await bootstrapPrometheus({
  port: 9090,
  endpoint: "/metrics",
});

// Metrics bridge automatically exports:
// - blok_workflow_executions_total
// - blok_workflow_duration_seconds
// - blok_workflow_errors_total
// - blok_circuit_breaker_state
// - blok_rate_limiter_rejected_total
```

### Sentry Error Tracking

```typescript
import { SentryIntegration } from "@blok/runner";

const sentry = new SentryIntegration({
  dsn: process.env.SENTRY_DSN!,
  environment: process.env.NODE_ENV || "production",
  release: `blok@${process.env.APP_VERSION}`,
  tracesSampleRate: 0.1,
  tags: { service: "blok-api" },
});

await sentry.init();

// Capture workflow errors with full context
sentry.captureWorkflowError(error, {
  workflowName: "create-order",
  workflowPath: "/api/orders",
  requestId: "req-abc-123",
  nodeName: "validate-payment",
  nodeType: "api-call",
  durationMs: 1234,
});
```

### CloudWatch Integration

```typescript
import { CloudWatchIntegration } from "@blok/runner";

const cloudwatch = new CloudWatchIntegration({
  region: "us-east-1",
  namespace: "Blok/Production",
  dimensions: { Service: "blok-api", Environment: "production" },
});
```

### Azure Monitor Integration

```typescript
import { AzureMonitorIntegration } from "@blok/runner";

const azure = new AzureMonitorIntegration({
  connectionString: process.env.APPLICATIONINSIGHTS_CONNECTION_STRING!,
});
```

### Structured Logging

```typescript
import { StructuredLogger } from "@blok/runner";

const logger = new StructuredLogger({
  service: "blok-api",
  environment: "production",
});

// JSON-structured output compatible with Grafana Loki, ELK, CloudWatch Logs
logger.info("Workflow executed", {
  workflow: "create-order",
  durationMs: 234,
  requestId: "req-abc-123",
});
```

### Recommended Alert Rules

| Alert | Condition | Severity |
|---|---|---|
| High error rate | `blok_workflow_errors_total` > 5% of total in 5m | Critical |
| Slow workflows | `blok_workflow_duration_seconds` p99 > 10s | Warning |
| Auth failures spike | `audit.auth.failure` > 10 in 1m | Critical |
| Circuit breaker open | `blok_circuit_breaker_state == "open"` | Warning |
| Health check failure | `/health-check` returns 503 | Critical |
| Secret access anomaly | Unusual `secretAccess` event patterns | Warning |

---

## Change Management

SOC 2 requires documented change management processes. Recommended CI/CD pipeline:

### Pipeline Structure

```yaml
# .github/workflows/deploy.yml
name: Deploy
on:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pnpm install
      - run: pnpm test
      - run: pnpm run lint

  security-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Dependency audit
        run: pnpm audit --audit-level=high
      - name: Snyk scan
        uses: snyk/actions/node@master
        env:
          SNYK_TOKEN: ${{ secrets.SNYK_TOKEN }}

  deploy:
    needs: [test, security-scan]
    runs-on: ubuntu-latest
    environment: production      # Requires approval
    steps:
      - name: Deploy to production
        run: ./scripts/deploy.sh
      # Audit log the deployment
      - name: Log deployment
        run: |
          curl -X POST "$AUDIT_WEBHOOK_URL" \
            -H "Content-Type: application/json" \
            -d '{"action":"deploy","version":"${{ github.sha }}","actor":"${{ github.actor }}"}'
```

### Change Management Checklist

- [ ] All changes go through pull requests with code review
- [ ] Automated tests pass before merge
- [ ] Security scans pass (Snyk, dependency audit)
- [ ] Deployment requires approval for production
- [ ] Deployments are logged in the audit trail
- [ ] Rollback procedures are documented and tested
- [ ] Configuration changes are version-controlled

---

## Incident Response Procedures

### Incident Classification

| Level | Description | Response Time | Example |
|---|---|---|---|
| P1 - Critical | Service outage, data breach | 15 minutes | Authentication bypass, data exfiltration |
| P2 - High | Significant degradation | 1 hour | Elevated error rates, partial outage |
| P3 - Medium | Minor impact | 4 hours | Non-critical feature failure |
| P4 - Low | Minimal impact | 24 hours | Cosmetic issues, minor bugs |

### Response Steps

1. **Detection** -- Alert triggers via monitoring (Prometheus, Sentry, CloudWatch)
2. **Triage** -- On-call engineer classifies severity
3. **Containment** -- Isolate affected systems (circuit breaker, rate limiting)
4. **Investigation** -- Use audit logs and structured logs for root cause analysis
5. **Remediation** -- Deploy fix through CI/CD pipeline
6. **Communication** -- Notify stakeholders per severity level
7. **Post-mortem** -- Document findings and preventive measures

### Using Blok for Incident Investigation

```typescript
// Query audit logs for suspicious activity
const auditSink = new InMemoryAuditSink();
const entries = auditSink.query({
  category: "security",
  severity: "critical",
  since: "2026-01-29T00:00:00Z",
  limit: 100,
});

// Check for authentication anomalies
const authFailures = auditSink.query({
  category: "auth",
  actorSub: "suspicious-user",
  action: "login",
});
```

---

## Evidence Collection Checklist

Gather the following evidence for your SOC 2 audit:

### Security Controls

- [ ] Authentication configuration (AuthMiddleware setup with providers)
- [ ] RBAC role definitions and policies (`rbac.toJSON()` export)
- [ ] API key rotation records
- [ ] JWT secret rotation records
- [ ] OIDC provider configuration

### Audit Logs

- [ ] Authentication attempt logs (success and failure)
- [ ] Authorization decision logs
- [ ] Workflow execution logs
- [ ] Configuration change logs
- [ ] Security event logs (brute force, anomalies)
- [ ] Secret access audit events

### Monitoring

- [ ] Prometheus dashboard screenshots (Grafana)
- [ ] Alert configuration and history
- [ ] Incident response records
- [ ] Uptime reports from health checks
- [ ] Sentry error tracking reports

### Change Management

- [ ] Git commit history and pull request records
- [ ] CI/CD pipeline configurations
- [ ] Deployment logs
- [ ] Code review records
- [ ] Security scan results (Snyk, dependency audit)

### Secret Management

- [ ] SecretManager configuration (provider chain, caching)
- [ ] Secret rotation schedule and records
- [ ] Vault audit logs
- [ ] AWS Secrets Manager / GCP Secret Manager access logs

### Encryption

- [ ] EncryptionAtRest configuration (algorithm, key derivation)
- [ ] Key rotation records
- [ ] TLS certificate management records

---

## Annual Review Requirements

SOC 2 compliance is not a one-time effort. Conduct the following reviews annually:

### Quarterly Reviews

1. **Access Review** -- Verify RBAC roles and API keys are current
   ```typescript
   // Export and review RBAC configuration
   const config = rbac.toJSON();
   console.log("Active roles:", config.roles.map(r => r.name));
   console.log("Active policies:", Object.keys(config.policies));
   ```

2. **Secret Rotation** -- Rotate JWT secrets, API keys, and encryption keys
   ```typescript
   // Check for expiring API keys
   for (const [key, info] of apiKeys) {
     if (info.expiresAt && info.expiresAt < futureTimestamp) {
       console.warn(`API key "${info.name}" expires soon`);
     }
   }
   ```

3. **Monitoring Review** -- Verify alerts are functioning and thresholds are appropriate

### Semi-Annual Reviews

1. **Penetration Testing** -- Engage third-party security testers
2. **Disaster Recovery Test** -- Verify backup and recovery procedures
3. **Incident Response Drill** -- Simulate a security incident

### Annual Reviews

1. **Policy Review** -- Update security policies and procedures
2. **Risk Assessment** -- Identify new threats and vulnerabilities
3. **Vendor Review** -- Assess third-party provider security (Vault, AWS, GCP)
4. **Training** -- Security awareness training for all team members
5. **Audit Preparation** -- Compile evidence, address gaps, engage auditor

### Continuous Activities

- Monitor audit logs for anomalies
- Review dependency vulnerability alerts (Snyk, Dependabot)
- Track and remediate security findings
- Maintain incident response runbooks
- Update documentation as the system evolves
