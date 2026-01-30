# GDPR Compliance Toolkit for Blok

This guide provides a comprehensive toolkit for achieving and maintaining GDPR (General Data Protection Regulation) compliance when building applications with the Blok framework. It covers data protection principles, technical implementations, and operational procedures.

---

## Table of Contents

- [Overview](#overview)
- [Data Processing Principles](#data-processing-principles)
- [Personal Data Identification with PIIDetector](#personal-data-identification-with-piidetector)
- [Data Subject Rights Implementation](#data-subject-rights-implementation)
  - [Right of Access (Article 15)](#right-of-access-article-15)
  - [Right to Rectification (Article 16)](#right-to-rectification-article-16)
  - [Right to Erasure (Article 17)](#right-to-erasure-article-17)
  - [Right to Data Portability (Article 20)](#right-to-data-portability-article-20)
  - [Right to Object (Article 21)](#right-to-object-article-21)
- [Data Protection by Design](#data-protection-by-design)
  - [Encryption at Rest](#encryption-at-rest)
  - [Encryption in Transit](#encryption-in-transit)
  - [Access Control](#access-control)
- [Consent Management Patterns](#consent-management-patterns)
- [Data Breach Notification Procedures](#data-breach-notification-procedures)
- [Data Processing Agreement Template](#data-processing-agreement-template)
- [Cross-Border Transfer Mechanisms](#cross-border-transfer-mechanisms)
- [Record of Processing Activities (ROPA)](#record-of-processing-activities-ropa)
- [Data Protection Impact Assessment (DPIA)](#data-protection-impact-assessment-dpia)

---

## Overview

The GDPR applies to any organization processing personal data of EU/EEA residents. Blok provides built-in primitives that support GDPR compliance:

| GDPR Requirement | Blok Feature | Module Path |
|---|---|---|
| Data protection by design | `EncryptionAtRest`, TLS configuration | `core/runner/src/security/EncryptionAtRest.ts` |
| Access control | `AuthMiddleware`, `RBAC` | `core/runner/src/security/AuthMiddleware.ts`, `core/runner/src/security/RBAC.ts` |
| Audit trail | `AuditLogger` with multiple sinks | `core/runner/src/security/AuditLogger.ts` |
| Secret management | `SecretManager` with Vault/AWS/GCP providers | `core/runner/src/security/SecretManager.ts` |
| Personal data identification | `PIIDetector` patterns | Custom implementation |
| Breach detection | `SentryIntegration`, `StructuredLogger` | `core/runner/src/integrations/SentryIntegration.ts` |
| Monitoring | `PrometheusMetricsBridge`, `CloudWatchIntegration` | `core/runner/src/monitoring/`, `core/runner/src/integrations/` |

---

## Data Processing Principles

GDPR Article 5 defines seven data processing principles. Here is how Blok helps address each:

### 1. Lawfulness, Fairness, and Transparency

**Implementation:** Document your legal basis for processing and expose it to data subjects.

```typescript
import { AuditLogger, ConsoleAuditSink, FileAuditSink } from "@blok/runner";

// Log every data processing activity with its legal basis
const audit = new AuditLogger({
  sinks: [
    new ConsoleAuditSink(),
    new FileAuditSink({ path: "/var/log/blok/gdpr-audit.log" }),
  ],
  serviceName: "blok-gdpr",
});

// Record the legal basis for each data processing operation
audit.log({
  category: "system",
  severity: "info",
  action: "data_processing",
  success: true,
  details: {
    legalBasis: "consent",          // consent | contract | legal_obligation | vital_interests | public_task | legitimate_interests
    consentId: "consent-abc-123",
    purpose: "order_fulfillment",
    dataCategories: ["name", "email", "shipping_address"],
    dataSubject: "user-456",
  },
  resource: { type: "personal_data", id: "processing-001" },
});
```

### 2. Purpose Limitation

Process data only for specified, explicit, and legitimate purposes.

```typescript
import { RBAC } from "@blok/runner";

const rbac = new RBAC();

// Define purpose-specific roles
rbac.addRole({
  name: "marketing-processor",
  description: "Can only access data for marketing purposes",
  permissions: [
    { resource: "user_profile", actions: ["read"], conditions: { purpose: "marketing" } },
    { resource: "consent_records", actions: ["read"] },
  ],
});

rbac.addRole({
  name: "order-processor",
  description: "Can access data for order fulfillment",
  permissions: [
    { resource: "user_profile", actions: ["read"], conditions: { purpose: "order_fulfillment" } },
    { resource: "order_data", actions: ["read", "create", "update"] },
    { resource: "shipping_data", actions: ["read", "create"] },
  ],
});
```

### 3. Data Minimization

Collect only the data that is necessary for the specified purpose.

```typescript
// Workflow design pattern: strip unnecessary fields before processing
// In your Blok workflow configuration, define explicit input/output contracts
// that enforce minimal data passing between nodes.

// Example: A node that strips non-essential fields
function minimizeUserData(userData: Record<string, unknown>, purpose: string): Record<string, unknown> {
  const fieldsForPurpose: Record<string, string[]> = {
    order_fulfillment: ["name", "email", "shippingAddress"],
    marketing: ["email", "preferences"],
    analytics: ["anonymizedId", "region"],
  };

  const allowed = fieldsForPurpose[purpose] || [];
  const minimized: Record<string, unknown> = {};
  for (const field of allowed) {
    if (field in userData) {
      minimized[field] = userData[field];
    }
  }
  return minimized;
}
```

### 4. Accuracy

Ensure personal data is accurate and kept up to date.

```typescript
// Use audit logging to track data modifications
audit.logConfigChange({
  action: "update",
  resourceType: "personal_data",
  resourceId: "user-456",
  actor: { sub: "user-456", name: "Data Subject" },
  details: {
    fieldsUpdated: ["email", "phone"],
    source: "data_subject_request",
    previousValues: "encrypted_reference_id",  // Store reference, not actual values
  },
});
```

### 5. Storage Limitation

Do not keep personal data longer than necessary.

```typescript
// Implement data retention policies using scheduled workflows
// Example: retention check pattern
async function enforceRetentionPolicy(
  secrets: SecretManager,
  audit: AuditLogger,
): Promise<void> {
  const retentionPeriodDays = 730; // 2 years
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retentionPeriodDays);

  // Query for expired records and schedule deletion
  // Log the retention enforcement action
  audit.log({
    category: "system",
    severity: "info",
    action: "retention_enforcement",
    success: true,
    details: {
      cutoffDate: cutoffDate.toISOString(),
      retentionPeriodDays,
      recordsScheduledForDeletion: 42,
    },
  });
}
```

### 6. Integrity and Confidentiality

Protect data with appropriate security measures.

```typescript
import { EncryptionAtRest } from "@blok/runner";

const encryption = new EncryptionAtRest({
  algorithm: "aes-256-gcm",
  keyDerivation: { iterations: 100_000, saltLength: 16, digest: "sha512" },
});

// Encrypt personal data before storage
const encryptedProfile = encryption.encryptObject(
  { name: "Jane Doe", email: "jane@example.com", dob: "1990-01-15" },
  encryptionKey,
);

// Decrypt only when needed by authorized users
const profile = encryption.decryptObject<UserProfile>(encryptedProfile, encryptionKey);
```

### 7. Accountability

Demonstrate compliance through documentation and audit trails.

```typescript
// Export complete audit trail for compliance reporting
const auditSink = new InMemoryAuditSink(100_000);

// Query audit records for a specific data subject
const subjectRecords = auditSink.query({
  actorSub: "user-456",
  since: "2025-01-01T00:00:00Z",
});

// Query all data processing activities
const processingActivities = auditSink.query({
  action: "data_processing",
  category: "system",
});
```

---

## Personal Data Identification with PIIDetector

Implement a PIIDetector to scan data flows and identify personal data automatically:

```typescript
/**
 * PII Detector for Blok workflows
 *
 * Scans data payloads for personally identifiable information
 * using configurable regex patterns and field name heuristics.
 */
interface PIIDetectorConfig {
  /** Custom patterns to detect in addition to built-in ones */
  customPatterns?: PIIPattern[];
  /** Field names that indicate PII (case-insensitive) */
  sensitiveFieldNames?: string[];
  /** Action to take when PII is detected */
  onDetection?: "log" | "mask" | "block";
}

interface PIIPattern {
  name: string;
  pattern: RegExp;
  category: "email" | "phone" | "ssn" | "credit_card" | "ip_address" | "custom";
}

const DEFAULT_PII_PATTERNS: PIIPattern[] = [
  { name: "email", pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, category: "email" },
  { name: "phone", pattern: /(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g, category: "phone" },
  { name: "ssn", pattern: /\b\d{3}-\d{2}-\d{4}\b/g, category: "ssn" },
  { name: "credit_card", pattern: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g, category: "credit_card" },
  { name: "ipv4", pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, category: "ip_address" },
];

const DEFAULT_SENSITIVE_FIELDS = [
  "email", "phone", "ssn", "social_security", "credit_card", "card_number",
  "password", "secret", "token", "dob", "date_of_birth", "address",
  "first_name", "last_name", "full_name", "ip_address", "passport",
  "driver_license", "national_id", "tax_id",
];

class PIIDetector {
  private patterns: PIIPattern[];
  private sensitiveFields: Set<string>;
  private onDetection: "log" | "mask" | "block";
  private audit: AuditLogger;

  constructor(config: PIIDetectorConfig, audit: AuditLogger) {
    this.patterns = [...DEFAULT_PII_PATTERNS, ...(config.customPatterns || [])];
    this.sensitiveFields = new Set(
      (config.sensitiveFieldNames || DEFAULT_SENSITIVE_FIELDS).map(f => f.toLowerCase())
    );
    this.onDetection = config.onDetection || "log";
    this.audit = audit;
  }

  /**
   * Scan a data object for PII
   */
  scan(data: Record<string, unknown>, context?: string): PIIScanResult {
    const findings: PIIFinding[] = [];

    this.scanObject(data, "", findings);

    if (findings.length > 0) {
      this.audit.logSecurityEvent({
        action: "pii_detected",
        severity: "warn",
        details: {
          context,
          findingsCount: findings.length,
          categories: [...new Set(findings.map(f => f.category))],
          fields: findings.map(f => f.fieldPath),
        },
      });
    }

    return { hasPII: findings.length > 0, findings };
  }

  /**
   * Mask PII in a data object (returns a deep copy with PII masked)
   */
  mask(data: Record<string, unknown>): Record<string, unknown> {
    return JSON.parse(JSON.stringify(data, (key, value) => {
      if (typeof value === "string") {
        for (const pattern of this.patterns) {
          if (pattern.pattern.test(value)) {
            pattern.pattern.lastIndex = 0;
            return "[REDACTED]";
          }
        }
      }
      if (this.sensitiveFields.has(key.toLowerCase()) && typeof value === "string") {
        return "[REDACTED]";
      }
      return value;
    }));
  }

  private scanObject(obj: unknown, path: string, findings: PIIFinding[]): void {
    if (obj === null || obj === undefined) return;

    if (typeof obj === "string") {
      for (const pattern of this.patterns) {
        pattern.pattern.lastIndex = 0;
        if (pattern.pattern.test(obj)) {
          findings.push({ fieldPath: path, category: pattern.category, patternName: pattern.name });
        }
      }
    } else if (typeof obj === "object") {
      for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
        const fieldPath = path ? `${path}.${key}` : key;
        if (this.sensitiveFields.has(key.toLowerCase())) {
          findings.push({ fieldPath, category: "custom", patternName: `field:${key}` });
        }
        this.scanObject(value, fieldPath, findings);
      }
    }
  }
}

interface PIIScanResult {
  hasPII: boolean;
  findings: PIIFinding[];
}

interface PIIFinding {
  fieldPath: string;
  category: string;
  patternName: string;
}
```

**Usage in workflows:**

```typescript
const piiDetector = new PIIDetector({ onDetection: "log" }, audit);

// Scan outgoing data before sending to third parties
const scanResult = piiDetector.scan(outgoingPayload, "third-party-api-call");
if (scanResult.hasPII) {
  // Mask PII before logging
  const maskedPayload = piiDetector.mask(outgoingPayload);
  logger.info("Outgoing request (masked)", { payload: maskedPayload });
}
```

---

## Data Subject Rights Implementation

### Right of Access (Article 15)

Data subjects can request a copy of all personal data held about them.

```typescript
import { AuditLogger, FileAuditSink } from "@blok/runner";

// Workflow: Handle Subject Access Request (SAR)
async function handleSubjectAccessRequest(
  subjectId: string,
  audit: AuditLogger,
): Promise<SubjectAccessResponse> {
  // Log the SAR
  audit.log({
    category: "system",
    severity: "info",
    action: "sar_received",
    success: true,
    actor: { sub: subjectId },
    resource: { type: "data_subject_request", id: `sar-${Date.now()}` },
    details: { requestType: "access", deadline: "30_days" },
  });

  // Collect all personal data from all data stores
  const personalData = {
    profile: await db.users.findById(subjectId),
    orders: await db.orders.findByUser(subjectId),
    consents: await db.consents.findByUser(subjectId),
    auditTrail: await db.auditLogs.findByActor(subjectId),
    preferences: await db.preferences.findByUser(subjectId),
  };

  // Log completion
  audit.log({
    category: "system",
    severity: "info",
    action: "sar_fulfilled",
    success: true,
    actor: { sub: subjectId },
    details: {
      dataCategoriesIncluded: Object.keys(personalData),
      recordCount: Object.values(personalData).flat().length,
    },
  });

  return {
    subjectId,
    exportDate: new Date().toISOString(),
    data: personalData,
    format: "JSON",
    retentionInfo: "Data is retained for 2 years after last activity",
    processingPurposes: ["order_fulfillment", "customer_support"],
    thirdPartyRecipients: ["payment-processor", "shipping-provider"],
  };
}

interface SubjectAccessResponse {
  subjectId: string;
  exportDate: string;
  data: Record<string, unknown>;
  format: string;
  retentionInfo: string;
  processingPurposes: string[];
  thirdPartyRecipients: string[];
}
```

### Right to Rectification (Article 16)

Data subjects can request correction of inaccurate personal data.

```typescript
async function handleRectificationRequest(
  subjectId: string,
  corrections: Record<string, unknown>,
  audit: AuditLogger,
): Promise<void> {
  // Log the rectification request
  audit.logConfigChange({
    action: "update",
    resourceType: "personal_data",
    resourceId: subjectId,
    actor: { sub: subjectId, name: "Data Subject" },
    details: {
      requestType: "rectification",
      fieldsToCorrect: Object.keys(corrections),
    },
  });

  // Apply corrections
  await db.users.update(subjectId, corrections);

  // Notify any third parties that received the incorrect data
  await notifyThirdParties(subjectId, corrections);

  // Log completion
  audit.log({
    category: "system",
    severity: "info",
    action: "rectification_completed",
    success: true,
    actor: { sub: subjectId },
    details: { fieldsUpdated: Object.keys(corrections) },
  });
}
```

### Right to Erasure (Article 17)

Data subjects can request deletion of their personal data ("right to be forgotten").

```typescript
async function handleErasureRequest(
  subjectId: string,
  audit: AuditLogger,
  secrets: SecretManager,
): Promise<ErasureResult> {
  const requestId = `erasure-${Date.now()}`;

  // Log the erasure request
  audit.log({
    category: "system",
    severity: "warn",
    action: "erasure_requested",
    success: true,
    actor: { sub: subjectId },
    resource: { type: "data_subject_request", id: requestId },
    details: { requestType: "erasure", deadline: "30_days" },
  });

  const results: Record<string, boolean> = {};

  // Delete from all data stores
  try {
    await db.users.delete(subjectId);
    results["user_profile"] = true;
  } catch { results["user_profile"] = false; }

  try {
    await db.orders.anonymize(subjectId);
    results["orders"] = true; // Anonymize rather than delete for financial records
  } catch { results["orders"] = false; }

  try {
    await db.consents.delete(subjectId);
    results["consents"] = true;
  } catch { results["consents"] = false; }

  try {
    await db.preferences.delete(subjectId);
    results["preferences"] = true;
  } catch { results["preferences"] = false; }

  // Delete any secrets associated with the user
  try {
    await secrets.deleteSecret(`user/${subjectId}/api-key`);
    results["secrets"] = true;
  } catch { results["secrets"] = false; }

  // Log completion
  audit.log({
    category: "system",
    severity: "warn",
    action: "erasure_completed",
    success: Object.values(results).every(Boolean),
    actor: { sub: "system" },
    resource: { type: "data_subject_request", id: requestId },
    details: { results, subjectId },
  });

  return {
    requestId,
    subjectId,
    completedAt: new Date().toISOString(),
    results,
    retainedData: ["anonymized_order_records"], // Financial records cannot be fully deleted
    retentionJustification: "Legal obligation: financial record retention requirement",
  };
}

interface ErasureResult {
  requestId: string;
  subjectId: string;
  completedAt: string;
  results: Record<string, boolean>;
  retainedData: string[];
  retentionJustification: string;
}
```

### Right to Data Portability (Article 20)

Data subjects can request their data in a structured, commonly used, machine-readable format.

```typescript
async function handlePortabilityRequest(
  subjectId: string,
  format: "json" | "csv",
  audit: AuditLogger,
): Promise<Buffer> {
  audit.log({
    category: "system",
    severity: "info",
    action: "portability_requested",
    success: true,
    actor: { sub: subjectId },
    details: { format },
  });

  // Collect all personal data provided by the data subject
  const personalData = {
    profile: await db.users.findById(subjectId),
    preferences: await db.preferences.findByUser(subjectId),
    content: await db.userContent.findByUser(subjectId),
  };

  let exportData: Buffer;
  if (format === "json") {
    exportData = Buffer.from(JSON.stringify(personalData, null, 2));
  } else {
    exportData = convertToCSV(personalData);
  }

  audit.log({
    category: "system",
    severity: "info",
    action: "portability_fulfilled",
    success: true,
    actor: { sub: subjectId },
    details: { format, sizeBytes: exportData.length },
  });

  return exportData;
}
```

### Right to Object (Article 21)

Data subjects can object to processing of their personal data.

```typescript
async function handleObjectionRequest(
  subjectId: string,
  processingPurpose: string,
  audit: AuditLogger,
): Promise<void> {
  audit.log({
    category: "system",
    severity: "warn",
    action: "processing_objection",
    success: true,
    actor: { sub: subjectId },
    details: { purpose: processingPurpose },
  });

  // Update processing consent records
  await db.consents.revoke(subjectId, processingPurpose);

  // Update RBAC to restrict processing
  // This prevents workflows from processing this user's data for the objected purpose
  await db.processingRestrictions.create({
    subjectId,
    restrictedPurpose: processingPurpose,
    restrictedAt: new Date().toISOString(),
    reason: "data_subject_objection",
  });
}
```

---

## Data Protection by Design

### Encryption at Rest

Protect all personal data stored in databases, files, or caches:

```typescript
import { EncryptionAtRest } from "@blok/runner";
import { SecretManager } from "@blok/runner";

const encryption = new EncryptionAtRest({
  algorithm: "aes-256-gcm",
  keyDerivation: { iterations: 100_000, saltLength: 16, digest: "sha512" },
  encoding: "base64",
});

const secrets = new SecretManager({
  providers: [
    { type: "vault", config: { address: process.env.VAULT_ADDR!, token: process.env.VAULT_TOKEN } },
  ],
  cache: { enabled: true, ttlMs: 300_000, maxSize: 100 },
});

// Retrieve encryption key from secure storage
const encryptionKey = await secrets.getSecretOrThrow("GDPR_ENCRYPTION_KEY");

// Encrypt personal data before storage
const encryptedRecord = encryption.encryptObject(
  {
    name: "Jane Doe",
    email: "jane@example.com",
    dateOfBirth: "1990-01-15",
    address: "123 Main St, Berlin, Germany",
  },
  encryptionKey,
);

// Store the encrypted string in your database
await db.users.updateEncryptedProfile(userId, encryptedRecord);

// Key rotation for compliance
const newKey = await secrets.getSecretOrThrow("GDPR_ENCRYPTION_KEY_V2");
const rotatedRecord = encryption.rotateKey(encryptedRecord, encryptionKey, newKey);
```

### Encryption in Transit

Ensure all data in transit is protected with TLS:

```typescript
// TLS configuration for Blok HTTP triggers
// Configure at the infrastructure level:

// Node.js HTTPS server configuration
import { createServer } from "node:https";
import { readFileSync } from "node:fs";

const tlsConfig = {
  key: readFileSync("/etc/tls/private/server.key"),
  cert: readFileSync("/etc/tls/certs/server.crt"),
  ca: readFileSync("/etc/tls/certs/ca.crt"),
  minVersion: "TLSv1.2" as const,    // Minimum TLS 1.2
  ciphers: [
    "TLS_AES_256_GCM_SHA384",
    "TLS_CHACHA20_POLY1305_SHA256",
    "ECDHE-RSA-AES256-GCM-SHA384",
  ].join(":"),
  honorCipherOrder: true,
};

const server = createServer(tlsConfig, app);
```

### Access Control

Combine authentication and RBAC for defense in depth:

```typescript
import { AuthMiddleware, OAuthOIDCProvider, RBAC, AuditLogger } from "@blok/runner";

const auth = new AuthMiddleware({
  providers: [
    new OAuthOIDCProvider({
      issuerUrl: "https://auth.example.com",
      clientId: "blok-gdpr-api",
      audience: "https://api.example.com",
      rolesClaim: "roles",
    }),
  ],
  required: true,
});

const rbac = new RBAC();

// GDPR-specific roles
rbac.addRole({
  name: "dpo",
  description: "Data Protection Officer -- full access to GDPR functions",
  permissions: [
    { resource: "personal_data", actions: ["read", "update", "delete"] },
    { resource: "data_subject_request", actions: ["*"] },
    { resource: "consent_records", actions: ["*"] },
    { resource: "audit_logs", actions: ["read"] },
  ],
});

rbac.addRole({
  name: "data-processor",
  description: "Can process personal data for authorized purposes",
  permissions: [
    { resource: "personal_data", actions: ["read"], conditions: { hasConsent: true } },
    { resource: "consent_records", actions: ["read"] },
  ],
});

rbac.addRole({
  name: "data-subject",
  description: "Can access and manage own personal data",
  permissions: [
    { resource: "personal_data", actions: ["read", "update"], resourcePattern: "self/*" },
    { resource: "data_subject_request", actions: ["create", "read"], resourcePattern: "self/*" },
    { resource: "consent_records", actions: ["read", "update"], resourcePattern: "self/*" },
  ],
});
```

---

## Consent Management Patterns

Implement granular consent management for GDPR compliance:

```typescript
interface ConsentRecord {
  id: string;
  subjectId: string;
  purpose: string;
  legalBasis: "consent" | "contract" | "legal_obligation" | "vital_interests" | "public_task" | "legitimate_interests";
  granted: boolean;
  grantedAt?: string;
  revokedAt?: string;
  expiresAt?: string;
  version: string;
  source: "web_form" | "api" | "mobile_app" | "email";
  ipAddress?: string;
  proofOfConsent?: string; // Reference to stored consent proof
}

// Consent management workflow
async function grantConsent(
  subjectId: string,
  purpose: string,
  source: ConsentRecord["source"],
  audit: AuditLogger,
): Promise<ConsentRecord> {
  const consent: ConsentRecord = {
    id: `consent-${Date.now()}`,
    subjectId,
    purpose,
    legalBasis: "consent",
    granted: true,
    grantedAt: new Date().toISOString(),
    version: "1.0",
    source,
  };

  await db.consents.create(consent);

  audit.log({
    category: "system",
    severity: "info",
    action: "consent_granted",
    success: true,
    actor: { sub: subjectId },
    resource: { type: "consent", id: consent.id },
    details: { purpose, source, version: consent.version },
  });

  return consent;
}

async function revokeConsent(
  subjectId: string,
  purpose: string,
  audit: AuditLogger,
): Promise<void> {
  const consent = await db.consents.findActive(subjectId, purpose);
  if (!consent) return;

  await db.consents.update(consent.id, {
    granted: false,
    revokedAt: new Date().toISOString(),
  });

  audit.log({
    category: "system",
    severity: "warn",
    action: "consent_revoked",
    success: true,
    actor: { sub: subjectId },
    resource: { type: "consent", id: consent.id },
    details: { purpose, originalGrantDate: consent.grantedAt },
  });

  // Trigger downstream data processing cessation
  await stopProcessingForPurpose(subjectId, purpose);
}
```

---

## Data Breach Notification Procedures

GDPR requires notification within 72 hours of becoming aware of a personal data breach.

### Breach Detection

```typescript
import { AuditLogger, SentryIntegration, StructuredLogger } from "@blok/runner";

// Configure real-time breach detection
const logger = new StructuredLogger({
  service: "blok-breach-detection",
  environment: "production",
});

// Monitor for breach indicators
function detectBreachIndicators(audit: AuditLogger): void {
  // Alert on: multiple failed auth attempts
  audit.logSecurityEvent({
    action: "breach_indicator",
    severity: "critical",
    details: {
      indicator: "mass_data_access",
      description: "Unusual volume of personal data access requests",
      affectedRecords: 10000,
      timeWindow: "5 minutes",
    },
  });
}
```

### Notification Timeline

| Timeline | Action | Responsible Party |
|---|---|---|
| **T+0** | Breach detected and confirmed | Security team |
| **T+4h** | Initial impact assessment completed | DPO + Security team |
| **T+24h** | Supervisory authority notification prepared | DPO |
| **T+48h** | Data subject notification prepared (if high risk) | DPO + Legal |
| **T+72h** | Supervisory authority notified | DPO |
| **T+7d** | Full investigation report | Security team |
| **T+30d** | Remediation measures implemented | Engineering team |

### Notification Template

```typescript
interface BreachNotification {
  breachId: string;
  detectedAt: string;
  reportedAt: string;
  nature: string;                    // Description of the breach
  categoriesAffected: string[];      // Types of personal data
  approximateSubjects: number;       // Number of data subjects affected
  consequencesAssessment: string;    // Likely consequences
  measuresTaken: string[];           // Measures taken to address the breach
  dpoContact: {
    name: string;
    email: string;
    phone: string;
  };
}
```

---

## Data Processing Agreement Template

When using Blok with third-party services (Vault, AWS, GCP), ensure DPAs are in place:

### DPA Outline

1. **Subject matter and duration** -- Define what data is processed and for how long
2. **Nature and purpose** -- Specify why the data is being processed
3. **Type of personal data** -- List categories (name, email, IP address, etc.)
4. **Categories of data subjects** -- Identify who the data belongs to (customers, employees, etc.)
5. **Controller obligations** -- Your responsibilities as the data controller
6. **Processor obligations** -- Sub-processor responsibilities including:
   - Process data only on documented instructions
   - Ensure confidentiality
   - Implement appropriate security measures
   - Assist with data subject rights requests
   - Delete or return data at end of processing
   - Allow and contribute to audits
7. **Sub-processors** -- List all sub-processors (cloud providers, monitoring services)
8. **International transfers** -- Document transfer mechanisms (SCCs, adequacy decisions)
9. **Breach notification** -- Processor must notify controller without undue delay
10. **Liability and indemnification** -- Allocation of liability

### Blok Sub-Processor Inventory

| Sub-Processor | Purpose | Data Categories | Transfer Mechanism |
|---|---|---|---|
| HashiCorp Vault | Secret storage | Encryption keys, API keys | Self-hosted / Cloud |
| AWS Secrets Manager | Secret storage | Encryption keys, API keys | AWS DPA + SCCs |
| GCP Secret Manager | Secret storage | Encryption keys, API keys | Google DPA + SCCs |
| Sentry | Error tracking | IP addresses, request metadata | Sentry DPA + SCCs |
| Prometheus/Grafana | Monitoring | Aggregated metrics (no PII) | Self-hosted |

---

## Cross-Border Transfer Mechanisms

When personal data is transferred outside the EU/EEA:

### Transfer Mechanism Decision Tree

1. **Adequacy decision exists?** (e.g., UK, Japan, South Korea) -> Transfer permitted
2. **Standard Contractual Clauses (SCCs)?** -> Execute SCCs with recipient
3. **Binding Corporate Rules?** -> For intra-group transfers
4. **Derogations (Article 49)?** -> Explicit consent, contract necessity, etc.

### Implementation with SecretManager Providers

```typescript
import { SecretManager } from "@blok/runner";

// Configure provider chain with geographic awareness
const secrets = new SecretManager({
  providers: [
    // Priority 1: EU-based Vault for GDPR compliance
    {
      type: "vault",
      config: {
        address: "https://vault.eu-west-1.internal:8200",
        token: process.env.VAULT_TOKEN,
        namespace: "eu-production",
      },
    },
    // Priority 2: AWS in EU region
    {
      type: "aws",
      config: {
        region: "eu-west-1", // Frankfurt region stays within EU
      },
    },
    // Priority 3: GCP in EU region
    {
      type: "gcp",
      config: {
        projectId: "my-eu-project",
      },
    },
  ],
  cache: { enabled: true, ttlMs: 300_000, maxSize: 500 },
  auditLog: true,
});
```

---

## Record of Processing Activities (ROPA)

GDPR Article 30 requires maintaining a record of processing activities.

### ROPA Template

| Field | Description | Example |
|---|---|---|
| **Controller** | Organization name and contact | Acme Corp, dpo@acme.com |
| **Processing activity** | Name of the activity | Customer order processing |
| **Purpose** | Why data is processed | Order fulfillment, delivery |
| **Legal basis** | GDPR legal basis | Article 6(1)(b) -- Contract |
| **Data categories** | Types of personal data | Name, email, address, phone |
| **Data subjects** | Who the data belongs to | Customers |
| **Recipients** | Who receives the data | Payment processor, shipping provider |
| **Transfers** | Cross-border transfers | EU SCCs with US payment processor |
| **Retention period** | How long data is kept | 2 years after last order |
| **Technical measures** | Security controls | AES-256-GCM encryption, RBAC, TLS 1.2+ |
| **Organizational measures** | Policies and procedures | Data protection policy, access review quarterly |

### Automated ROPA Generation

```typescript
interface ProcessingActivity {
  id: string;
  name: string;
  controller: { name: string; email: string; dpo: string };
  purpose: string;
  legalBasis: string;
  dataCategories: string[];
  dataSubjectCategories: string[];
  recipients: string[];
  transfers: { destination: string; mechanism: string }[];
  retentionPeriod: string;
  technicalMeasures: string[];
  organizationalMeasures: string[];
  lastReviewed: string;
}

// Register processing activities
const processingActivities: ProcessingActivity[] = [
  {
    id: "pa-001",
    name: "Customer Order Processing",
    controller: { name: "Acme Corp", email: "privacy@acme.com", dpo: "dpo@acme.com" },
    purpose: "Processing customer orders and delivering products",
    legalBasis: "Article 6(1)(b) - Performance of a contract",
    dataCategories: ["name", "email", "address", "phone", "payment_details"],
    dataSubjectCategories: ["customers"],
    recipients: ["payment-processor", "shipping-provider"],
    transfers: [{ destination: "US", mechanism: "Standard Contractual Clauses" }],
    retentionPeriod: "2 years after last order",
    technicalMeasures: [
      "AES-256-GCM encryption at rest (EncryptionAtRest)",
      "TLS 1.2+ in transit",
      "RBAC with least privilege (RBAC class)",
      "JWT + OIDC authentication (AuthMiddleware)",
      "Audit logging (AuditLogger with FileAuditSink)",
    ],
    organizationalMeasures: [
      "Data protection policy",
      "Staff training",
      "Quarterly access review",
      "Annual DPIA review",
    ],
    lastReviewed: "2026-01-15",
  },
];
```

---

## Data Protection Impact Assessment (DPIA)

Conduct a DPIA when processing is likely to result in a high risk to the rights and freedoms of data subjects.

### When is a DPIA Required?

- Systematic monitoring of publicly accessible areas
- Large-scale processing of special category data
- Automated decision-making with legal or significant effects
- Processing involving vulnerable individuals
- Innovative use of technology
- Processing that prevents data subjects from exercising a right

### DPIA Template

#### 1. Description of Processing

| Item | Details |
|---|---|
| **Processing name** | [Name of the processing activity] |
| **Data controller** | [Organization name] |
| **DPO contact** | [DPO email and phone] |
| **Processing description** | [Detailed description] |
| **Purpose** | [Why the processing is necessary] |
| **Legal basis** | [GDPR legal basis] |
| **Data types** | [Categories of personal data] |
| **Data subjects** | [Categories of individuals] |
| **Data flow** | [How data moves through the system] |

#### 2. Necessity and Proportionality

- Is the processing necessary for the stated purpose?
- Is the data collected proportionate to the purpose?
- Are there less intrusive alternatives?
- How is data quality ensured?
- What is the retention period?

#### 3. Risk Assessment

| Risk | Likelihood | Impact | Mitigation | Residual Risk |
|---|---|---|---|---|
| Unauthorized access | Medium | High | AuthMiddleware + RBAC + OIDC | Low |
| Data breach | Low | High | EncryptionAtRest + AuditLogger | Low |
| Excessive data collection | Medium | Medium | PIIDetector scanning | Low |
| Inadequate consent | Low | High | Consent management workflow | Low |
| Cross-border transfer | Medium | Medium | EU-based infrastructure + SCCs | Low |
| Insider threat | Low | High | RBAC + audit logging + access reviews | Low |

#### 4. Measures to Address Risks

```typescript
// Technical measures implemented via Blok:
const measures = {
  encryption: "AES-256-GCM via EncryptionAtRest (core/runner/src/security/EncryptionAtRest.ts)",
  accessControl: "RBAC with hierarchical roles (core/runner/src/security/RBAC.ts)",
  authentication: "Multi-provider auth via AuthMiddleware (core/runner/src/security/AuthMiddleware.ts)",
  auditTrail: "AuditLogger with FileAuditSink (core/runner/src/security/AuditLogger.ts)",
  secretManagement: "SecretManager with Vault/AWS/GCP (core/runner/src/security/SecretManager.ts)",
  monitoring: "PrometheusMetricsBridge + SentryIntegration + StructuredLogger",
  piiDetection: "PIIDetector with configurable patterns",
  dataMinimization: "Workflow-level input/output contracts",
};
```

#### 5. Sign-off

| Role | Name | Date | Signature |
|---|---|---|---|
| Data Protection Officer | _______________ | ________ | _________ |
| System Owner | _______________ | ________ | _________ |
| Security Lead | _______________ | ________ | _________ |
| Legal Counsel | _______________ | ________ | _________ |
