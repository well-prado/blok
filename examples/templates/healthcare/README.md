# Healthcare Industry Template

A production-ready collection of Blok workflows for building healthcare application backends. These templates cover patient onboarding, appointment scheduling, lab results processing, prescription management, and HIPAA-compliant data handling. All workflows are designed with PHI (Protected Health Information) security, audit logging, and regulatory compliance as first-class concerns.

## Included Workflows

### 1. Patient Onboarding (`patient-onboarding.json`)

Manages the complete patient registration and onboarding process, including identity verification, insurance eligibility checking, and electronic consent management.

**Trigger:** `POST /api/patients/onboard`

**Steps:**
1. **validate-patient-data** -- Validates the patient registration payload against FHIR-compatible schemas (demographics, contact information, emergency contacts, insurance details).
2. **verify-identity** -- Verifies the patient's identity using date of birth, SSN last-four, and government-issued ID document.
3. **check-duplicate** -- Searches the patient database using MPI (Master Patient Index) matching algorithms to prevent duplicate records.
4. **route-duplicate-check** -- If a matching record exists, returns the existing patient ID with a merge recommendation. Otherwise, continues with registration.
5. **verify-insurance** -- Calls the insurance eligibility API (e.g., Availity, Change Healthcare) to verify active coverage, copay amounts, and benefit details.
6. **create-patient-record** -- Creates the patient record in the EHR system with a unique MRN (Medical Record Number).
7. **generate-consent-forms** -- Generates electronic consent forms (treatment consent, HIPAA notice of privacy practices, telehealth consent) for the patient's signature.
8. **send-portal-invitation** -- Sends the patient a secure link to complete their registration, sign consent forms, and access the patient portal.
9. **log-audit-event** -- Records the onboarding event in the HIPAA audit log with the timestamp, actor, action, and affected PHI fields.

**Environment Variables:**
```
EHR_API_URL, EHR_API_KEY, INSURANCE_ELIGIBILITY_API_URL,
INSURANCE_API_KEY, PATIENT_PORTAL_URL, SENDGRID_API_KEY,
FROM_EMAIL, HIPAA_AUDIT_LOG_URL, INTERNAL_API_KEY
```

---

### 2. Appointment Scheduling (`appointment-scheduling.json`)

Handles appointment creation, provider availability checking, conflict resolution, and automated reminders.

**Trigger:** `* /api/appointments/:action`

**Steps:**
1. **route-action** -- Routes based on the action parameter:
   - `POST /create` -- Creates a new appointment.
   - `PUT /reschedule` -- Reschedules an existing appointment.
   - `POST /cancel` -- Cancels an appointment with reason tracking.
   - `GET /availability` -- Returns available slots for a provider and date range.
2. **check-provider-availability** -- Queries the scheduling system for the provider's available time slots, accounting for existing appointments, blocked time, and buffer periods.
3. **check-patient-conflicts** -- Verifies the patient does not have overlapping appointments.
4. **verify-insurance-authorization** -- For procedure-based appointments, checks if the patient's insurance requires prior authorization and verifies it is on file.
5. **create-appointment** -- Creates the appointment record with the provider, patient, location, visit type, and duration.
6. **send-confirmation** -- Sends the patient an appointment confirmation via their preferred channel (email, SMS, or patient portal notification).
7. **schedule-reminders** -- Queues automated reminders at configured intervals (72 hours, 24 hours, and 2 hours before the appointment).
8. **update-provider-calendar** -- Syncs the appointment to the provider's calendar system.
9. **log-audit-event** -- Records the scheduling action in the HIPAA audit log.

**Environment Variables:**
```
SCHEDULING_API_URL, EHR_API_URL, INSURANCE_AUTH_API_URL,
CALENDAR_SYNC_API_URL, NOTIFICATION_SERVICE_URL,
REMINDER_QUEUE_URL, HIPAA_AUDIT_LOG_URL, INTERNAL_API_KEY
```

