# Security Hardening Guide for Blok

This guide provides a comprehensive security hardening checklist for deploying Blok applications in production environments. It covers infrastructure, runtime, application, and operational security.

---

## Table of Contents

- [Production Deployment Checklist](#production-deployment-checklist)
- [Environment Variable Security](#environment-variable-security)
- [Network Security](#network-security)
- [Container Security](#container-security)
- [Runtime Security](#runtime-security)
- [Authentication Hardening](#authentication-hardening)
- [Authorization Hardening](#authorization-hardening)
- [Logging and Monitoring](#logging-and-monitoring)
- [Dependency Security](#dependency-security)
- [Secrets Management](#secrets-management)
- [Data Protection](#data-protection)
- [Kubernetes Hardening](#kubernetes-hardening)
- [Incident Response Playbook](#incident-response-playbook)
- [Security Scanning Schedule](#security-scanning-schedule)

---

## Production Deployment Checklist

Complete this checklist before any production deployment:

### Pre-Deployment

- [ ] All secrets stored in SecretManager (not environment variables or source code)
- [ ] TLS 1.2+ configured for all external endpoints
- [ ] Authentication enabled on all non-health endpoints
- [ ] RBAC roles configured with least privilege
- [ ] Audit logging enabled with persistent storage
- [ ] Error tracking configured (Sentry or equivalent)
- [ ] Prometheus metrics enabled
- [ ] Health check endpoints verified
- [ ] Dependency vulnerability scan passed (no critical/high)
- [ ] Container image scanned for vulnerabilities
- [ ] Network policies restrict inter-service communication
- [ ] Rate limiting configured
- [ ] Circuit breakers configured for external dependencies

### Post-Deployment

- [ ] Health checks returning 200
- [ ] Metrics are being collected by Prometheus
- [ ] Audit logs are being written to persistent storage
- [ ] Error tracking is receiving events
- [ ] Alert rules are firing correctly (test alert)
- [ ] Access control verified (test authorized and unauthorized requests)
- [ ] TLS certificate valid and not expiring within 30 days

---

## Environment Variable Security

### Never Commit Secrets

```bash
# .gitignore -- MUST include:
.env
.env.*
*.key
*.pem
*.p12
credentials.json
service-account.json
```

### Use SecretManager for All Secrets

```typescript
import { SecretManager } from "@blok/runner";

// WRONG: Secrets in environment variables or code
// const dbPassword = process.env.DB_PASSWORD;
// const apiKey = "sk_live_abc123"; // NEVER hardcode

// CORRECT: Use SecretManager
const secrets = new SecretManager({
  providers: [
    // Production: Vault or cloud provider
    {
      type: "vault",
      config: {
        address: process.env.VAULT_ADDR!,    // Only the Vault address in env
        token: process.env.VAULT_TOKEN,       // Vault token from platform (K8s SA, IAM)
        mountPath: "secret",
        namespace: "production",
      },
    },
    // Alternative: AWS Secrets Manager
    {
      type: "aws",
      config: {
        region: "us-east-1",
        // Uses IAM role -- no credentials in code
      },
    },
  ],
  cache: { enabled: true, ttlMs: 300_000, maxSize: 500 },
  auditLog: true,
});

// Retrieve secrets at runtime
const dbPassword = await secrets.getSecretOrThrow("DB_PASSWORD");
const apiKey = await secrets.getSecretOrThrow("EXTERNAL_API_KEY");

// Resolve connection strings with template syntax
const connectionString = await secrets.resolveTemplate(
  "postgres://app:${secret:DB_PASSWORD}@${secret:DB_HOST}:5432/production"
);
```

### Environment Variable Best Practices

```bash
# Only these types of values belong in environment variables:
# - Service discovery URLs (non-secret)
# - Feature flags
# - Log levels
# - Environment name

NODE_ENV=production
VAULT_ADDR=https://vault.internal:8200
LOG_LEVEL=info
BLOK_LOG_LEVEL=info
SERVICE_NAME=blok-api

# Vault token should come from the platform (K8s Service Account, IAM Role)
# NOT from a .env file in production
```

---

## Network Security

### TLS Everywhere

```typescript
import { createServer } from "node:https";
import { readFileSync } from "node:fs";

// Production TLS configuration
const tlsConfig = {
  key: readFileSync("/etc/tls/private/server.key"),
  cert: readFileSync("/etc/tls/certs/server.crt"),
  ca: readFileSync("/etc/tls/certs/ca-bundle.crt"),

  // Enforce TLS 1.2 minimum (TLS 1.0/1.1 deprecated)
  minVersion: "TLSv1.2" as const,

  // Strong cipher suites only
  ciphers: [
    "TLS_AES_256_GCM_SHA384",
    "TLS_CHACHA20_POLY1305_SHA256",
    "TLS_AES_128_GCM_SHA256",
    "ECDHE-RSA-AES256-GCM-SHA384",
    "ECDHE-RSA-AES128-GCM-SHA256",
  ].join(":"),

  // Server chooses cipher (prevents downgrade)
  honorCipherOrder: true,

  // Enable OCSP stapling for certificate validation
  // Configure at reverse proxy level (nginx, envoy)
};

const server = createServer(tlsConfig, app);
server.listen(443);
```

### mTLS for Service-to-Service Communication

```typescript
// Mutual TLS for internal service communication
const mtlsConfig = {
  key: readFileSync("/etc/tls/private/service.key"),
  cert: readFileSync("/etc/tls/certs/service.crt"),
  ca: readFileSync("/etc/tls/certs/internal-ca.crt"),
  minVersion: "TLSv1.2" as const,
  requestCert: true,           // Request client certificate
  rejectUnauthorized: true,    // Reject connections without valid cert
};
```

### Firewall Rules

```bash
# Recommended firewall rules for Blok production deployment

# Allow inbound HTTPS only (443)
iptables -A INPUT -p tcp --dport 443 -j ACCEPT

# Allow health check from load balancer (internal network only)
iptables -A INPUT -s 10.0.0.0/8 -p tcp --dport 8080 -j ACCEPT

# Allow Prometheus scraping (internal network only)
iptables -A INPUT -s 10.0.0.0/8 -p tcp --dport 9090 -j ACCEPT

# Block all other inbound
iptables -A INPUT -j DROP

# Allow all outbound (for external API calls, Vault, cloud providers)
iptables -A OUTPUT -j ACCEPT
```

### Security Groups (Cloud)

```terraform
# AWS Security Group for Blok
resource "aws_security_group" "blok_api" {
  name        = "blok-api-sg"
  description = "Security group for Blok API servers"

  # HTTPS from load balancer only
  ingress {
    from_port       = 443
    to_port         = 443
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  # Health check from internal network
  ingress {
    from_port   = 8080
    to_port     = 8080
    protocol    = "tcp"
    cidr_blocks = ["10.0.0.0/8"]
  }

  # Prometheus metrics from monitoring subnet
  ingress {
    from_port   = 9090
    to_port     = 9090
    protocol    = "tcp"
    cidr_blocks = ["10.0.100.0/24"]
  }

  # All outbound
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
```

---

## Container Security

### Dockerfile Best Practices

```dockerfile
# Use specific version tags, never "latest"
FROM node:20-alpine AS build

# Create non-root user
RUN addgroup -g 1001 -S blok && \
    adduser -S blok -u 1001 -G blok

WORKDIR /app

# Install dependencies first (cache layer)
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod

# Copy application code
COPY --chown=blok:blok . .

# Build
RUN pnpm build

# Production stage
FROM node:20-alpine AS production

# Security updates
RUN apk update && apk upgrade --no-cache && \
    apk add --no-cache dumb-init

# Create non-root user
RUN addgroup -g 1001 -S blok && \
    adduser -S blok -u 1001 -G blok

WORKDIR /app

# Copy only production artifacts
COPY --from=build --chown=blok:blok /app/dist ./dist
COPY --from=build --chown=blok:blok /app/node_modules ./node_modules
COPY --from=build --chown=blok:blok /app/package.json ./

# Use non-root user
USER blok

# Read-only filesystem (mount writable volumes as needed)
# Use dumb-init for proper signal handling
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:8080/health-check || exit 1

# Expose only necessary ports
EXPOSE 8080

# Security labels
LABEL security.non-root="true" \
      security.read-only-fs="recommended" \
      security.no-new-privileges="true"
```

### Container Runtime Security

```yaml
# docker-compose.yml security settings
services:
  blok-api:
    image: blok-api:1.0.0
    user: "1001:1001"              # Non-root user
    read_only: true                 # Read-only filesystem
    tmpfs:
      - /tmp:noexec,nosuid,size=64m  # Writable /tmp with restrictions
    security_opt:
      - no-new-privileges:true      # Prevent privilege escalation
    cap_drop:
      - ALL                         # Drop all capabilities
    cap_add: []                     # Add none back
    deploy:
      resources:
        limits:
          cpus: "1.0"
          memory: 512M
        reservations:
          cpus: "0.25"
          memory: 128M
    environment:
      - NODE_ENV=production
      - VAULT_ADDR=https://vault.internal:8200
    volumes:
      - audit-logs:/var/log/blok:rw  # Only audit log directory is writable
    networks:
      - internal
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:8080/health-check"]
      interval: 30s
      timeout: 5s
      retries: 3
```

---

## Runtime Security

### Node.js Hardening

```typescript
// Production Node.js hardening

// 1. Disable debug and inspector in production
// Start with: node --no-warnings dist/index.js
// NEVER use: node --inspect or node --inspect-brk in production

// 2. Set secure HTTP headers (helmet)
import helmet from "helmet";
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'none'"],
      frameSrc: ["'none'"],
    },
  },
  hsts: {
    maxAge: 31536000,       // 1 year
    includeSubDomains: true,
    preload: true,
  },
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  noSniff: true,
  xssFilter: true,
  frameguard: { action: "deny" },
}));

// 3. Request size limits
import { json, urlencoded } from "express";
app.use(json({ limit: "1mb" }));
app.use(urlencoded({ extended: true, limit: "1mb" }));

// 4. Timeout configuration
server.setTimeout(30000); // 30-second timeout
server.keepAliveTimeout = 65000; // Slightly longer than ALB (60s default)
server.headersTimeout = 66000;

// 5. Disable powered-by header
app.disable("x-powered-by");

// 6. Enable trust proxy (behind load balancer)
app.set("trust proxy", 1);

// 7. Error handling -- never expose stack traces
app.use((err: Error, req: any, res: any, next: any) => {
  // Log full error internally
  logger.error("Unhandled error", {
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
  });

  // Return generic error to client
  res.status(500).json({
    error: "Internal server error",
    requestId: req.id,
  });
});
```

### Process Security

```bash
# Production Node.js flags
node \
  --no-warnings \
  --max-old-space-size=384 \
  --max-semi-space-size=16 \
  --disable-proto=throw \
  dist/index.js
```

```typescript
// Handle uncaught exceptions and rejections gracefully
process.on("uncaughtException", (error) => {
  logger.fatal("Uncaught exception", { error: error.message, stack: error.stack });
  sentry.captureException(error);
  // Flush audit logs before exit
  audit.close().then(() => process.exit(1));
});

process.on("unhandledRejection", (reason) => {
  logger.fatal("Unhandled rejection", { reason: String(reason) });
  sentry.captureException(reason);
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  logger.info("SIGTERM received, shutting down gracefully");
  server.close();
  await audit.close();
  process.exit(0);
});
```

---

## Authentication Hardening

### Rotate JWT Secrets

```typescript
import { JWTAuthProvider, SecretManager } from "@blok/runner";

// Retrieve JWT secret from SecretManager (never hardcode)
const secrets = new SecretManager({
  providers: [
    { type: "vault", config: { address: process.env.VAULT_ADDR!, token: process.env.VAULT_TOKEN } },
  ],
  cache: { enabled: true, ttlMs: 300_000, maxSize: 100 },
  auditLog: true,
});

const jwtSecret = await secrets.getSecretOrThrow("JWT_SECRET");

const jwtAuth = new JWTAuthProvider({
  secret: jwtSecret,
  issuer: "https://api.example.com",
  audience: "blok-api",
  clockToleranceSec: 15,      // Tight clock tolerance
  rolesClaim: "roles",
});

// JWT secret rotation procedure:
// 1. Generate new secret in Vault
// 2. Deploy with both old and new secrets (validation period)
// 3. Invalidate old tokens (force re-authentication)
// 4. Remove old secret
```

### Enforce Strong API Keys

```typescript
import { APIKeyAuthProvider, SecretManager } from "@blok/runner";
import { randomBytes } from "node:crypto";

// Generate cryptographically secure API keys
function generateAPIKey(): string {
  // 32 bytes = 256 bits of entropy
  return `blk_${randomBytes(32).toString("hex")}`;
}

// API key requirements:
// - Minimum 256 bits of entropy
// - Prefix for identification (blk_)
// - Expiration date set
// - Roles assigned (least privilege)
// - Stored hashed in database (SHA-256)

const apiKeyAuth = new APIKeyAuthProvider({
  keys: new Map(), // Static keys only for testing; use custom validator in production
  headerName: "x-api-key",
  validate: async (key) => {
    // Hash the key before database lookup
    const keyHash = createHash("sha256").update(key).digest("hex");
    const record = await db.apiKeys.findByHash(keyHash);

    if (!record) return null;
    if (record.revokedAt) return null;

    // Check expiration
    if (record.expiresAt && record.expiresAt < Date.now()) {
      return null;
    }

    return {
      name: record.name,
      roles: record.roles,
      metadata: { keyId: record.id },
      expiresAt: record.expiresAt ? Math.floor(record.expiresAt / 1000) : undefined,
    };
  },
});
```

### Enable OIDC with MFA

```typescript
import { OAuthOIDCProvider } from "@blok/runner";

// Configure OIDC with a provider that supports MFA
const oidcAuth = new OAuthOIDCProvider({
  issuerUrl: "https://auth.example.com",
  clientId: process.env.OIDC_CLIENT_ID!,
  clientSecret: process.env.OIDC_CLIENT_SECRET!,
  audience: "https://api.example.com",
  allowedAlgorithms: ["RS256", "ES256"],  // Only asymmetric algorithms
  rolesClaim: "roles",
  scopesClaim: "scope",
  clockToleranceSec: 15,
  cacheJWKS: true,
  cacheDiscovery: true,
});

// Verify MFA claim in token
function requireMFA(identity: AuthIdentity): boolean {
  const claims = identity.claims;

  // Check for MFA claim (varies by provider)
  // Auth0: claims.amr includes "mfa"
  // Okta: claims.amr includes "mfa"
  // Azure AD: claims.mfa_authenticated === true
  const amr = claims.amr as string[] | undefined;
  return Array.isArray(amr) && amr.includes("mfa");
}
```

### Enable mTLS for Service Communication

```typescript
// For service-to-service authentication, use mTLS
import { createServer } from "node:https";
import { readFileSync } from "node:fs";

const mtlsServer = createServer({
  key: readFileSync("/etc/tls/private/service.key"),
  cert: readFileSync("/etc/tls/certs/service.crt"),
  ca: readFileSync("/etc/tls/certs/internal-ca.crt"),
  minVersion: "TLSv1.2" as const,
  requestCert: true,
  rejectUnauthorized: true,
}, app);

// Verify client certificate in middleware
app.use((req, res, next) => {
  const cert = req.socket.getPeerCertificate();
  if (!cert || !cert.subject) {
    return res.status(401).json({ error: "Client certificate required" });
  }

  // Verify certificate CN matches expected service
  const allowedServices = ["payment-service", "notification-service", "analytics-service"];
  if (!allowedServices.includes(cert.subject.CN)) {
    audit.logAuth({
      action: "login",
      success: false,
      error: `Unknown service certificate: ${cert.subject.CN}`,
      identity: { sub: cert.subject.CN, provider: "mtls" },
    });
    return res.status(403).json({ error: "Service not authorized" });
  }

  req.auth = {
    sub: cert.subject.CN,
    roles: ["service"],
    claims: { certificateCN: cert.subject.CN },
    provider: "mtls",
  };
  next();
});
```

---

## Authorization Hardening

### Principle of Least Privilege

```typescript
import { RBAC } from "@blok/runner";

const rbac = new RBAC();

// DO: Specific permissions per role
rbac.addRole({
  name: "order-service",
  description: "Service account for order processing",
  permissions: [
    { resource: "workflow", actions: ["execute"], resourcePattern: "orders/*" },
    { resource: "node", actions: ["execute"], resourcePattern: "payment/*" },
  ],
});

// DON'T: Overly broad permissions
// rbac.addRole({
//   name: "service",
//   permissions: [{ resource: "*", actions: ["*"] }],  // TOO BROAD
// });
```

### RBAC Configuration for Production

```typescript
import { RBAC } from "@blok/runner";

const rbac = new RBAC();

// Production role hierarchy
rbac.addRole({
  name: "super-admin",
  description: "Emergency access only -- requires approval",
  permissions: [{ resource: "*", actions: ["*"] }],
});

rbac.addRole({
  name: "admin",
  description: "System administration -- no production data access",
  permissions: [
    { resource: "workflow", actions: ["read", "create", "update", "delete"] },
    { resource: "node", actions: ["read", "create", "update", "delete"] },
    { resource: "trigger", actions: ["read", "create", "update", "delete"] },
    { resource: "runtime", actions: ["read", "create", "update"] },
    { resource: "user_management", actions: ["*"] },
  ],
});

rbac.addRole({
  name: "developer",
  description: "Development and testing -- staging only",
  permissions: [
    { resource: "workflow", actions: ["read", "create", "update", "execute"] },
    { resource: "node", actions: ["read", "create", "update", "execute"] },
    { resource: "trigger", actions: ["read"] },
    { resource: "runtime", actions: ["read", "execute"] },
  ],
  inherits: ["viewer"],
});

rbac.addRole({
  name: "operator",
  description: "Operations -- execute and monitor",
  permissions: [
    { resource: "workflow", actions: ["read", "execute"] },
    { resource: "node", actions: ["read", "execute"] },
    { resource: "metrics", actions: ["read"] },
    { resource: "health", actions: ["read"] },
    { resource: "audit_logs", actions: ["read"] },
  ],
});

rbac.addRole({
  name: "viewer",
  description: "Read-only access to non-sensitive resources",
  permissions: [
    { resource: "workflow", actions: ["read"] },
    { resource: "node", actions: ["read"] },
    { resource: "metrics", actions: ["read"] },
    { resource: "health", actions: ["read"] },
  ],
});

rbac.addRole({
  name: "service",
  description: "Machine-to-machine -- execution only for specific workflows",
  permissions: [
    { resource: "workflow", actions: ["execute"] },
    { resource: "node", actions: ["execute"] },
  ],
});

// Enforce RBAC on every request
app.use((req, res, next) => {
  const identity = req.auth;
  if (!identity) return res.status(401).json({ error: "Not authenticated" });

  // Determine resource and action from request
  const resource = getResourceFromPath(req.path);
  const action = getActionFromMethod(req.method);

  const check = rbac.canAny(identity.roles, resource, action);
  if (!check.allowed) {
    audit.logAuthz({
      action,
      resource: { type: resource, id: req.path },
      roles: identity.roles,
      allowed: false,
      actor: { sub: identity.sub, ip: req.ip },
    });
    return res.status(403).json({ error: "Forbidden", reason: check.reason });
  }

  next();
});
```

---

## Logging and Monitoring

### Enable AuditLogger

```typescript
import {
  AuditLogger,
  ConsoleAuditSink,
  FileAuditSink,
} from "@blok/runner";

// Production audit logging configuration
const audit = new AuditLogger({
  sinks: [
    // JSON to stdout for SIEM ingestion (Splunk, ELK, Loki)
    new ConsoleAuditSink(),
    // JSONL file for persistence
    new FileAuditSink({ path: "/var/log/blok/audit.log" }),
  ],
  includeRequestId: true,
  minSeverity: "info",       // Log everything in production
  bufferSize: 50,             // Flush after 50 entries
  flushIntervalMs: 2000,      // Or every 2 seconds
  serviceName: "blok-api",
});

// Log ALL authentication attempts
// Log ALL authorization decisions
// Log ALL workflow executions
// Log ALL configuration changes
// Log ALL security events
```

### Configure Sentry

```typescript
import { SentryIntegration } from "@blok/runner";

const sentry = new SentryIntegration({
  dsn: process.env.SENTRY_DSN!,
  environment: process.env.NODE_ENV || "production",
  release: `blok@${process.env.APP_VERSION}`,
  tracesSampleRate: 0.1,    // 10% of transactions
  sampleRate: 1.0,           // 100% of errors
  tags: {
    service: "blok-api",
    region: process.env.AWS_REGION || "unknown",
  },
});

await sentry.init();
```

### Configure Structured Logging

```typescript
import { StructuredLogger } from "@blok/runner";

const logger = new StructuredLogger({
  service: "blok-api",
  environment: process.env.NODE_ENV || "production",
});

// All logs are JSON-structured for machine parsing
// Compatible with Grafana Loki, ELK Stack, CloudWatch Logs, DataDog
```

### Set Up Alerts

```yaml
# Prometheus alert rules (alerting-rules.yml)
groups:
  - name: blok-security
    rules:
      - alert: HighAuthFailureRate
        expr: rate(blok_workflow_errors_total{type="auth"}[5m]) > 0.1
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "High authentication failure rate"
          description: "Auth failures exceeding 10% over 5 minutes"

      - alert: CircuitBreakerOpen
        expr: blok_circuit_breaker_state == 1
        for: 1m
        labels:
          severity: warning
        annotations:
          summary: "Circuit breaker is open"
          description: "{{ $labels.dependency }} circuit breaker has opened"

      - alert: HighErrorRate
        expr: rate(blok_workflow_errors_total[5m]) / rate(blok_workflow_executions_total[5m]) > 0.05
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Workflow error rate exceeding 5%"

      - alert: SlowWorkflows
        expr: histogram_quantile(0.99, rate(blok_workflow_duration_seconds_bucket[5m])) > 10
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "P99 workflow latency exceeding 10 seconds"

      - alert: HighMemoryUsage
        expr: process_resident_memory_bytes > 400 * 1024 * 1024
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Memory usage exceeding 400MB"

      - alert: AuditLogGap
        expr: time() - blok_audit_last_flush_timestamp > 60
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Audit logs not flushing -- potential data loss"
```

---

## Dependency Security

### Snyk Scanning

```yaml
# .github/workflows/security.yml
name: Security Scan
on:
  push:
    branches: [main]
  pull_request:
  schedule:
    - cron: "0 6 * * 1"   # Weekly Monday scan

jobs:
  snyk:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: snyk/actions/node@master
        env:
          SNYK_TOKEN: ${{ secrets.SNYK_TOKEN }}
        with:
          args: --severity-threshold=high --all-projects

  npm-audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: corepack enable && pnpm install --frozen-lockfile
      - run: pnpm audit --audit-level=high

  container-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Build image
        run: docker build -t blok-api:scan .
      - name: Trivy scan
        uses: aquasecurity/trivy-action@master
        with:
          image-ref: "blok-api:scan"
          format: "table"
          exit-code: "1"
          severity: "CRITICAL,HIGH"
```

### Dependabot Configuration

```yaml
# .github/dependabot.yml
version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "weekly"
      day: "monday"
    open-pull-requests-limit: 10
    reviewers:
      - "security-team"
    labels:
      - "dependencies"
      - "security"
    ignore:
      # Don't auto-update major versions
      - dependency-name: "*"
        update-types: ["version-update:semver-major"]
```

### License Compliance

```bash
# Check licenses of all dependencies
npx license-checker --production --failOn "GPL-3.0;AGPL-3.0;SSPL-1.0"

# Export license report
npx license-checker --production --json > license-report.json
```

---

## Secrets Management

### Vault Integration

```typescript
import { SecretManager, VaultSecretProvider } from "@blok/runner";

// Production Vault configuration
const secrets = new SecretManager({
  providers: [
    {
      type: "vault",
      config: {
        address: process.env.VAULT_ADDR!,
        token: process.env.VAULT_TOKEN,  // From K8s service account or IAM
        namespace: "production",
        mountPath: "secret",
        apiVersion: "v1",
      },
    },
  ],
  cache: {
    enabled: true,
    ttlMs: 300_000,  // 5-minute cache
    maxSize: 500,
  },
  auditLog: true,
});

// Monitor all secret access
secrets.on("secretAccess", (event) => {
  audit.logSecurityEvent({
    action: `secret.${event.operation}`,
    severity: event.success ? "info" : "error",
    details: {
      key: event.key,
      provider: event.provider,
      cached: event.cached,
      error: event.error,
    },
  });
});
```

### Key Rotation Schedule

| Secret Type | Rotation Frequency | Automated | Procedure |
|---|---|---|---|
| JWT signing secret | 90 days | Yes | Generate new secret, deploy, invalidate old tokens |
| API keys | 365 days or on compromise | Semi-auto | Issue new key, update clients, revoke old key |
| Database password | 90 days | Yes | Vault dynamic secrets or manual rotation |
| Encryption keys | Annually | Semi-auto | `encryption.rotateKey()`, re-encrypt data |
| TLS certificates | 90 days (Let's Encrypt) | Yes | cert-manager or ACME |
| Vault token | 768 hours (32 days) | Yes | Vault token renewal |
| OIDC client secret | 365 days | No | Rotate in IdP, update SecretManager |

### Encryption at Rest for Secrets

```typescript
import { EncryptionAtRest, SecretManager } from "@blok/runner";

const encryption = new EncryptionAtRest({
  algorithm: "aes-256-gcm",
  keyDerivation: { iterations: 100_000, saltLength: 16, digest: "sha512" },
});

// Encrypt sensitive configuration before storing
const encryptedConfig = encryption.encryptObject(
  { databaseUrl: "postgres://...", apiKey: "sk_..." },
  masterKey,
);

// Key rotation
const rotatedConfig = encryption.rotateKey(encryptedConfig, oldMasterKey, newMasterKey);
```

---

## Data Protection

### PII Scanning

```typescript
// Scan all data leaving the system boundary
const piiDetector = new PIIDetector({
  customPatterns: [
    // Add organization-specific patterns
    { name: "internal_id", pattern: /\bEMP-\d{6}\b/g, category: "custom" },
  ],
  sensitiveFieldNames: [
    ...DEFAULT_SENSITIVE_FIELDS,
    "employee_id", "manager_name",
  ],
  onDetection: "log",
}, audit);

// Middleware to scan outgoing responses
app.use((req, res, next) => {
  const originalJson = res.json.bind(res);
  res.json = (body: any) => {
    if (body && typeof body === "object") {
      const scan = piiDetector.scan(body, `response:${req.path}`);
      if (scan.hasPII) {
        logger.warn("PII detected in response", {
          path: req.path,
          findings: scan.findings.length,
        });
      }
    }
    return originalJson(body);
  };
  next();
});
```

### Data Masking in Logs

```typescript
import { StructuredLogger } from "@blok/runner";

const logger = new StructuredLogger({
  service: "blok-api",
  environment: "production",
});

// NEVER log sensitive data
// WRONG:
// logger.info("User created", { email: user.email, password: user.password });

// CORRECT:
logger.info("User created", { userId: user.id, email: maskEmail(user.email) });

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  return `${local[0]}***@${domain}`;
}

function maskValue(value: string): string {
  if (value.length <= 4) return "****";
  return value.slice(0, 2) + "*".repeat(value.length - 4) + value.slice(-2);
}
```

### Encryption for Sensitive Data

```typescript
import { EncryptionAtRest } from "@blok/runner";

const encryption = new EncryptionAtRest({
  algorithm: "aes-256-gcm",
  keyDerivation: { iterations: 100_000, saltLength: 16, digest: "sha512" },
});

// Encrypt sensitive fields before database storage
async function storeUserProfile(user: UserProfile, key: string): Promise<void> {
  const sensitiveFields = {
    ssn: user.ssn,
    dateOfBirth: user.dateOfBirth,
    bankAccount: user.bankAccount,
  };

  const encryptedFields = encryption.encryptObject(sensitiveFields, key);

  await db.users.upsert({
    id: user.id,
    name: user.name,          // Not encrypted (needed for display)
    email: user.email,        // Not encrypted (needed for login)
    encryptedData: encryptedFields,
    encryptionVersion: "v1",
  });
}
```

---

## Kubernetes Hardening

### Network Policies

```yaml
# Restrict inter-pod communication
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: blok-api-policy
  namespace: production
spec:
  podSelector:
    matchLabels:
      app: blok-api
  policyTypes:
    - Ingress
    - Egress
  ingress:
    # Allow traffic from ingress controller only
    - from:
        - namespaceSelector:
            matchLabels:
              name: ingress-nginx
      ports:
        - protocol: TCP
          port: 8080
    # Allow Prometheus scraping
    - from:
        - namespaceSelector:
            matchLabels:
              name: monitoring
      ports:
        - protocol: TCP
          port: 9090
  egress:
    # Allow DNS
    - to:
        - namespaceSelector: {}
      ports:
        - protocol: UDP
          port: 53
    # Allow database access
    - to:
        - podSelector:
            matchLabels:
              app: postgres
      ports:
        - protocol: TCP
          port: 5432
    # Allow Vault access
    - to:
        - namespaceSelector:
            matchLabels:
              name: vault
      ports:
        - protocol: TCP
          port: 8200
    # Allow external HTTPS (for OIDC, Sentry, etc.)
    - to:
        - ipBlock:
            cidr: 0.0.0.0/0
      ports:
        - protocol: TCP
          port: 443
```

### Pod Security

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: blok-api
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: blok-api
  template:
    metadata:
      labels:
        app: blok-api
    spec:
      serviceAccountName: blok-api
      automountServiceAccountToken: false  # Don't mount unless needed
      securityContext:
        runAsNonRoot: true
        runAsUser: 1001
        runAsGroup: 1001
        fsGroup: 1001
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: blok-api
          image: blok-api:1.0.0
          ports:
            - containerPort: 8080
              name: http
            - containerPort: 9090
              name: metrics
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop:
                - ALL
          resources:
            requests:
              cpu: 250m
              memory: 256Mi
            limits:
              cpu: "1"
              memory: 512Mi
          env:
            - name: NODE_ENV
              value: "production"
            - name: VAULT_ADDR
              value: "https://vault.vault.svc.cluster.local:8200"
          volumeMounts:
            - name: tmp
              mountPath: /tmp
            - name: audit-logs
              mountPath: /var/log/blok
          livenessProbe:
            httpGet:
              path: /liveness
              port: 8080
            initialDelaySeconds: 10
            periodSeconds: 15
          readinessProbe:
            httpGet:
              path: /readiness
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 10
      volumes:
        - name: tmp
          emptyDir:
            sizeLimit: 64Mi
        - name: audit-logs
          persistentVolumeClaim:
            claimName: blok-audit-logs
```

### Secrets Encryption in Kubernetes

```yaml
# Encryption configuration for Kubernetes secrets at rest
# /etc/kubernetes/encryption-config.yaml
apiVersion: apiserver.config.k8s.io/v1
kind: EncryptionConfiguration
resources:
  - resources:
      - secrets
    providers:
      - aescbc:
          keys:
            - name: key1
              secret: <base64-encoded-32-byte-key>
      - identity: {}
```

### Pod Security Standards

```yaml
# Enforce restricted pod security standard
apiVersion: v1
kind: Namespace
metadata:
  name: production
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/enforce-version: latest
    pod-security.kubernetes.io/warn: restricted
    pod-security.kubernetes.io/warn-version: latest
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/audit-version: latest
```

---

## Incident Response Playbook

### Playbook 1: Authentication Bypass Detected

**Trigger:** Alert on unauthorized access without valid credentials

```
1. CONTAIN
   - Enable emergency rate limiting on affected endpoints
   - Block suspicious IP addresses
   - Rotate all JWT secrets and API keys

2. INVESTIGATE
   - Query audit logs for affected time window:
     auditSink.query({ category: "auth", severity: "warn", since: alertTime })
   - Identify attack vector and affected users
   - Check for data exfiltration

3. REMEDIATE
   - Patch the vulnerability
   - Force re-authentication for all active sessions
   - Update AuthMiddleware configuration

4. COMMUNICATE
   - Notify security team immediately
   - Notify affected users within 72 hours
   - File incident report
```

### Playbook 2: Data Exfiltration Suspected

**Trigger:** Unusual data access patterns or volume

```
1. CONTAIN
   - Temporarily disable external API access
   - Enable circuit breaker for data-serving workflows
   - Capture network traffic for analysis

2. INVESTIGATE
   - Query audit logs for high-volume access:
     auditSink.query({ category: "system", action: "data_access" })
   - Review PIIDetector findings
   - Trace request path through DistributedTracer

3. REMEDIATE
   - Revoke compromised credentials
   - Patch data access controls
   - Enable additional PIIDetector patterns

4. COMMUNICATE
   - Notify DPO / CISO
   - Determine regulatory notification requirements (GDPR 72h, HIPAA 60d)
   - Prepare breach notification if needed
```

### Playbook 3: Dependency Vulnerability (Critical)

**Trigger:** Snyk/Dependabot alert for critical vulnerability

```
1. ASSESS
   - Determine if vulnerability is exploitable in your configuration
   - Check if affected code path is reachable

2. REMEDIATE (within 24 hours for critical)
   - Update affected dependency
   - Run full test suite
   - Deploy through CI/CD pipeline

3. VERIFY
   - Run vulnerability scan after deployment
   - Monitor for exploitation attempts

4. DOCUMENT
   - Log the vulnerability and remediation in incident tracker
```

---

## Security Scanning Schedule

| Scan Type | Frequency | Tool | Scope | SLA (Critical) |
|---|---|---|---|---|
| Dependency vulnerability | Continuous (CI/CD) | Snyk | All dependencies | 24 hours |
| Container image scan | Every build | Trivy | Docker images | 24 hours |
| Static analysis (SAST) | Every PR | CodeQL / SonarQube | Application code | Before merge |
| Dynamic analysis (DAST) | Weekly | OWASP ZAP | Running application | 1 week |
| Infrastructure scan | Weekly | Checkov / tfsec | Terraform/K8s configs | 1 week |
| Penetration test | Annually | Third-party | Full application | 30 days |
| Secret scanning | Continuous | GitLeaks / TruffleHog | Git repository | Immediate |
| License compliance | Monthly | license-checker | All dependencies | 30 days |
| Certificate expiry | Daily | cert-manager | TLS certificates | 7 days before expiry |

### Automated Scanning Integration

```yaml
# .github/workflows/security-scan.yml
name: Security Scans
on:
  push:
    branches: [main, develop]
  pull_request:
  schedule:
    - cron: "0 2 * * *"   # Daily at 2 AM

jobs:
  dependency-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: snyk/actions/node@master
        env:
          SNYK_TOKEN: ${{ secrets.SNYK_TOKEN }}

  secret-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: gitleaks/gitleaks-action@v2
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

  sast:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: github/codeql-action/init@v3
        with:
          languages: typescript
      - uses: github/codeql-action/analyze@v3

  container-scan:
    runs-on: ubuntu-latest
    if: github.event_name == 'push'
    steps:
      - uses: actions/checkout@v4
      - run: docker build -t blok-api:scan .
      - uses: aquasecurity/trivy-action@master
        with:
          image-ref: "blok-api:scan"
          severity: "CRITICAL,HIGH"
          exit-code: "1"
```
