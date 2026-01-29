# HIPAA Compliance Toolkit for Blok

This guide provides a comprehensive toolkit for achieving HIPAA (Health Insurance Portability and Accountability Act) compliance when building healthcare applications with the Blok framework. It covers the Security Rule, Privacy Rule, and Breach Notification Rule requirements.

---

## Table of Contents

- [Overview](#overview)
  - [Protected Health Information (PHI)](#protected-health-information-phi)
  - [HIPAA Rules Applicable to Software Systems](#hipaa-rules-applicable-to-software-systems)
- [Administrative Safeguards](#administrative-safeguards)
  - [Security Management Process](#security-management-process)
  - [Workforce Security](#workforce-security)
  - [Information Access Management](#information-access-management)
- [Physical Safeguards](#physical-safeguards)
  - [Facility Access Controls](#facility-access-controls)
  - [Workstation and Device Security](#workstation-and-device-security)
- [Technical Safeguards](#technical-safeguards)
  - [Access Controls](#access-controls)
  - [Audit Controls](#audit-controls)
  - [Integrity Controls](#integrity-controls)
  - [Transmission Security](#transmission-security)
- [PHI Encryption at Rest](#phi-encryption-at-rest)
- [PHI Encryption in Transit](#phi-encryption-in-transit)
- [PHI Detection with PIIDetector](#phi-detection-with-piidetector)
- [HIPAA Audit Trail](#hipaa-audit-trail)
- [Business Associate Agreement (BAA) Requirements](#business-associate-agreement-baa-requirements)
- [Breach Notification Procedures](#breach-notification-procedures)
- [Risk Assessment Template](#risk-assessment-template)

---

## Overview

### Protected Health Information (PHI)

PHI is any individually identifiable health information that is created, received, maintained, or transmitted by a covered entity or business associate. This includes:

| PHI Category | Examples |
|---|---|
| **Demographic** | Name, address, date of birth, Social Security Number |
| **Medical** | Diagnoses, treatment plans, lab results, prescriptions |
| **Financial** | Insurance information, billing records, payment history |
| **Identifiers** | Medical record numbers, health plan IDs, account numbers |
| **Electronic PHI (ePHI)** | Any PHI stored, processed, or transmitted electronically |

### HIPAA Rules Applicable to Software Systems

| Rule | Requirement | Blok Support |
|---|---|---|
| **Security Rule** | Protect ePHI with administrative, physical, and technical safeguards | AuthMiddleware, RBAC, EncryptionAtRest, AuditLogger |
| **Privacy Rule** | Control use and disclosure of PHI | RBAC policies, consent workflows, audit logging |
| **Breach Notification Rule** | Notify affected individuals and HHS of breaches | SentryIntegration, AuditLogger, alerting stack |

---

## Administrative Safeguards

### Security Management Process

HIPAA requires a formal risk management process. Blok supports this through:

```typescript
import {
  AuditLogger,
  FileAuditSink,
  ConsoleAuditSink,
  RBAC,
  SecretManager,
} from "@nanoservice-ts/runner";

// Centralized security management configuration
const securityConfig = {
  // Risk analysis results drive these configurations
  auditLogger: new AuditLogger({
    sinks: [
      new ConsoleAuditSink(),
      new FileAuditSink({ path: "/var/log/blok/hipaa-audit.log" }),
    ],
    minSeverity: "info",      // Log everything for HIPAA
    bufferSize: 50,            // Flush frequently
    flushIntervalMs: 2000,     // 2-second flush interval
    serviceName: "blok-hipaa",
  }),

  secretManager: new SecretManager({
    providers: [
      {
        type: "vault",
        config: {
          address: process.env.VAULT_ADDR!,
          token: process.env.VAULT_TOKEN,
          namespace: "hipaa-production",
          mountPath: "secret",
        },
      },
    ],
    cache: { enabled: true, ttlMs: 60_000, maxSize: 200 },
    auditLog: true,
  }),
};

// Monitor secret access for HIPAA compliance
securityConfig.secretManager.on("secretAccess", (event) => {
  securityConfig.auditLogger.logSecurityEvent({
    action: `secret.${event.operation}`,
    severity: event.success ? "info" : "error",
    details: {
      key: event.key,
      provider: event.provider,
      cached: event.cached,
      hipaaRelevant: true,
    },
  });
});
```

### Workforce Security

Implement workforce access controls using RBAC:

```typescript
import { RBAC, createDefaultRBAC } from "@nanoservice-ts/runner";

const rbac = new RBAC();

// HIPAA workforce roles
rbac.addRole({
  name: "physician",
  description: "Licensed physician -- full PHI access for treatment",
  permissions: [
    { resource: "phi", actions: ["read", "create", "update"] },
    { resource: "patient_record", actions: ["read", "create", "update"] },
    { resource: "prescription", actions: ["read", "create"] },
    { resource: "lab_results", actions: ["read"] },
  ],
});

rbac.addRole({
  name: "nurse",
  description: "Registered nurse -- PHI access for care coordination",
  permissions: [
    { resource: "phi", actions: ["read"] },
    { resource: "patient_record", actions: ["read", "update"] },
    { resource: "vitals", actions: ["read", "create"] },
    { resource: "lab_results", actions: ["read"] },
  ],
});

rbac.addRole({
  name: "billing-clerk",
  description: "Billing staff -- limited PHI for payment processing",
  permissions: [
    { resource: "billing_record", actions: ["read", "create", "update"] },
    { resource: "insurance_info", actions: ["read"] },
    { resource: "patient_demographics", actions: ["read"] },
    // No access to clinical PHI
  ],
});

rbac.addRole({
  name: "it-admin",
  description: "IT administrator -- system access, no PHI content",
  permissions: [
    { resource: "system_config", actions: ["*"] },
    { resource: "audit_logs", actions: ["read"] },
    { resource: "user_accounts", actions: ["*"] },
    // No direct PHI access
  ],
});

rbac.addRole({
  name: "researcher",
  description: "Researcher -- de-identified data only",
  permissions: [
    { resource: "deidentified_data", actions: ["read"] },
    { resource: "aggregate_reports", actions: ["read"] },
    // No access to identifiable PHI
  ],
});

// Enforce separation of duties
rbac.addRole({
  name: "privacy-officer",
  description: "HIPAA Privacy Officer -- audit and compliance oversight",
  permissions: [
    { resource: "audit_logs", actions: ["read"] },
    { resource: "access_reports", actions: ["read", "create"] },
    { resource: "breach_reports", actions: ["*"] },
    { resource: "consent_records", actions: ["read"] },
  ],
});
```

### Information Access Management

```typescript
import { AuthMiddleware, OAuthOIDCProvider, RBAC, AuditLogger } from "@nanoservice-ts/runner";

// Access management middleware
const auth = new AuthMiddleware({
  providers: [
    new OAuthOIDCProvider({
      issuerUrl: process.env.OIDC_ISSUER!,
      clientId: process.env.OIDC_CLIENT_ID!,
      audience: "hipaa-api",
      rolesClaim: "roles",
    }),
  ],
  excludePaths: ["/health-check", "/health", "/readiness", "/liveness"],
  required: true,
  onAuthFailure: (result, request) => {
    audit.logAuth({
      action: "login",
      success: false,
      ip: request.headers["x-forwarded-for"] as string,
      error: result.error,
    });
  },
});

// PHI access authorization
function authorizePHIAccess(
  identity: AuthIdentity,
  resource: string,
  action: string,
  patientId: string,
  audit: AuditLogger,
): boolean {
  const result = rbac.canAny(identity.roles, resource, action as any);

  // Log ALL PHI access attempts (required by HIPAA)
  audit.logAuthz({
    action: `phi.${action}`,
    resource: { type: resource, id: patientId, name: `patient:${patientId}` },
    roles: identity.roles,
    allowed: result.allowed,
    actor: { sub: identity.sub, name: identity.name, ip: identity.claims.ip as string },
  });

  return result.allowed;
}

// Usage in Express route
app.get("/patients/:id/records", async (req, res) => {
  const identity = req.auth!;
  const patientId = req.params.id;

  if (!authorizePHIAccess(identity, "patient_record", "read", patientId, audit)) {
    return res.status(403).json({ error: "Access denied to patient record" });
  }

  // Retrieve and return patient record
  const record = await getPatientRecord(patientId);
  res.json(record);
});
```

---

## Physical Safeguards

### Facility Access Controls

While Blok is a software framework, it supports documentation and enforcement of physical controls:

```typescript
// Log physical access events through the audit system
audit.logSecurityEvent({
  action: "physical_access",
  severity: "info",
  details: {
    facility: "data-center-us-east-1",
    accessType: "badge_entry",
    zone: "server-room",
    authorized: true,
  },
  actor: { sub: "employee-001", ip: "10.0.0.1" },
});
```

### Workstation and Device Security

```typescript
// Enforce device compliance checks in authentication flow
const apiKeyAuth = new APIKeyAuthProvider({
  keys: new Map(),
  validate: async (key) => {
    const device = await db.devices.findByApiKey(key);
    if (!device) return null;

    // Verify device compliance
    if (!device.encrypted || !device.mdmEnrolled || device.osOutdated) {
      audit.logSecurityEvent({
        action: "device_compliance_failure",
        severity: "warn",
        details: {
          deviceId: device.id,
          encrypted: device.encrypted,
          mdmEnrolled: device.mdmEnrolled,
          osOutdated: device.osOutdated,
        },
      });
      return null; // Deny access from non-compliant devices
    }

    return { name: device.name, roles: device.roles };
  },
});
```

---

## Technical Safeguards

### Access Controls

HIPAA requires unique user identification, emergency access, automatic logoff, and encryption.

```typescript
import {
  AuthMiddleware,
  JWTAuthProvider,
  OAuthOIDCProvider,
  RBAC,
} from "@nanoservice-ts/runner";

// Unique User Identification (164.312(a)(2)(i))
// Every request is authenticated with a unique identity
const auth = new AuthMiddleware({
  providers: [
    new OAuthOIDCProvider({
      issuerUrl: process.env.OIDC_ISSUER!,
      clientId: "hipaa-app",
      audience: "hipaa-api",
    }),
  ],
  required: true,
});

// Emergency Access Procedure (164.312(a)(2)(ii))
// Break-glass access for emergencies
const emergencyAuth = new JWTAuthProvider({
  secret: process.env.EMERGENCY_JWT_SECRET!,
  issuer: "hipaa-emergency",
  rolesClaim: "roles",
});

async function requestEmergencyAccess(
  requestor: string,
  patientId: string,
  reason: string,
  audit: AuditLogger,
): Promise<string> {
  // Log emergency access with critical severity
  audit.logSecurityEvent({
    action: "emergency_access_granted",
    severity: "critical",
    details: {
      patientId,
      reason,
      hipaaReference: "164.312(a)(2)(ii)",
      requiresReview: true,
    },
    actor: { sub: requestor },
  });

  // Generate time-limited emergency token
  // (In production, use a proper JWT library for signing)
  return generateEmergencyToken(requestor, patientId, 3600); // 1-hour expiry
}

// Automatic Logoff (164.312(a)(2)(iii))
// Configure short JWT expiration for HIPAA sessions
const jwtAuth = new JWTAuthProvider({
  secret: process.env.JWT_SECRET!,
  clockToleranceSec: 0, // Strict expiration enforcement
});
// JWT tokens should have max 15-minute expiry for HIPAA workstations

// Encryption and Decryption (164.312(a)(2)(iv))
// See PHI Encryption sections below
```

### Audit Controls

HIPAA requires comprehensive audit trails for all PHI access:

```typescript
import {
  AuditLogger,
  FileAuditSink,
  ConsoleAuditSink,
  InMemoryAuditSink,
} from "@nanoservice-ts/runner";

// HIPAA-compliant audit logger configuration
const hipaaAudit = new AuditLogger({
  sinks: [
    // Production: tamper-evident file logging
    new FileAuditSink({ path: "/var/log/blok/hipaa-audit.log" }),
    // Real-time: console output for SIEM ingestion
    new ConsoleAuditSink(),
  ],
  includeRequestId: true,
  minSeverity: "info",     // Log everything -- HIPAA requires comprehensive audit trails
  bufferSize: 25,           // Flush frequently for real-time audit
  flushIntervalMs: 1000,    // 1-second flush interval
  serviceName: "blok-hipaa",
});

// Required HIPAA audit events
interface HIPAAAuditEvent {
  // WHO accessed the data
  userId: string;
  userRole: string;
  userName: string;

  // WHAT was accessed
  resourceType: "phi" | "patient_record" | "prescription" | "lab_result" | "billing";
  resourceId: string;
  patientId: string;

  // WHEN it was accessed
  timestamp: string;

  // HOW it was accessed
  action: "view" | "create" | "modify" | "delete" | "print" | "export" | "transmit";
  accessMethod: "web" | "api" | "mobile" | "hl7" | "fhir";

  // WHY it was accessed (for treatment, payment, or operations)
  purpose: "treatment" | "payment" | "operations" | "research" | "emergency";

  // Success or failure
  outcome: "success" | "failure";
  failureReason?: string;
}

function logHIPAAAccess(event: HIPAAAuditEvent, audit: AuditLogger): void {
  audit.log({
    category: event.outcome === "failure" ? "security" : "system",
    severity: event.outcome === "failure" ? "warn" : "info",
    action: `phi.${event.action}`,
    success: event.outcome === "success",
    actor: {
      sub: event.userId,
      name: event.userName,
    },
    resource: {
      type: event.resourceType,
      id: event.resourceId,
      name: `patient:${event.patientId}`,
    },
    details: {
      userRole: event.userRole,
      patientId: event.patientId,
      purpose: event.purpose,
      accessMethod: event.accessMethod,
      hipaaRelevant: true,
    },
  });
}

// Example: Log every PHI view
logHIPAAAccess({
  userId: "dr-smith-001",
  userRole: "physician",
  userName: "Dr. Smith",
  resourceType: "patient_record",
  resourceId: "record-12345",
  patientId: "patient-67890",
  timestamp: new Date().toISOString(),
  action: "view",
  accessMethod: "web",
  purpose: "treatment",
  outcome: "success",
}, hipaaAudit);
```

### Integrity Controls

Ensure ePHI is not improperly altered or destroyed:

```typescript
import { EncryptionAtRest } from "@nanoservice-ts/runner";

// AES-256-GCM provides authenticated encryption
// The GCM auth tag ensures data integrity -- tampered data will fail decryption
const encryption = new EncryptionAtRest({
  algorithm: "aes-256-gcm",  // Authenticated encryption
  keyDerivation: { iterations: 100_000, saltLength: 16, digest: "sha512" },
});

// Encrypt with integrity protection
const payload = encryption.encrypt(JSON.stringify(patientRecord), encryptionKey);
// payload.tag = GCM authentication tag -- any modification will cause decryption failure

// Verify integrity on read
try {
  const record = encryption.decrypt(payload, encryptionKey);
  // If decryption succeeds, integrity is verified
} catch (error) {
  // Integrity violation detected
  hipaaAudit.logSecurityEvent({
    action: "integrity_violation",
    severity: "critical",
    details: {
      resourceType: "patient_record",
      resourceId: payload.keyId,
      error: error.message,
      hipaaReference: "164.312(c)(1)",
    },
  });
}
```

### Transmission Security

Protect ePHI during electronic transmission:

```typescript
// TLS configuration for HIPAA-compliant transmission
import { createServer } from "node:https";
import { readFileSync } from "node:fs";

const hipaaTLSConfig = {
  key: readFileSync("/etc/tls/private/hipaa-server.key"),
  cert: readFileSync("/etc/tls/certs/hipaa-server.crt"),
  ca: readFileSync("/etc/tls/certs/hipaa-ca.crt"),

  // HIPAA requires strong encryption
  minVersion: "TLSv1.2" as const,
  maxVersion: "TLSv1.3" as const,

  // FIPS 140-2 compliant cipher suites
  ciphers: [
    "TLS_AES_256_GCM_SHA384",
    "TLS_AES_128_GCM_SHA256",
    "ECDHE-RSA-AES256-GCM-SHA384",
    "ECDHE-RSA-AES128-GCM-SHA256",
  ].join(":"),

  honorCipherOrder: true,

  // Require client certificates for mTLS (BAA partners)
  requestCert: true,
  rejectUnauthorized: true,
};

const server = createServer(hipaaTLSConfig, app);
```

---

## PHI Encryption at Rest

All ePHI must be encrypted at rest using strong encryption:

```typescript
import { EncryptionAtRest } from "@nanoservice-ts/runner";
import { SecretManager } from "@nanoservice-ts/runner";

// HIPAA-compliant encryption configuration
const encryption = new EncryptionAtRest({
  algorithm: "aes-256-gcm",
  keyDerivation: {
    iterations: 100_000,  // NIST SP 800-132 recommended minimum
    saltLength: 16,        // 128-bit random salt
    digest: "sha512",      // SHA-512 for key derivation
  },
  encoding: "base64",
});

// Retrieve encryption keys from HIPAA-compliant key management
const secrets = new SecretManager({
  providers: [
    {
      type: "vault",
      config: {
        address: process.env.VAULT_ADDR!,
        token: process.env.VAULT_TOKEN,
        namespace: "hipaa",
        mountPath: "secret",
      },
    },
  ],
  cache: { enabled: true, ttlMs: 60_000, maxSize: 100 },
  auditLog: true,
});

const phiEncryptionKey = await secrets.getSecretOrThrow("PHI_ENCRYPTION_KEY");

// Encrypt a patient record
interface PatientRecord {
  patientId: string;
  name: string;
  dateOfBirth: string;
  ssn: string;
  diagnosis: string[];
  medications: string[];
  insuranceId: string;
}

const record: PatientRecord = {
  patientId: "P-12345",
  name: "John Doe",
  dateOfBirth: "1985-03-15",
  ssn: "123-45-6789",
  diagnosis: ["Type 2 Diabetes", "Hypertension"],
  medications: ["Metformin 500mg", "Lisinopril 10mg"],
  insuranceId: "INS-9876543",
};

// Encrypt the entire PHI record
const encryptedRecord = encryption.encryptObject(record, phiEncryptionKey);

// Store encrypted string in database
await db.patientRecords.upsert({
  patientId: record.patientId,
  encryptedData: encryptedRecord,
  encryptionKeyVersion: "v1",
  lastModified: new Date().toISOString(),
});

// Decrypt when needed by authorized user
const decrypted = encryption.decryptObject<PatientRecord>(encryptedRecord, phiEncryptionKey);

// Key rotation (annual or as required)
const newKey = await secrets.getSecretOrThrow("PHI_ENCRYPTION_KEY_V2");
const rotatedRecord = encryption.rotateKey(encryptedRecord, phiEncryptionKey, newKey);
```

---

## PHI Encryption in Transit

```typescript
// Ensure all PHI transmission uses TLS 1.2+
// See the Transmission Security section above for TLS configuration

// For inter-service communication, use mTLS
const mtlsConfig = {
  key: readFileSync("/etc/tls/private/service.key"),
  cert: readFileSync("/etc/tls/certs/service.crt"),
  ca: readFileSync("/etc/tls/certs/internal-ca.crt"),
  minVersion: "TLSv1.2" as const,
  requestCert: true,
  rejectUnauthorized: true,
};

// For FHIR/HL7 integrations, ensure transport encryption
// Log all PHI transmissions
function logPHITransmission(
  sender: string,
  recipient: string,
  dataType: string,
  recordCount: number,
  audit: AuditLogger,
): void {
  audit.log({
    category: "system",
    severity: "info",
    action: "phi_transmission",
    success: true,
    actor: { sub: sender },
    resource: { type: "phi_transmission", id: `tx-${Date.now()}` },
    details: {
      recipient,
      dataType,
      recordCount,
      encryptionProtocol: "TLS 1.2+",
      hipaaReference: "164.312(e)(1)",
    },
  });
}
```

---

## PHI Detection with PIIDetector

Extend the PIIDetector with HIPAA-specific patterns for PHI detection:

```typescript
import { AuditLogger } from "@nanoservice-ts/runner";

// HIPAA-specific PHI patterns
const HIPAA_PHI_PATTERNS = [
  // Standard PII patterns
  { name: "email", pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, category: "identifier" },
  { name: "phone", pattern: /(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g, category: "identifier" },
  { name: "ssn", pattern: /\b\d{3}-\d{2}-\d{4}\b/g, category: "identifier" },

  // HIPAA-specific identifiers (18 identifiers per Safe Harbor)
  { name: "medical_record_number", pattern: /\bMRN[-:]?\s*\d{6,10}\b/gi, category: "medical_identifier" },
  { name: "health_plan_id", pattern: /\b(?:HPB|HPI|HPID)[-:]?\s*\d{6,12}\b/gi, category: "medical_identifier" },
  { name: "npi", pattern: /\bNPI[-:]?\s*\d{10}\b/gi, category: "medical_identifier" },
  { name: "dea_number", pattern: /\b[ABCDFGHJMPRSTabcdfghjmprst][A-Za-z]\d{7}\b/g, category: "medical_identifier" },

  // ICD-10 diagnosis codes (may identify conditions)
  { name: "icd10", pattern: /\b[A-Z]\d{2}(?:\.\d{1,4})?\b/g, category: "medical_data" },

  // NDC drug codes
  { name: "ndc", pattern: /\b\d{4,5}-\d{3,4}-\d{1,2}\b/g, category: "medical_data" },

  // Date of birth patterns
  { name: "date_of_birth", pattern: /\b(?:DOB|Date of Birth|Birth Date)[:.]?\s*\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/gi, category: "identifier" },
];

// HIPAA-sensitive field names
const HIPAA_SENSITIVE_FIELDS = [
  // 18 HIPAA identifiers
  "name", "first_name", "last_name", "full_name",
  "address", "street_address", "city", "zip_code", "postal_code",
  "date_of_birth", "dob", "birth_date",
  "phone", "phone_number", "fax", "fax_number",
  "email", "email_address",
  "ssn", "social_security_number", "social_security",
  "medical_record_number", "mrn",
  "health_plan_id", "insurance_id",
  "account_number", "patient_id",
  "certificate_number", "license_number",
  "vehicle_id", "vin",
  "device_identifier", "serial_number",
  "biometric", "fingerprint", "face_photo",
  "ip_address",

  // Clinical data fields
  "diagnosis", "diagnoses", "icd_code",
  "medication", "medications", "prescription",
  "lab_result", "lab_results", "test_result",
  "procedure", "surgery",
  "allergy", "allergies",
  "vital_signs", "blood_pressure", "heart_rate",
  "insurance_info", "payer", "coverage",
];

// PHI detector class for HIPAA
class HIPAAPHIDetector {
  private patterns: typeof HIPAA_PHI_PATTERNS;
  private sensitiveFields: Set<string>;
  private audit: AuditLogger;

  constructor(audit: AuditLogger, customPatterns?: typeof HIPAA_PHI_PATTERNS) {
    this.patterns = [...HIPAA_PHI_PATTERNS, ...(customPatterns || [])];
    this.sensitiveFields = new Set(HIPAA_SENSITIVE_FIELDS.map(f => f.toLowerCase()));
    this.audit = audit;
  }

  /**
   * Scan data for PHI before it leaves the system boundary
   */
  scanForPHI(data: Record<string, unknown>, context: string): PHIScanResult {
    const findings: PHIFinding[] = [];
    this.scanObject(data, "", findings);

    if (findings.length > 0) {
      this.audit.logSecurityEvent({
        action: "phi_detected",
        severity: "warn",
        details: {
          context,
          findingsCount: findings.length,
          categories: [...new Set(findings.map(f => f.category))],
          fieldPaths: findings.map(f => f.fieldPath),
          hipaaReference: "164.502(a)",
        },
      });
    }

    return {
      containsPHI: findings.length > 0,
      findings,
      safeHarborCompliant: findings.length === 0,
    };
  }

  /**
   * De-identify data per HIPAA Safe Harbor method (164.514(b))
   */
  deidentify(data: Record<string, unknown>): Record<string, unknown> {
    return JSON.parse(JSON.stringify(data, (key, value) => {
      if (this.sensitiveFields.has(key.toLowerCase())) {
        return "[DE-IDENTIFIED]";
      }
      if (typeof value === "string") {
        for (const pattern of this.patterns) {
          pattern.pattern.lastIndex = 0;
          if (pattern.pattern.test(value)) {
            return "[DE-IDENTIFIED]";
          }
        }
      }
      return value;
    }));
  }

  private scanObject(obj: unknown, path: string, findings: PHIFinding[]): void {
    if (obj === null || obj === undefined) return;

    if (typeof obj === "string") {
      for (const pattern of this.patterns) {
        pattern.pattern.lastIndex = 0;
        if (pattern.pattern.test(obj)) {
          findings.push({ fieldPath: path, category: pattern.category, patternName: pattern.name });
        }
      }
    } else if (Array.isArray(obj)) {
      obj.forEach((item, index) => this.scanObject(item, `${path}[${index}]`, findings));
    } else if (typeof obj === "object") {
      for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
        const fieldPath = path ? `${path}.${key}` : key;
        if (this.sensitiveFields.has(key.toLowerCase())) {
          findings.push({ fieldPath, category: "field_match", patternName: `field:${key}` });
        }
        this.scanObject(value, fieldPath, findings);
      }
    }
  }
}

interface PHIScanResult {
  containsPHI: boolean;
  findings: PHIFinding[];
  safeHarborCompliant: boolean;
}

interface PHIFinding {
  fieldPath: string;
  category: string;
  patternName: string;
}
```

**Usage example:**

```typescript
const phiDetector = new HIPAAPHIDetector(hipaaAudit);

// Scan data before sending to external systems
const outgoingData = { patientName: "John Doe", diagnosis: "E11.9", ssn: "123-45-6789" };
const scanResult = phiDetector.scanForPHI(outgoingData, "external-api-call");

if (scanResult.containsPHI) {
  // Option 1: Block transmission
  throw new Error("PHI detected in outgoing data -- transmission blocked");

  // Option 2: De-identify before sending
  const deidentified = phiDetector.deidentify(outgoingData);
  // deidentified = { patientName: "[DE-IDENTIFIED]", diagnosis: "[DE-IDENTIFIED]", ssn: "[DE-IDENTIFIED]" }
}
```

---

## HIPAA Audit Trail

HIPAA requires maintaining audit logs for a minimum of 6 years:

```typescript
import { AuditLogger, FileAuditSink, ConsoleAuditSink } from "@nanoservice-ts/runner";

// HIPAA audit configuration with long-term retention
const hipaaAudit = new AuditLogger({
  sinks: [
    // Primary: append-only log file with daily rotation
    new FileAuditSink({
      path: `/var/log/blok/hipaa-audit-${new Date().toISOString().split("T")[0]}.log`,
    }),
    // Secondary: console for real-time SIEM ingestion
    new ConsoleAuditSink(),
    // Tertiary: custom sink for long-term archival (S3, Azure Blob, GCS)
    // Implement a custom AuditSink that writes to cloud storage
  ],
  includeRequestId: true,
  minSeverity: "info",
  bufferSize: 25,
  flushIntervalMs: 1000,
  serviceName: "blok-hipaa-ehr",
});

// HIPAA-required audit event types
const HIPAA_AUDIT_EVENTS = {
  // Access events (164.312(b))
  PHI_ACCESS: "phi.access",
  PHI_CREATE: "phi.create",
  PHI_MODIFY: "phi.modify",
  PHI_DELETE: "phi.delete",
  PHI_EXPORT: "phi.export",
  PHI_PRINT: "phi.print",

  // Authentication events (164.312(d))
  LOGIN_SUCCESS: "auth.login.success",
  LOGIN_FAILURE: "auth.login.failure",
  LOGOUT: "auth.logout",
  PASSWORD_CHANGE: "auth.password_change",
  MFA_CHALLENGE: "auth.mfa_challenge",

  // Authorization events (164.312(a))
  ACCESS_GRANTED: "authz.granted",
  ACCESS_DENIED: "authz.denied",
  EMERGENCY_ACCESS: "authz.emergency",

  // System events
  CONFIG_CHANGE: "system.config_change",
  ENCRYPTION_KEY_ROTATION: "system.key_rotation",
  BACKUP_CREATED: "system.backup",
  SYSTEM_START: "system.start",
  SYSTEM_STOP: "system.stop",
};
```

### Audit Retention Policy

| Retention Requirement | Period | Storage |
|---|---|---|
| HIPAA minimum | 6 years | Cloud archival (S3 Glacier, Azure Cool, GCS Nearline) |
| Active audit logs | 90 days | Hot storage for real-time query |
| Security incident logs | 6 years + duration of investigation | Immutable storage |
| Access logs | 6 years | Compressed archival |

---

## Business Associate Agreement (BAA) Requirements

Any entity that creates, receives, maintains, or transmits ePHI on behalf of a covered entity must sign a BAA.

### BAA Required Elements

1. **Permitted uses and disclosures** -- Define exactly how the BA may use PHI
2. **Safeguards obligation** -- BA must implement appropriate safeguards
3. **Reporting requirement** -- BA must report breaches and security incidents
4. **Subcontractor requirement** -- BA must ensure subcontractors agree to same restrictions
5. **Access provision** -- BA must make PHI available for data subject access requests
6. **Amendment provision** -- BA must make PHI available for amendments
7. **Accounting of disclosures** -- BA must document disclosures
8. **HHS audit access** -- BA must make practices available for government audit
9. **Return/destroy obligation** -- BA must return or destroy PHI at contract termination
10. **Individual enforcement** -- BA is directly liable for compliance

### Blok Sub-Processor BAA Checklist

| Sub-Processor | BAA Required | Status | Notes |
|---|---|---|---|
| HashiCorp Vault | Yes (if cloud-hosted) | [ ] Executed | Self-hosted option available |
| AWS (Secrets Manager, CloudWatch) | Yes | [ ] Executed | AWS BAA available |
| GCP (Secret Manager) | Yes | [ ] Executed | Google Cloud BAA available |
| Sentry | Yes (if PHI in error reports) | [ ] Executed | Or self-host Sentry |
| Monitoring (Prometheus/Grafana) | No (if self-hosted, no PHI in metrics) | N/A | Self-host recommended |

---

## Breach Notification Procedures

### HIPAA Breach Notification Requirements

| Affected Individuals | Notification Timeline | Notification Method |
|---|---|---|
| Fewer than 500 | Within 60 days of discovery | Written notice to individuals |
| 500 or more | Within 60 days of discovery | Written notice + media notification + HHS |
| Any number | Annual log to HHS for breaches <500 | HHS breach portal |

### Breach Response Workflow

```typescript
interface HIPAABreachReport {
  breachId: string;
  discoveredAt: string;
  occurredAt?: string;
  reportedToHHSAt?: string;
  notifiedIndividualsAt?: string;

  nature: string;
  phiTypes: string[];
  individualCount: number;

  // Risk assessment factors (for breach determination)
  dataCompromised: string;
  unauthorizedRecipient: string;
  dataAcquired: boolean;
  mitigationSteps: string[];

  // Notifications
  hhsNotified: boolean;
  individualsNotified: boolean;
  mediaNotified: boolean; // Required if 500+ individuals
}

async function handleHIPAABreach(
  report: HIPAABreachReport,
  audit: AuditLogger,
): Promise<void> {
  // Log the breach with critical severity
  audit.logSecurityEvent({
    action: "hipaa_breach_detected",
    severity: "critical",
    details: {
      breachId: report.breachId,
      nature: report.nature,
      phiTypes: report.phiTypes,
      individualCount: report.individualCount,
      hipaaReference: "164.400-414",
    },
  });

  // Conduct 4-factor risk assessment
  const riskAssessment = {
    factor1_nature: report.dataCompromised,       // Nature and extent of PHI
    factor2_recipient: report.unauthorizedRecipient, // Who accessed it
    factor3_acquired: report.dataAcquired,        // Was PHI actually acquired/viewed?
    factor4_mitigation: report.mitigationSteps,   // Risk mitigation measures
  };

  audit.log({
    category: "security",
    severity: "critical",
    action: "breach_risk_assessment",
    success: true,
    details: riskAssessment,
  });

  // Determine if notification is required
  // (Low probability of compromise may not require notification)
  const notificationRequired = riskAssessment.factor3_acquired; // Simplified

  if (notificationRequired) {
    // Notify HHS within 60 days
    // Notify affected individuals within 60 days
    // Notify media if 500+ individuals affected
    if (report.individualCount >= 500) {
      audit.log({
        category: "security",
        severity: "critical",
        action: "breach_media_notification_required",
        success: true,
        details: { individualCount: report.individualCount },
      });
    }
  }
}
```

---

## Risk Assessment Template

HIPAA requires periodic risk assessments (164.308(a)(1)(ii)(A)).

### Risk Assessment Methodology

#### 1. System Characterization

| Item | Description |
|---|---|
| **System name** | Blok Healthcare Application |
| **System description** | Workflow orchestration platform processing ePHI |
| **System boundary** | API servers, databases, message queues, monitoring |
| **Data classification** | ePHI -- Protected Health Information |
| **Users** | Physicians, nurses, billing staff, IT administrators |

#### 2. Threat Identification

| Threat | Source | Likelihood | Impact |
|---|---|---|---|
| Unauthorized access to ePHI | External attacker | Medium | High |
| Insider threat (workforce member) | Internal employee | Low | High |
| Malware/ransomware | External attacker | Medium | Critical |
| Data loss during transmission | Network failure | Low | High |
| System unavailability | Infrastructure failure | Medium | Medium |
| Improper disposal of ePHI | Process failure | Low | High |
| Social engineering | External attacker | Medium | High |

#### 3. Vulnerability Assessment

| Vulnerability | Current Controls | Gap | Remediation |
|---|---|---|---|
| Weak authentication | AuthMiddleware + OIDC | None -- multi-factor via OIDC | Maintain OIDC configuration |
| Excessive privileges | RBAC roles defined | Review quarterly | Quarterly access review |
| Unencrypted ePHI at rest | EncryptionAtRest (AES-256-GCM) | None | Annual key rotation |
| Unencrypted ePHI in transit | TLS 1.2+ required | None | Certificate renewal automation |
| Insufficient audit logging | AuditLogger with FileAuditSink | Archival >6 years needed | Implement cloud archival sink |
| Missing PHI detection | HIPAAPHIDetector implemented | Custom patterns needed | Add org-specific patterns |
| Secret exposure | SecretManager with Vault | None | Quarterly rotation |

#### 4. Risk Determination Matrix

| Likelihood / Impact | Low Impact | Medium Impact | High Impact | Critical Impact |
|---|---|---|---|---|
| **High** | Medium | High | High | Critical |
| **Medium** | Low | Medium | High | High |
| **Low** | Low | Low | Medium | High |

#### 5. Control Recommendations

| Risk | Current Risk Level | Recommended Control | Target Risk Level |
|---|---|---|---|
| Unauthorized access | Medium | Enable MFA via OIDC, enforce RBAC | Low |
| Data breach | High | EncryptionAtRest + PHI detection + monitoring | Low |
| Insider threat | Medium | Audit logging + quarterly access review | Low |
| System unavailability | Medium | Health checks + circuit breaker + redundancy | Low |
| Compliance gap | Medium | Automated compliance checks + DPIA | Low |

#### 6. Sign-off

| Role | Name | Date | Signature |
|---|---|---|---|
| HIPAA Security Officer | _______________ | ________ | _________ |
| HIPAA Privacy Officer | _______________ | ________ | _________ |
| CTO / System Owner | _______________ | ________ | _________ |
| Legal Counsel | _______________ | ________ | _________ |