---

### 3. Lab Results Processing (`lab-results-processing.json`)

Processes incoming lab results from laboratory information systems (LIS), applies clinical decision rules, and routes results to the ordering provider for review.

**Trigger:** `POST /api/lab-results/process`

**Steps:**
1. **validate-hl7-message** -- Validates and parses the incoming HL7 ORU (Observation Result) message or FHIR DiagnosticReport resource.
2. **match-patient** -- Matches the lab result to the correct patient record using the MRN, name, and date of birth from the message.
3. **match-order** -- Links the result to the original lab order in the EHR system.
4. **apply-reference-ranges** -- Evaluates each result value against age- and sex-specific reference ranges and flags abnormal or critical values.
5. **route-critical-values** -- Routes based on result severity:
   - **Normal** -- Files the result and notifies the ordering provider during normal workflow.
   - **Abnormal** -- Flags the result for expedited provider review.
   - **Critical** -- Triggers immediate notification of the ordering provider via phone or pager, with escalation if not acknowledged within 30 minutes.
6. **store-results** -- Persists the structured lab results in the patient's chart in the EHR system.
7. **notify-provider** -- Sends the ordering provider a notification with result summary and direct link to the full report.
8. **notify-patient** -- If the practice has enabled patient lab result access, queues the result for release to the patient portal (with a configurable provider review delay).
9. **log-audit-event** -- Records the result processing event, including chain of custody and notification timestamps, in the HIPAA audit log.

**Environment Variables:**
```
EHR_API_URL, EHR_API_KEY, LIS_INTERFACE_URL,
PROVIDER_NOTIFICATION_URL, PATIENT_PORTAL_URL,
CRITICAL_ALERT_SERVICE_URL, HIPAA_AUDIT_LOG_URL,
CRITICAL_ESCALATION_MINUTES, INTERNAL_API_KEY
```

---

### 4. Prescription Management (`prescription-management.json`)

Manages electronic prescribing (e-Prescribing) including medication ordering, drug interaction checking, formulary verification, and pharmacy routing.

**Trigger:** `POST /api/prescriptions/create`

**Steps:**
1. **validate-prescription** -- Validates the prescription payload (medication, dosage, frequency, duration, prescriber NPI, patient ID).
2. **verify-prescriber** -- Confirms the prescriber's DEA registration and state license are active and valid for the prescribed medication schedule.
3. **check-drug-interactions** -- Queries the drug interaction database against the patient's current medication list, allergies, and active diagnoses.
4. **route-interactions** -- Routes based on interaction severity:
   - **No interactions** -- Proceeds to formulary check.
   - **Minor interactions** -- Adds a clinical note and proceeds.
   - **Major interactions** -- Blocks the prescription and alerts the prescriber with alternatives.
   - **Contraindicated** -- Blocks the prescription and requires prescriber override with documented clinical justification.
5. **check-formulary** -- Verifies the medication is on the patient's insurance formulary and identifies the tier, copay, and any step therapy or prior authorization requirements.
6. **create-prescription** -- Creates the electronic prescription record in the EHR.
7. **transmit-to-pharmacy** -- Sends the prescription electronically to the patient's chosen pharmacy via the Surescripts network (NCPDP SCRIPT standard).
8. **notify-patient** -- Notifies the patient that their prescription has been sent to the pharmacy, including the estimated pickup time.
9. **log-audit-event** -- Records the prescribing event in the HIPAA audit log, including the prescriber, medication, and any interaction overrides.

**Environment Variables:**
```
EHR_API_URL, EHR_API_KEY, DRUG_INTERACTION_API_URL,
FORMULARY_API_URL, SURESCRIPTS_API_URL, SURESCRIPTS_API_KEY,
DEA_VERIFICATION_API_URL, NOTIFICATION_SERVICE_URL,
HIPAA_AUDIT_LOG_URL, INTERNAL_API_KEY
```

