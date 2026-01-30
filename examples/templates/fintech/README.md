# Fintech Industry Template

A production-ready collection of Blok workflows for building financial technology backends. These templates cover identity verification, transaction processing, fraud detection, regulatory compliance, and account management. All workflows are designed with auditability, data integrity, and regulatory requirements in mind.

## Included Workflows

### 1. KYC Verification (`kyc-verification.json`)

Implements a multi-step Know Your Customer verification process that integrates with identity verification providers and maintains a complete audit trail.

**Trigger:** `POST /api/kyc/verify`

**Steps:**
1. **validate-kyc-request** -- Validates the KYC submission payload (personal information, document type, document images).
2. **check-existing-verification** -- Queries the database to determine if this user already has a pending or completed verification.
3. **route-existing-check** -- If a valid verification exists, returns its status. Otherwise, proceeds with a new verification.
4. **submit-identity-check** -- Sends the user's personal information and document images to the identity verification provider (e.g., Jumio, Onfido, or Veriff).
5. **submit-watchlist-screening** -- Screens the applicant against sanctions lists, PEP databases, and adverse media sources.
6. **evaluate-results** -- Aggregates the identity check and watchlist screening results into a risk score.
7. **route-risk-decision** -- Routes based on the risk score:
   - **Low risk** -- Auto-approves the verification.
   - **Medium risk** -- Flags for manual review and notifies the compliance team.
   - **High risk** -- Auto-rejects and files a Suspicious Activity Report (SAR) notice.
8. **store-verification-record** -- Persists the complete verification record with all provider responses and the decision outcome.
9. **notify-applicant** -- Sends the applicant an email or in-app notification with their verification status.

**Environment Variables:**
```
KYC_PROVIDER_API_URL, KYC_PROVIDER_API_KEY, WATCHLIST_API_URL,
WATCHLIST_API_KEY, COMPLIANCE_DB_URL, SENDGRID_API_KEY,
FROM_EMAIL, COMPLIANCE_TEAM_EMAIL, INTERNAL_API_KEY
```

---

### 2. Transaction Processing (`transaction-processing.json`)

Handles the complete lifecycle of financial transactions including validation, authorization, settlement, and ledger posting.

**Trigger:** `POST /api/transactions/process`

**Steps:**
1. **validate-transaction** -- Validates the transaction payload (source account, destination, amount, currency, type).
2. **check-account-status** -- Verifies that the source account is active, not frozen, and in good standing.
3. **check-balance** -- Confirms the source account has sufficient available balance (including pending holds).
4. **apply-transaction-limits** -- Evaluates the transaction against daily, weekly, and per-transaction limits for the account tier.
5. **run-fraud-check** -- Calls the fraud detection service for real-time risk scoring (see Fraud Detection workflow).
6. **route-fraud-result** -- Routes based on the fraud risk score:
   - **Pass** -- Proceeds with authorization.
   - **Review** -- Holds the transaction and alerts the fraud team.
   - **Reject** -- Declines the transaction and notifies the account holder.
7. **authorize-transaction** -- Places a hold on the source account and creates the pending transaction record.
8. **execute-settlement** -- Settles the transaction by debiting the source and crediting the destination. For cross-border transactions, applies the FX rate.
9. **post-to-ledger** -- Records the double-entry ledger posting for the transaction.
10. **send-receipt** -- Sends a transaction receipt to the account holder via their preferred channel.

**Environment Variables:**
```
ACCOUNT_SERVICE_URL, LEDGER_SERVICE_URL, FRAUD_SERVICE_URL,
FX_RATE_API_URL, NOTIFICATION_SERVICE_URL, INTERNAL_API_KEY,
DAILY_TRANSACTION_LIMIT, WEEKLY_TRANSACTION_LIMIT
```

---

### 3. Fraud Detection (`fraud-detection.json`)

Real-time fraud scoring engine that evaluates transactions against behavioral patterns, velocity checks, device fingerprints, and machine learning models.

**Trigger:** `POST /api/fraud/evaluate`

**Steps:**
1. **enrich-transaction** -- Enriches the transaction data with geolocation, device fingerprint, and IP reputation data.
2. **fetch-account-history** -- Retrieves recent transaction history for the account to establish behavioral baselines.
3. **run-velocity-checks** -- Evaluates transaction frequency, amount patterns, and geographic spread against velocity rules.
4. **run-ml-model** -- Sends the enriched data to the machine learning fraud model for probabilistic risk scoring.
5. **evaluate-rules-engine** -- Runs the transaction through a configurable rules engine for deterministic checks (blocked countries, known fraud patterns, amount thresholds).
6. **aggregate-scores** -- Combines the velocity, ML, and rules engine scores into a composite risk score with contributing factors.
7. **route-risk-level** -- Routes based on the composite score:
   - **Low (0-30)** -- Approves with no additional action.
   - **Medium (31-70)** -- Approves but flags for post-transaction review.
   - **High (71-100)** -- Blocks the transaction and alerts the fraud operations team.
