# Module Reference: Security

> **Path:** `core/runner/src/security/`
> **Purpose:** Enterprise-grade authentication, authorization, encryption, and compliance

## What It Does

The security module provides a comprehensive set of enterprise security features including authentication (JWT, API keys, OAuth), authorization (RBAC, ABAC), secret management (Vault, AWS, GCP, Azure), encryption, audit logging, PII detection, and TLS configuration.

## Source Files

```
core/runner/src/security/
├── index.ts                # Barrel export of all security modules
├── AuthMiddleware.ts       # JWT + API key authentication (417 lines)
├── OAuthProvider.ts        # OAuth 2.0 / OIDC provider (1010 lines)
├── RBAC.ts                 # Role-Based Access Control (360 lines)
├── ABAC.ts                 # Attribute-Based Access Control (567 lines)
├── SecretManager.ts        # Multi-provider secret management (1534 lines)
├── AuditLogger.ts          # Audit trail logging (466 lines)
├── EncryptionAtRest.ts     # AES-256 data encryption (321 lines)
├── PIIDetector.ts          # PII detection and redaction (466 lines)
└── TLSConfig.ts            # TLS/mTLS configuration (719 lines)
```

## Components

### AuthMiddleware
- **Purpose:** Validates incoming requests via JWT tokens or API keys
- **Features:**
  - JWT token validation (HS256, RS256)
  - API key validation (header-based)
  - Custom auth header configuration
  - Token refresh support
  - Rate limiting per auth identity

### OAuthProvider
- **Purpose:** Full OAuth 2.0 / OpenID Connect implementation
- **Features:**
  - Authorization Code flow
  - Client Credentials flow
  - Token introspection
  - JWKS support
  - Multiple provider support (Google, GitHub, Azure AD, custom)
  - Token caching

### RBAC (Role-Based Access Control)
- **Purpose:** Restrict workflow/node access based on user roles
- **Features:**
  - Role definitions with permissions
  - Hierarchical roles (admin inherits manager permissions)
  - Per-workflow access control
  - Per-node access control
  - Role assignment API

### ABAC (Attribute-Based Access Control)
- **Purpose:** Fine-grained access control based on attributes
- **Features:**
  - Policy-based evaluation
  - User attributes (role, department, clearance level)
  - Resource attributes (classification, owner, type)
  - Environment attributes (time, IP, location)
  - Boolean expressions with AND/OR/NOT operators
  - Policy caching for performance

### SecretManager
- **Purpose:** Centralized secret management with multi-provider support
- **Providers:**
  - HashiCorp Vault
  - AWS Secrets Manager
  - GCP Secret Manager
  - Azure Key Vault
  - Environment variables (fallback)
- **Features:**
  - Secret rotation
  - Caching with TTL
  - Audit logging
  - Secret versioning

### AuditLogger
- **Purpose:** Immutable audit trail for compliance
- **Features:**
  - Who did what, when, and from where
  - Structured log format (JSON)
  - Multiple output targets (file, syslog, cloud)
  - Tamper-evident logging
  - Retention policies

### EncryptionAtRest
- **Purpose:** Encrypt sensitive data at rest
- **Features:**
  - AES-256-GCM encryption
  - Key derivation (PBKDF2/scrypt)
  - Key rotation support
  - Envelope encryption

### PIIDetector
- **Purpose:** Detect and redact personally identifiable information
- **Features:**
  - Pattern-based detection (email, phone, SSN, credit card)
  - Custom pattern definitions
  - Automatic redaction/masking
  - Configurable sensitivity levels
  - Scanning of request/response bodies

### TLSConfig
- **Purpose:** TLS and mutual TLS (mTLS) configuration
- **Features:**
  - Certificate management
  - mTLS client verification
  - Certificate rotation
  - Cipher suite configuration
  - Protocol version enforcement

## Tests

```
core/runner/src/__tests__/security/
├── ABAC.test.ts               (947 lines)
├── AuditLogger.test.ts        (317 lines)
├── AuthMiddleware.test.ts     (445 lines)
├── OAuthProvider.test.ts      (983 lines)
├── RBAC.test.ts               (276 lines)
└── SecretManager.test.ts      (1318 lines)
```

## What to Document

1. **Security architecture overview** — How all pieces fit together
2. **Authentication setup** — JWT, API keys, OAuth configuration
3. **Authorization patterns** — RBAC vs ABAC, when to use which
4. **Secret management** — Provider setup, secret rotation
5. **Encryption configuration** — At rest and in transit
6. **Audit logging** — Setup, querying, compliance
7. **PII compliance** — Detection patterns, redaction rules
8. **TLS/mTLS setup** — Certificate management, mutual auth
9. **Security best practices** — Hardening guide