---

### 5. HIPAA-Compliant Data Handling (`hipaa-data-handling.json`)

Provides centralized PHI access control, encryption, audit logging, and breach detection for all data operations.

**Trigger:** `* /api/phi/:operation`

**Steps:**
1. **authenticate-request** -- Validates the JWT token, confirms the user session is active, and verifies MFA was completed.
2. **authorize-access** -- Evaluates RBAC (Role-Based Access Control) and ABAC (Attribute-Based Access Control) policies to determine if the requesting user has permission to perform the requested operation on the specified PHI resource.
3. **route-authorization** -- If access is denied, returns a 403 response and logs the unauthorized access attempt. Otherwise, proceeds.
4. **route-operation** -- Routes based on the PHI operation:
   - `read` -- Decrypts and returns the requested PHI fields. Applies minimum necessary standard by filtering to only the fields the user's role is authorized to view.
   - `write` -- Encrypts the PHI data at the field level before storage. Validates data integrity with checksums.
   - `export` -- Generates a HIPAA-compliant data export with watermarking and tracks the disclosure.
   - `delete` -- Applies the retention policy check. If the retention period has not expired, marks the record for future deletion. If expired, performs a secure deletion with verification.
5. **log-access-event** -- Records every PHI access in an immutable, tamper-evident audit log with: timestamp, user ID, patient ID, action, fields accessed, IP address, and user agent.
6. **detect-anomalies** -- Evaluates the access pattern against the user's historical baseline to detect potential insider threats or compromised accounts (e.g., bulk record access, off-hours access, accessing records outside the user's department).
7. **route-anomaly-detection** -- If an anomaly is detected, sends an immediate alert to the security team and the Privacy Officer.

**Environment Variables:**
```
AUTH_SERVICE_URL, RBAC_SERVICE_URL, ENCRYPTION_KEY_ID,
KMS_API_URL, PHI_STORAGE_URL, AUDIT_LOG_URL,
ANOMALY_DETECTION_URL, SECURITY_TEAM_EMAIL,
PRIVACY_OFFICER_EMAIL, SENDGRID_API_KEY,
DATA_RETENTION_DAYS, INTERNAL_API_KEY
```

---

## Getting Started

1. Copy the desired workflow JSON files into your project's `workflows/json/` directory.
2. Set the required environment variables in your `.env` file. Pay special attention to encryption keys and API credentials.
3. Install the required nanoservice modules:
   ```bash
   npx blok install @nanoservice-ts/api-call @nanoservice-ts/if-else @nanoservice-ts/json-validator
   ```
4. Start the Blok runtime:
   ```bash
   npx blok dev
   ```

## Architecture Notes

- **HIPAA Compliance:** Every workflow includes mandatory audit logging via the `log-audit-event` step. PHI is encrypted at the field level using AES-256-GCM with keys managed through a KMS (Key Management Service). Access is controlled through both RBAC and ABAC policies enforced at the workflow level.
- **Minimum Necessary Standard:** The PHI data handling workflow applies the HIPAA minimum necessary standard by filtering response data to only the fields authorized for the requesting user's role and purpose.
- **Audit Trail:** All audit logs are written to an immutable, append-only store with cryptographic chaining to detect tampering. Logs are retained for a minimum of 6 years per HIPAA requirements.
- **Breach Detection:** The anomaly detection step provides real-time monitoring for potential unauthorized access patterns. Combine this with periodic access reviews for comprehensive breach prevention.
- **HL7/FHIR Interoperability:** Lab results processing accepts both HL7 v2.x ORU messages and FHIR R4 DiagnosticReport resources. Prescription management uses NCPDP SCRIPT for pharmacy transmission.
- **BAA Requirements:** Before deploying to production, ensure you have Business Associate Agreements (BAAs) in place with all third-party services referenced in the workflows (email provider, cloud hosting, identity verification, etc.).
