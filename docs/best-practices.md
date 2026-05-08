# Blok Framework Best Practices

A comprehensive guide to designing, developing, deploying, and operating production-grade Blok workflows. This document covers workflow design patterns, node development, performance optimization, security, testing, monitoring, deployment, and multi-runtime considerations.

---

## Table of Contents

1. [Workflow Design Patterns](#1-workflow-design-patterns)
2. [Node Development Best Practices](#2-node-development-best-practices)
3. [Performance Optimization](#3-performance-optimization)
4. [Security Best Practices](#4-security-best-practices)
5. [Testing Strategies](#5-testing-strategies)
6. [Monitoring and Alerting](#6-monitoring-and-alerting)
7. [Deployment Patterns](#7-deployment-patterns)
8. [Multi-Runtime Considerations](#8-multi-runtime-considerations)

---

## 1. Workflow Design Patterns

### Fan-Out Pattern

Use the fan-out pattern when a single step needs to trigger multiple independent operations that can execute concurrently. This is common in notification systems (send email, SMS, and push simultaneously) or data enrichment pipelines (call multiple APIs in parallel).

```json
{
  "steps": [
    {
      "id": "fan-out-notifications",
      "use": "parallel-executor",
      "inputs": {
        "branches": [
          { "stepId": "send-email", "use": "@blokjs/api-call" },
          { "stepId": "send-sms", "use": "@blokjs/api-call" },
          { "stepId": "send-push", "use": "@blokjs/api-call" }
        ],
        "waitForAll": true
      }
    }
  ]
}
```

**When to use:** Independent operations that do not depend on each other's output.

**Recommendations:**
- Set `waitForAll: true` when subsequent steps need results from all branches.
- Set `waitForAll: false` for fire-and-forget scenarios (e.g., logging, analytics).
- Always handle partial failures -- one branch failing should not prevent others from completing.

### Fan-In Pattern

Use the fan-in pattern to collect and aggregate results from multiple parallel operations before proceeding to the next step. This pairs naturally with fan-out.

```json
{
  "steps": [
    {
      "id": "aggregate-results",
      "use": "data-transformer",
      "inputs": {
        "sources": {
          "emailResult": "$.state.send-email",
          "smsResult": "$.state.send-sms",
          "pushResult": "$.state.send-push"
        },
        "aggregation": "merge"
      }
    }
  ]
}
```

**When to use:** After a fan-out when downstream logic depends on combined results.

**Recommendations:**
- v2 default-stores every step's output to `ctx.state[id]`; reference them as `$.state.<id>`. No `set_var: true` needed.
- Define fallback values for branches that may fail to prevent the aggregation step from breaking.

### Saga Pattern

The saga pattern manages distributed transactions by defining compensating actions for each step. If a step fails, its compensating action (and those of all previously completed steps) are executed in reverse order.

```json
{
  "steps": [
    {
      "id": "charge-payment",
      "use": "@blokjs/api-call",
      "inputs": { "url": "https://billing.example.com/charge", "method": "POST" }
    },
    {
      "id": "create-order",
      "use": "@blokjs/api-call",
      "inputs": { "url": "https://orders.example.com/create", "method": "POST" }
    },
    {
      "id": "reserve-inventory",
      "use": "@blokjs/api-call",
      "inputs": { "url": "https://inventory.example.com/reserve", "method": "POST" }
    }
  ]
}
```

If `reserve-inventory` fails, the compensating actions would be:
1. Cancel the order (`create-order` compensation).
2. Refund the payment (`charge-payment` compensation).

**When to use:** Multi-step transactions spanning multiple services where atomicity is required.

**Recommendations:**
- v2 default-stores every step's output at `ctx.state[<id>]`, so compensating actions can read prior results via `$.state.charge-payment.id`, `$.state.create-order.id`, etc.
- Use a v2 `branch` step after each critical write to detect failures and route to compensating steps.
- Log every step and compensation for audit purposes.
- Design compensating actions to be idempotent -- they may be executed more than once in retry scenarios.

### Retry Pattern

Implement retries for transient failures (network timeouts, rate limits, temporary service unavailability). Use exponential backoff to avoid overwhelming the target service.

```json
{
  "steps": [
    {
      "id": "call-external-api",
      "use": "@blokjs/api-call",
      "inputs": { "url": "https://api.example.com/data", "method": "GET" },
      "retry": {
        "maxAttempts": 3,
        "minTimeoutInMs": 1000,
        "maxTimeoutInMs": 30000,
        "factor": 2
      }
    }
  ]
}
```

This is the real v2 retry shape — see [Per-step retry](/d/reliability/retry).

**When to use:** Any external API call or I/O operation that may experience transient failures.

**Recommendations:**
- Set a `maxAttempts` limit (3 is a reasonable default) to prevent infinite retry loops.
- Tune `minTimeoutInMs`, `maxTimeoutInMs`, and `factor` for the specific upstream's behavior.
- Filter non-transient errors inside the node before they reach the retry loop. v2 retry runs on every thrown or soft error.
- Log every retry attempt with the error that triggered it. Studio surfaces these as `NODE_ATTEMPT_FAILED` events automatically.
- Pair retry with [idempotent caching](/d/reliability/idempotency) so successful attempts are cached and a client retry hits the cache rather than re-running.

### Circuit Breaker Pattern (conceptual)

The circuit breaker prevents cascading failures by stopping calls to a failing service after a threshold of consecutive failures. After a cooldown period, it allows a limited number of probe requests to test recovery.

> **Not a built-in v2 primitive.** Circuit breaking is not part of the v2 step schema today. To approximate it, wrap the upstream in a custom node that tracks failure state in an external store (Redis, NATS KV) and short-circuits when the threshold is exceeded. Pair with the existing [`retry`](/d/reliability/retry) for transient failures and [`idempotencyKey`](/d/reliability/idempotency) for stable fallback responses on cache hit.

**When to use:** Critical external dependencies where continued retries during an outage would degrade overall system performance.

**Recommendations:**
- Wrap the upstream call in a custom node that consults shared state before dispatching.
- Set the failure threshold based on the service's typical error rate. Five consecutive failures is a common starting point.
- Monitor circuit state changes (open, half-open, closed) as a key operational metric.
- Alert when circuits open — this indicates a dependency is unhealthy.

---

## 2. Node Development Best Practices

### Single Responsibility

Each node should do exactly one thing and do it well. A node named `validate-and-store-user` is a code smell -- split it into `validate-user` and `store-user`.

**Recommendations:**
- Name nodes with a clear verb-noun pattern: `validate-input`, `fetch-user`, `send-email`.
- If a node's description requires the word "and," split it into two nodes.
- Small, focused nodes are easier to test, reuse, and debug.
- Compose complex behavior by chaining simple nodes in the workflow steps.

### Idempotency

Design every node to produce the same result when called multiple times with the same inputs. This is critical for reliability in retry and saga scenarios.

**Recommendations:**
- Use idempotency keys for external API calls (e.g., Stripe, payment processors).
- For database writes, use upsert operations instead of blind inserts.
- Store the operation result and check for it before re-executing.
- Avoid side effects that cannot be safely repeated (e.g., sending duplicate emails). Use deduplication mechanisms.

### Error Handling

Every node should handle errors explicitly rather than allowing unhandled exceptions to propagate.

**Recommendations:**
- Return structured error responses with a consistent shape:
  ```json
  {
    "error": true,
    "code": "VALIDATION_ERROR",
    "message": "Email address is invalid.",
    "details": { "field": "email", "value": "not-an-email" }
  }
  ```
- Use the `@blokjs/if-else` node after critical steps to check for errors and route accordingly.
- Distinguish between retryable errors (network timeout, rate limit) and permanent errors (validation failure, not found).
- Log errors with sufficient context (step name, inputs, error code) for debugging.
- Never expose internal error details (stack traces, database queries) in API responses.

### Input and Output Contracts

Define explicit schemas for node inputs and outputs. This makes workflows self-documenting and enables validation.

**Recommendations:**
- Use `@blokjs/json-validator` at the start of workflows and before critical steps.
- Document the expected input shape and output shape in the node description.
- Use TypeScript interfaces for custom nodes to enforce type safety during development.
- Validate early, fail fast -- reject invalid inputs at the workflow boundary rather than deep in the pipeline.

---

## 3. Performance Optimization

### Caching

Cache frequently accessed data to reduce latency and load on downstream services.

**Recommendations:**
- Cache external API responses that do not change frequently (e.g., configuration, reference data, exchange rates).
- Use TTL-based caching appropriate to the data's volatility:
  - Static configuration: 1 hour or more.
  - Reference data (countries, currencies): 24 hours.
  - User sessions: 15-30 minutes.
  - Real-time data (stock prices): do not cache.
- Use the `memory-storage` node for in-process caching in single-instance deployments.
- Use Redis or Memcached for distributed caching in multi-instance deployments.
- Always set a maximum cache size to prevent memory exhaustion.

### Connection Pooling

Reuse connections to databases and external services to avoid the overhead of establishing new connections for every request.

**Recommendations:**
- Configure connection pools for database nodes (`postgres-query`, `mongodb-query`):
  ```json
  {
    "pool": {
      "min": 2,
      "max": 10,
      "idleTimeoutMs": 30000,
      "connectionTimeoutMs": 5000
    }
  }
  ```
- Set pool sizes based on expected concurrency. A good starting point is `max = 2 * CPU cores`.
- Monitor pool utilization -- if the pool is consistently exhausted, increase the max or optimize query performance.
- Use connection health checks to evict stale connections.

### Batch Processing

Group multiple operations into a single batch to reduce round trips and improve throughput.

**Recommendations:**
- Use batch APIs when available (e.g., batch insert, batch email, batch inventory check).
- Group database writes into transactions to reduce commit overhead.
- For data pipelines, process records in chunks (100-1000 per batch) to balance throughput and memory.
- Use the `data-transformer` node to reshape individual records into batch payloads.

### Minimize Data Transfer

Reduce the amount of data flowing between steps to improve performance and reduce memory usage.

**Recommendations:**
- Select only the fields you need from API calls and database queries. Avoid `SELECT *`.
- Use the `mapper` node to project only required fields between steps.
- For large datasets, use pagination or streaming rather than loading everything into memory.
- Compress large payloads when transmitting between services.

---

## 4. Security Best Practices

### Input Validation

Validate all external inputs at the workflow boundary to prevent injection attacks, data corruption, and unexpected behavior.

**Recommendations:**
- Use `@blokjs/json-validator` as the first step in every HTTP-triggered workflow.
- Validate:
  - Data types and formats (email, URL, date).
  - String lengths (minimum and maximum).
  - Numeric ranges.
  - Enum values (allowed options).
  - Array sizes.
  - Required fields.
- Sanitize string inputs to prevent XSS and SQL injection. Use parameterized queries for all database operations.
- Reject unexpected fields with `additionalProperties: false` in JSON schemas.

### Secret Management

Never hardcode secrets in workflow JSON files. Always use environment variables and a secret management service.

**Recommendations:**
- Reference secrets via environment variables: `${process.env.STRIPE_SECRET_KEY}`.
- Use a secrets manager (AWS Secrets Manager, HashiCorp Vault, Azure Key Vault) in production.
- Rotate secrets regularly. Design workflows to tolerate secret rotation without downtime.
- Never log secrets. Mask sensitive values in log output.
- Use separate secrets for each environment (development, staging, production).
- Grant each workflow only the secrets it needs (least privilege).

### Least Privilege

Grant each workflow and node the minimum permissions required to perform its function.

**Recommendations:**
- Use service-specific API keys rather than admin keys. For example, use a Stripe restricted key with only the `payment_intents:write` permission.
- For database access, create dedicated users with permissions limited to the specific tables and operations the workflow needs.
- Use separate API keys for read and write operations where possible.
- Audit permissions periodically and revoke unused access.

### Data Protection

Protect sensitive data in transit and at rest.

**Recommendations:**
- Use HTTPS for all external API calls (enforced by default in Blok).
- Encrypt sensitive fields (PII, financial data, health records) at the application level before storage.
- Mask sensitive data in log output (show only last 4 digits of card numbers, mask email addresses).
- Implement data retention policies and automated purging for data you no longer need.
- For HIPAA, PCI-DSS, or SOC 2 compliance, consult the relevant industry template and your compliance team.

---

## 5. Testing Strategies

### Unit Testing

Test individual nodes in isolation with mocked dependencies.

**Recommendations:**
- Write unit tests for every custom node. Test the node's logic, not the framework.
- Mock external dependencies (APIs, databases) to test node behavior in isolation.
- Test both happy path and error cases:
  - Valid inputs produce expected outputs.
  - Invalid inputs produce structured error responses.
  - Missing inputs are handled gracefully.
- Test edge cases: empty arrays, null values, very large inputs, Unicode characters.
- Aim for 80% or greater code coverage on custom nodes.

Example test structure:
```
tests/
  nodes/
    validate-input.test.ts
    hash-password.test.ts
    cart-calculator.test.ts
  workflows/
    user-registration.integration.test.ts
    checkout.integration.test.ts
  e2e/
    registration-flow.e2e.test.ts
```

### Integration Testing

Test workflows end-to-end with real (or realistic) dependencies.

**Recommendations:**
- Use a test environment with dedicated databases and service instances.
- Test the complete workflow step sequence with representative payloads.
- Verify the correct steps execute and the correct branches are taken in conditional flows.
- Test error paths: what happens when the payment service returns a 500? When the database is unavailable?
- Use Blok's test runner to execute workflows programmatically:
  ```bash
  npx blok test workflows/json/user-registration.json --payload test-data/registration.json
  ```
- Validate the final response shape and status code.

### End-to-End (E2E) Testing

Test the full system from the client's perspective.

**Recommendations:**
- Send real HTTP requests to the running Blok instance.
- Verify the complete request-response cycle including headers, status codes, and response bodies.
- Test authentication and authorization flows.
- Test webhook delivery and processing.
- Run E2E tests against a staging environment that mirrors production.
- Include performance assertions (response time under 500ms for critical paths).

### Contract Testing

Ensure that workflows and their dependencies agree on the API contract.

**Recommendations:**
- Define OpenAPI or JSON Schema contracts for workflow inputs and outputs.
- Test that external service mocks conform to the real service's API contract.
- Use consumer-driven contract testing when multiple teams own different services.

---

## 6. Monitoring and Alerting

### Key Metrics to Track

Track these metrics for every workflow:

| Metric | Description | Alert Threshold |
|--------|-------------|-----------------|
| Request rate | Requests per second per workflow | Sudden drop > 50% |
| Error rate | Percentage of requests returning errors | > 1% for critical workflows |
| Latency (p50) | Median response time | > 200ms for API workflows |
| Latency (p99) | 99th percentile response time | > 2s for API workflows |
| Step duration | Execution time per step | Step-specific thresholds |
| Circuit breaker state | Open/closed state of each circuit breaker | Any circuit open |
| Queue depth | Pending items in async queues | > 1000 items |
| Memory usage | RSS and heap usage of the runtime | > 80% of available memory |

### Structured Logging

Use structured logging for machine-parseable log output.

**Recommendations:**
- Log every workflow execution with: workflow name, execution ID, trigger type, duration, and outcome.
- Log every step execution with: step name, node type, duration, input size, output size, and status.
- Use correlation IDs to trace requests across workflows and services.
- Use log levels consistently:
  - `error`: Unrecoverable failures that need immediate attention.
  - `warn`: Degraded behavior (retries, fallbacks, slow responses).
  - `info`: Normal workflow events (start, complete, key decisions).
  - `debug`: Detailed data for troubleshooting (inputs, outputs, intermediate state).
- Ship logs to a centralized platform (ELK, Datadog, CloudWatch) for search and analysis.

### Distributed Tracing

Implement distributed tracing to follow requests across workflow steps and external services.

**Recommendations:**
- Use OpenTelemetry for instrumentation. Blok supports OpenTelemetry out of the box.
- Create a span for each workflow execution and child spans for each step.
- Propagate trace context (W3C Trace Context headers) to external service calls.
- Record key attributes on spans: step name, node type, error status, retry count.
- Use a tracing backend (Jaeger, Zipkin, Tempo, Datadog APM) for visualization and analysis.

### Alerting

Configure alerts for conditions that require human intervention.

**Recommendations:**
- Alert on error rate spikes, not individual errors.
- Alert on latency threshold violations at p99, not p50.
- Alert on circuit breaker state changes.
- Use escalation policies: page on-call for critical alerts, send email for warnings.
- Suppress alerts during planned maintenance windows.
- Include runbook links in alert messages.

---

## 7. Deployment Patterns

### Blue-Green Deployment

Maintain two identical production environments (blue and green). Deploy to the inactive environment, verify it, and then switch traffic.

**Recommendations:**
- Deploy the new version to the inactive environment.
- Run smoke tests against the new environment.
- Switch the load balancer to route traffic to the new environment.
- Keep the old environment running for a rollback period (15-30 minutes).
- If issues are detected, switch traffic back to the old environment immediately.

**Best for:** Workflows with zero-downtime requirements and fast rollback needs.

### Canary Deployment

Route a small percentage of traffic to the new version and gradually increase it as confidence grows.

**Recommendations:**
- Start with 1-5% of traffic to the canary.
- Monitor error rates and latency of the canary versus the stable version.
- If metrics are healthy after 10-15 minutes, increase to 25%, then 50%, then 100%.
- If the canary shows elevated errors or latency, roll back immediately.
- Use header-based routing to test specific requests against the canary.

**Best for:** High-traffic workflows where gradual rollout reduces risk.

### Rolling Deployment

Update instances one at a time, keeping the service available throughout the deployment.

**Recommendations:**
- Configure health checks so the load balancer only sends traffic to healthy instances.
- Set `maxUnavailable: 1` to ensure only one instance is updated at a time.
- Wait for each instance to pass health checks before proceeding to the next.
- Use readiness probes to delay traffic until the new instance is fully initialized.

**Best for:** Stateless workflow deployments where brief version mixing is acceptable.

### Environment Promotion

Use a consistent promotion pipeline: development, staging, production.

**Recommendations:**
- Workflow JSON files should be identical across environments. Only environment variables should differ.
- Use environment-specific `.env` files or a configuration management system.
- Run the full test suite (unit, integration, E2E) in staging before promoting to production.
- Tag releases with semantic versioning matching the workflow `version` field.

---

## 8. Multi-Runtime Considerations

Blok supports multiple runtime environments (Node.js, Python, Go, Ruby, Rust, Java, C#, PHP). When using multiple runtimes in a single workflow, follow these guidelines.

### Choosing the Right Runtime

Select the runtime that best fits the task:

| Runtime | Best For | Example Use Cases |
|---------|----------|-------------------|
| Node.js (`module`) | API orchestration, JSON processing, general logic | API calls, validation, routing, mapping |
| Python (`runtime.python3`) | Data science, ML inference, NLP, data processing | Sentiment analysis, embeddings, image processing |
| Go | High-performance, CPU-intensive computation | Cryptographic operations, data compression |
| Rust | System-level performance, WebAssembly | Low-latency processing, binary parsing |
| Java | Enterprise integration, JVM ecosystem | SOAP services, legacy system integration |
| C# | .NET ecosystem, Windows integrations | Azure services, Active Directory |

### Data Serialization Between Runtimes

When steps use different runtimes, data is serialized to JSON between them. Be aware of serialization differences.

**Recommendations:**
- Use JSON-compatible data types in step inputs and outputs. Avoid language-specific types (Python sets, Java BigDecimal) that do not serialize cleanly.
- For binary data, use Base64 encoding.
- For dates, use ISO 8601 strings (`2024-01-15T10:30:00Z`), not language-specific date objects.
- For large numbers, use strings to avoid floating-point precision issues across runtimes.
- Test serialization round-trips between runtimes to catch type conversion issues.

### Performance Across Runtimes

Calling between runtimes incurs serialization and process communication overhead.

**Recommendations:**
- Minimize runtime transitions. Group steps that use the same runtime together.
- For data-intensive pipelines, do the heavy processing in a single runtime and only cross boundaries for specialized operations.
- Profile the workflow to identify if serialization overhead is a bottleneck. If a Python step takes 5ms but serialization adds 20ms, consider rewriting it in the primary runtime.
- Use `set_var: true` to store intermediate results and reduce redundant data passing.

### Error Handling Across Runtimes

Error handling semantics vary across runtimes.

**Recommendations:**
- All runtimes should return errors in the same JSON format:
  ```json
  {
    "error": true,
    "code": "ERROR_CODE",
    "message": "Human-readable error message"
  }
  ```
- Do not rely on language-specific exception types. Convert exceptions to the standard error format at the node boundary.
- Test error propagation from non-primary runtimes to ensure the workflow's `@blokjs/if-else` routing handles them correctly.

### Dependency Management

Each runtime has its own dependency ecosystem.

**Recommendations:**
- Keep runtime-specific dependencies isolated. Python dependencies should not affect Node.js modules.
- Pin dependency versions explicitly to ensure reproducible builds.
- Use lockfiles (`package-lock.json`, `requirements.txt` with pinned versions, `go.sum`).
- Audit dependencies for security vulnerabilities regularly.
- Minimize the number of dependencies in each runtime to reduce the attack surface and build time.

---

## Summary Checklist

Use this checklist when building and reviewing Blok workflows:

- [ ] Each step has a single, clear responsibility.
- [ ] All external inputs are validated with JSON schemas.
- [ ] Secrets are stored in environment variables, not in workflow JSON.
- [ ] Error handling covers both retryable and permanent failures.
- [ ] Critical steps use idempotency keys.
- [ ] Multi-step transactions use the saga pattern with compensating actions.
- [ ] External API calls use retries with exponential backoff.
- [ ] Circuit breakers protect against cascading failures from unhealthy dependencies.
- [ ] Frequently accessed data is cached with appropriate TTLs.
- [ ] Database connections use connection pooling.
- [ ] Structured logging is implemented for all workflow and step events.
- [ ] Distributed tracing spans cover the full workflow execution.
- [ ] Alerts are configured for error rate, latency, and circuit breaker state changes.
- [ ] Unit tests cover custom node logic with at least 80% coverage.
- [ ] Integration tests verify complete workflow execution paths.
- [ ] Workflow JSON files are identical across environments; only environment variables differ.
- [ ] Multi-runtime data uses JSON-compatible types with ISO 8601 dates and string-encoded large numbers.