8. **record-evaluation** -- Stores the complete fraud evaluation for auditing and model retraining.

**Environment Variables:**
```
GEOLOCATION_API_URL, DEVICE_FINGERPRINT_API_URL, ML_MODEL_API_URL,
RULES_ENGINE_URL, FRAUD_DB_URL, SLACK_WEBHOOK_URL, INTERNAL_API_KEY
```

---

### 4. Compliance Reporting (`compliance-reporting.json`)

Automated compliance reporting that generates regulatory filings, audit reports, and ongoing monitoring summaries.

**Trigger:**
```json
{
  "cron": {
    "schedule": "0 6 * * *",
    "timezone": "America/New_York",
    "description": "Runs daily at 6:00 AM Eastern"
  }
}
```

**Steps:**
1. **query-reportable-transactions** -- Queries all transactions from the previous reporting period that meet reporting thresholds (e.g., CTR for transactions over $10,000).
2. **query-suspicious-activities** -- Retrieves flagged transactions and fraud alerts for the period.
3. **generate-ctr-filings** -- For each reportable transaction, generates a Currency Transaction Report (CTR) in the FinCEN-required format.
4. **generate-sar-filings** -- For suspicious activities meeting SAR thresholds, generates Suspicious Activity Report filings.
5. **compile-audit-report** -- Aggregates all regulatory filings, account activities, and compliance metrics into a comprehensive audit report.
6. **submit-filings** -- Submits electronic filings to the appropriate regulatory bodies via their APIs.
7. **archive-reports** -- Stores all generated reports in the compliance archive with tamper-evident hashing.
8. **notify-compliance-team** -- Sends a summary email to the compliance team with filing counts, any exceptions, and action items.

**Environment Variables:**
```
COMPLIANCE_DB_URL, FINCEN_API_URL, FINCEN_API_KEY,
ARCHIVE_STORAGE_URL, SENDGRID_API_KEY, FROM_EMAIL,
COMPLIANCE_TEAM_EMAIL, CTR_THRESHOLD, INTERNAL_API_KEY
```

---

### 5. Account Management (`account-management.json`)

Manages the full account lifecycle including creation, updates, tier changes, freezing, and closure.

**Trigger:** `* /api/accounts/:action`

**Steps:**
1. **route-action** -- Routes the request based on the `action` parameter and HTTP method:
   - `POST /create` -- Creates a new account after identity verification.
   - `PUT /update` -- Updates account details with change logging.
   - `POST /upgrade` -- Processes an account tier upgrade with eligibility checks.
   - `POST /freeze` -- Freezes an account with a reason code and compliance hold.
   - `POST /close` -- Initiates account closure with balance transfer and regulatory holds.
2. **create-account** -- Provisions a new account with initial settings, generates the account number, creates the ledger entry, and sends the welcome kit.
3. **update-account** -- Validates the update payload, applies changes, and logs the field-level audit trail.
4. **upgrade-account** -- Checks tier eligibility, updates account limits and features, and notifies the account holder.
5. **freeze-account** -- Places a compliance or fraud hold on the account, blocks all outgoing transactions, and notifies compliance.
6. **close-account** -- Verifies zero balance or initiates balance transfer, marks the account as closed, and generates a closure summary.

**Environment Variables:**
```
ACCOUNT_DB_URL, LEDGER_SERVICE_URL, KYC_SERVICE_URL,
NOTIFICATION_SERVICE_URL, COMPLIANCE_SERVICE_URL,
SENDGRID_API_KEY, FROM_EMAIL, INTERNAL_API_KEY
```

---

## Getting Started

1. Copy the desired workflow JSON files into your project's `workflows/json/` directory.
2. Set the required environment variables in your `.env` file.
3. Install the required blok modules:
   ```bash
   npx blok install @blok/api-call @blok/if-else @blok/json-validator
   ```
4. Start the Blok runtime:
   ```bash
   npx blok dev
   ```

## Architecture Notes

- **Audit Trail:** Every workflow records a complete audit trail with timestamps, actor identities, and before/after state for regulatory compliance.
- **Double-Entry Ledger:** All financial transactions use double-entry bookkeeping with the `post-to-ledger` step ensuring debits always equal credits.
- **Idempotency:** Transaction processing uses idempotency keys to prevent duplicate processing in retry scenarios.
- **Data Residency:** All sensitive data (PII, financial records) is encrypted at rest and in transit. Environment variables manage encryption keys and data residency configuration.
- **Regulatory Compliance:** The compliance reporting workflow is designed to satisfy BSA/AML requirements, including CTR and SAR filing obligations. Consult your compliance team before deploying to production.
