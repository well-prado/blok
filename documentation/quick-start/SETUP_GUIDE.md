# Blok Quick-Start Setup Guide

> Complete guide to running Blok locally with all 7 multi-language SDK runtimes, testing workflows, and measuring performance.

## Prerequisites

### Required
| Tool | Minimum Version | Purpose |
|------|----------------|---------|
| **Node.js** | 18.0.0+ | JavaScript runtime (primary engine) |
| **pnpm** | 10.2.0+ | Package manager (monorepo) |
| **Docker** | 24.0+ | Container runtime (for multi-language runtimes, infrastructure) |
| **Docker Compose** | 2.20+ | Multi-container orchestration |

### Optional (for local SDK development without Docker)
| Tool | Purpose |
|------|---------|
| **Python 3.12+** | Python SDK development |
| **Go 1.21+** | Go SDK development |
| **Java 17+** | Java SDK development |
| **Rust 1.70+** | Rust SDK development |
| **.NET 8+** | C# SDK development |
| **PHP 8.2+** | PHP SDK development |
| **Ruby 3.2+** | Ruby SDK development |

---

## Quick Start (Full Stack)

The fastest way to run Blok with all 7 language runtimes:

```bash
# 1. Clone and install
git clone https://github.com/well-prado/blok.git
cd blok
pnpm install

# 2. Build core packages and nodes
pnpm core:build:dev
pnpm nodes:build

# 3. Start the 7 SDK runtime containers
cd tests/e2e/cross-runtime
docker compose up -d --build

# 4. Wait for all containers to become healthy (~30-60s)
docker compose ps
# All 7 should show (healthy)

# 5. Start the Blok HTTP server (in a new terminal)
cd /path/to/blok
pnpm http:dev
# → Server starts at http://localhost:4000

# 6. Test it
curl http://localhost:4000/health
```

---

## Installation Paths

### Path 1: Create a New Project (Recommended for users)
```bash
# Using npx (no global install needed)
npx blokctl@latest create project

# Follow the interactive prompts:
# 1. Project name
# 2. Template (HTTP API, gRPC, etc.)
# 3. Package manager (pnpm recommended)

# Navigate to project
cd my-blok-project

# Install dependencies
pnpm install

# Start development server
pnpm run dev
# → Server starts at http://localhost:4000
```

### Path 2: Clone the Monorepo (for contributors)
```bash
# Clone the repository
git clone https://github.com/well-prado/blok.git
cd blok

# Install all dependencies
pnpm install

# Build core packages
pnpm core:build:dev

# Build nodes
pnpm nodes:build

# Start the HTTP trigger dev server
pnpm http:dev
# → Server starts at http://localhost:4000
```

### Path 3: Docker (quickest production-like setup)
```bash
# Clone the repository
git clone https://github.com/well-prado/blok.git
cd blok

# Start production stack
docker compose -f infra/docker-compose.production.yml up -d
# → Blok runs at http://localhost:4000
# → 3 replicas with Redis, RabbitMQ, NATS, Nginx

# With monitoring
docker compose -f infra/docker-compose.production.yml --profile monitoring up -d
# → Grafana at http://localhost:3000
# → Prometheus at http://localhost:9090
```

---

## Running the Multi-Language SDK Runtimes

Blok supports 7 language runtimes as sidecar containers. Each runs a gRPC server (`blok.runtime.v1.NodeRuntime/Execute`) plus a `GET /health` endpoint for orchestrator readiness probes. The runner has spoken gRPC since v0.5; `HttpRuntimeAdapter` is gone.

### Start All 7 SDK Containers

```bash
cd tests/e2e/cross-runtime
docker compose up -d --build
```

### Verify All Containers Are Healthy

```bash
docker compose ps
```

Expected output — all 7 should show `(healthy)`:

| Container | Language | Host Port | Container Port | Status |
|-----------|----------|-----------|----------------|--------|
| sdk-go | Go | 9001 | 8080 | (healthy) |
| sdk-rust | Rust | 9002 | 8080 | (healthy) |
| sdk-java | Java | 9003 | 8080 | (healthy) |
| sdk-csharp | C# | 9004 | 8080 | (healthy) |
| sdk-php | PHP | 9005 | 8080 | (healthy) |
| sdk-ruby | Ruby | 9006 | 8080 | (healthy) |
| sdk-python3 | Python | 9007 | 8080 | (healthy) |

### Health Check Each Runtime Individually

```bash
# Go
curl -s http://localhost:9001/health | jq .

# Rust
curl -s http://localhost:9002/health | jq .

# Java
curl -s http://localhost:9003/health | jq .

# C#
curl -s http://localhost:9004/health | jq .

# PHP
curl -s http://localhost:9005/health | jq .

# Ruby
curl -s http://localhost:9006/health | jq .

# Python3
curl -s http://localhost:9007/health | jq .
```

Each returns:
```json
{
  "status": "healthy",
  "runtime": "go",
  "version": "1.0.0",
  "nodes_loaded": ["chain-test", "hello-world"]
}
```

### Stop All SDK Containers

```bash
cd tests/e2e/cross-runtime
docker compose down
```

---

## Environment Variables (Complete Reference)

### Core Application
```bash
# Application
PORT=4000                          # HTTP server port
NODE_ENV=development               # development | production
APP_NAME=blok-app                  # Application name (used in logs)
CONSOLE_LOG_ACTIVE=true            # Enable console logging

# Paths
WORKFLOWS_PATH=./workflows         # Path to workflow JSON files
NODES_PATH=./src/nodes             # Path to node implementations
```

### SDK Runtime Hosts (gRPC)

Each runtime is reached via `GrpcRuntimeAdapter` since v0.5. The runner resolves host and gRPC port from environment variables:

```bash
# Go SDK
RUNTIME_GO_HOST=localhost          # Default: localhost
RUNTIME_GO_PORT=9001               # Default: 9001

# Rust SDK
RUNTIME_RUST_HOST=localhost        # Default: localhost
RUNTIME_RUST_PORT=9002             # Default: 9002

# Java SDK
RUNTIME_JAVA_HOST=localhost        # Default: localhost
RUNTIME_JAVA_PORT=9003             # Default: 9003

# C# SDK
RUNTIME_CSHARP_HOST=localhost      # Default: localhost
RUNTIME_CSHARP_PORT=9004           # Default: 9004

# PHP SDK
RUNTIME_PHP_HOST=localhost         # Default: localhost
RUNTIME_PHP_PORT=9005              # Default: 9005

# Ruby SDK
RUNTIME_RUBY_HOST=localhost        # Default: localhost
RUNTIME_RUBY_PORT=9006             # Default: 9006

# Python3 SDK
RUNTIME_PYTHON3_HOST=localhost     # Default: localhost
RUNTIME_PYTHON3_PORT=9007          # Default: 9007
```

When running everything in Docker Compose, use container service names as hosts:
```bash
RUNTIME_GO_HOST=sdk-go
RUNTIME_RUST_HOST=sdk-rust
RUNTIME_JAVA_HOST=sdk-java
RUNTIME_CSHARP_HOST=sdk-csharp
RUNTIME_PHP_HOST=sdk-php
RUNTIME_RUBY_HOST=sdk-ruby
RUNTIME_PYTHON3_HOST=sdk-python3
```

### Message Brokers
```bash
# Redis
REDIS_URL=redis://localhost:6379
REDIS_PASSWORD=

# RabbitMQ
RABBITMQ_URL=amqp://guest:guest@localhost:5672

# NATS
NATS_URL=nats://localhost:4222

# Kafka
KAFKA_BROKERS=localhost:9092
KAFKA_CLIENT_ID=blok-app
```

### Observability
```bash
# Prometheus
PROMETHEUS_ENABLED=false
PROMETHEUS_PORT=9091

# OpenTelemetry
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
OTEL_SERVICE_NAME=blok

# Sentry
SENTRY_DSN=

# CloudWatch
AWS_REGION=us-east-1
CLOUDWATCH_LOG_GROUP=blok
CLOUDWATCH_ENABLED=false

# Azure Monitor
AZURE_MONITOR_CONNECTION_STRING=
AZURE_MONITOR_ENABLED=false
```

### Security
```bash
# JWT Authentication
JWT_SECRET=your-secret-key
JWT_ISSUER=blok
JWT_AUDIENCE=blok-api
JWT_EXPIRY=3600

# OAuth 2.0
OAUTH_CLIENT_ID=
OAUTH_CLIENT_SECRET=
OAUTH_REDIRECT_URI=
OAUTH_PROVIDER=                    # google | github | azure-ad | custom

# API Keys
API_KEY_HEADER=X-API-Key

# Secret Management
VAULT_ADDR=http://localhost:8200
VAULT_TOKEN=
AWS_SECRET_ACCESS_KEY=
GCP_PROJECT_ID=
AZURE_KEY_VAULT_URL=

# TLS
TLS_CERT_PATH=
TLS_KEY_PATH=
TLS_CA_PATH=
```

### Deployment
```bash
# Docker
BLOK_REPLICAS=3                    # Number of app replicas
GRAFANA_PASSWORD=admin             # Grafana admin password
RABBITMQ_PASSWORD=blok_prod        # RabbitMQ password
```

---

## Docker Compose Quick Reference

### Development Environment
```bash
# Create shared network (one-time)
docker network create shared-network

# Start dev database
docker compose -f infra/development/docker-compose.yml up -d
# → PostgreSQL at localhost:5432 (user: postgres, pass: example)
# → Adminer at http://localhost:8080
```

### SDK Runtimes (Multi-Language)
```bash
# Start all 7 SDK containers
cd tests/e2e/cross-runtime
docker compose up -d --build
# → Go SDK at localhost:9001
# → Rust SDK at localhost:9002
# → Java SDK at localhost:9003
# → C# SDK at localhost:9004
# → PHP SDK at localhost:9005
# → Ruby SDK at localhost:9006
# → Python3 SDK at localhost:9007

# Rebuild a single runtime (e.g., after changing Go SDK code)
docker compose up -d --build sdk-go

# View logs for a specific runtime
docker compose logs -f sdk-rust
```

### Testing Environment
```bash
# Start all test infrastructure
docker compose -f infra/testing/docker-compose.yml up -d
# → PostgreSQL at localhost:5433 (user: blok, pass: blok_test)
# → Redis at localhost:6380
# → Kafka at localhost:9094
# → RabbitMQ at localhost:5673 (management: 15673)
# → NATS at localhost:4223 (monitoring: 8223)
```

### Monitoring Stack
```bash
# Create shared network (if not exists)
docker network create shared-network

# Start monitoring
docker compose -f infra/metrics/docker-compose.yml up -d
# → Prometheus at http://localhost:9090
# → Grafana at http://localhost:3000
# → Loki at http://localhost:3100
# → Tempo (OTLP gRPC) at localhost:4317
# → Tempo (OTLP HTTP) at localhost:4318
```

### Production Stack
```bash
# Start production
docker compose -f infra/docker-compose.production.yml up -d
# → Blok at http://localhost:4000 (3 replicas)
# → Redis at localhost:6379
# → RabbitMQ at localhost:5672 (management: 15672)
# → NATS at localhost:4222
# → Nginx at http://localhost:80

# With monitoring
docker compose -f infra/docker-compose.production.yml --profile monitoring up -d
# → Adds Prometheus, Grafana, Loki, Tempo
```

---

## Testing Workflows

### First Workflow: Hello World

**1. Create a workflow file**

**File:** `workflows/hello.json`
```json
{
  "name": "hello-world",
  "description": "A simple hello world workflow",
  "trigger": {
    "http": {
      "method": "GET",
      "path": "/",
      "accept": "application/json"
    }
  },
  "steps": [
    {
      "name": "greet",
      "node": "greet",
      "type": "local",
      "inputs": {
        "name": {
          "$param": "ctx.request.query.name",
          "default": "World"
        }
      }
    }
  ],
  "response": {
    "status": 200,
    "body": "ctx.vars.greet"
  }
}
```

**2. Create a node**

**File:** `src/nodes/greet/index.ts`
```typescript
import { z } from "zod";
import { defineNode } from "@blokjs/runner";

export default defineNode({
  name: "greet",
  description: "Returns a greeting message",
  input: z.object({
    name: z.string().default("World"),
  }),
  output: z.object({
    message: z.string(),
  }),
  async execute(ctx, input) {
    return { message: `Hello, ${input.name}!` };
  },
});
```

**3. Test it**
```bash
# Start dev server
pnpm http:dev

# Test with curl
curl http://localhost:4000/hello?name=Blok
# → { "message": "Hello, Blok!" }
```

### Cross-Runtime Chain Test (8 Languages)

This workflow chains execution across all 8 language runtimes (NodeJS → Go → Rust → Java → C# → PHP → Ruby → Python3), passing `ctx.vars` data between each step.

The workflow is defined at `triggers/http/workflows/json/cross-runtime-chain.json`.

**Prerequisites:**
```bash
# 1. SDK containers must be running
cd tests/e2e/cross-runtime
docker compose up -d --build
# Wait for all 7 to show (healthy)
docker compose ps

# 2. Blok HTTP server must be running (separate terminal)
cd /path/to/blok
pnpm http:dev
```

**Run the chain test manually:**
```bash
# Execute the cross-runtime workflow
curl -s -X POST http://localhost:4000/cross-runtime-chain \
  -H "Content-Type: application/json" \
  -d '{}' | jq .
```

Expected response — all 8 languages chained:
```json
{
  "chain": [
    { "language": "nodejs", "order": 1, "timestamp": "..." },
    { "language": "go", "order": 2, "timestamp": "..." },
    { "language": "rust", "order": 3, "timestamp": "..." },
    { "language": "java", "order": 4, "timestamp": "..." },
    { "language": "csharp", "order": 5, "timestamp": "..." },
    { "language": "php", "order": 6, "timestamp": "..." },
    { "language": "ruby", "order": 7, "timestamp": "..." },
    { "language": "python3", "order": 8, "timestamp": "..." }
  ],
  "origin": "blok-cross-runtime-test"
}
```

**Run the automated E2E test suite:**
```bash
cd tests/e2e/cross-runtime
npx tsx chain.test.ts
```

This runs health checks on all SDKs, individual node tests, and the full 8-language chain validation.

### Execute a Node Directly on an SDK Container

You can test any SDK runtime independently without the Blok server:

```bash
# Execute the chain-test node directly on the Go SDK
curl -s -X POST http://localhost:9001/execute \
  -H "Content-Type: application/json" \
  -d '{
    "node": { "name": "chain-test", "type": "default", "config": {} },
    "context": {
      "id": "test-1",
      "workflow_name": "manual-test",
      "workflow_path": "/test",
      "request": {
        "body": { "chain": [], "origin": "manual" },
        "headers": {},
        "params": {},
        "query": {},
        "method": "POST",
        "url": "/test",
        "cookies": {},
        "baseUrl": ""
      },
      "response": { "data": null, "contentType": "application/json", "success": true, "error": null },
      "vars": {},
      "env": {}
    }
  }' | jq .
```

Replace port `9001` with any SDK port (9002-9007) to test other runtimes.

---

## Performance Benchmarking

### Quick Latency Test (Single Request)

```bash
# Measure a single request to the cross-runtime chain (all 8 languages)
curl -s -X POST http://localhost:4000/cross-runtime-chain \
  -H "Content-Type: application/json" \
  -d '{}' -o /dev/null -w "HTTP %{http_code} | Total: %{time_total}s | Connect: %{time_connect}s | TTFB: %{time_starttransfer}s\n"
```

### Per-Runtime Latency (Individual SDK Overhead)

Measure how fast each SDK responds to a direct `/execute` call:

```bash
for port in 9001 9002 9003 9004 9005 9006 9007; do
  lang=$(curl -s http://localhost:$port/health | jq -r '.runtime // "unknown"')
  time_total=$(curl -s -o /dev/null -w "%{time_total}" -X POST http://localhost:$port/execute \
    -H "Content-Type: application/json" \
    -d '{
      "node": {"name": "chain-test", "type": "default", "config": {}},
      "context": {
        "id": "bench",
        "workflow_name": "bench",
        "workflow_path": "/bench",
        "request": {"body": {"chain": [], "origin": "bench"}, "headers": {}, "params": {}, "query": {}, "method": "POST", "url": "/bench", "cookies": {}, "baseUrl": ""},
        "response": {"data": null, "contentType": "application/json", "success": true, "error": null},
        "vars": {},
        "env": {}
      }
    }')
  printf "%-10s (:%s)  %ss\n" "$lang" "$port" "$time_total"
done
```

### Load Testing with `hey`

Install: `brew install hey` (macOS) or `go install github.com/rakyll/hey@latest`

```bash
# Benchmark a single SDK runtime (Go) — 1000 requests, 10 concurrent
hey -n 1000 -c 10 -m POST \
  -H "Content-Type: application/json" \
  -d '{"node":{"name":"chain-test","type":"default","config":{}},"context":{"id":"bench","workflow_name":"bench","workflow_path":"/bench","request":{"body":{"chain":[],"origin":"bench"},"headers":{},"params":{},"query":{},"method":"POST","url":"/bench","cookies":{},"baseUrl":""},"response":{"data":null,"contentType":"application/json","success":true,"error":null},"vars":{},"env":{}}}' \
  http://localhost:9001/execute

# Benchmark the full cross-runtime chain workflow — 100 requests, 5 concurrent
hey -n 100 -c 5 -m POST \
  -H "Content-Type: application/json" \
  -d '{}' \
  http://localhost:4000/cross-runtime-chain

# Benchmark a simple local-only workflow — 1000 requests, 50 concurrent
hey -n 1000 -c 50 -m GET \
  http://localhost:4000/hello?name=Benchmark
```

### What to Look For

| Metric | Good | Needs Investigation |
|--------|------|---------------------|
| Individual SDK `/execute` latency | < 5ms | > 20ms |
| Full 8-runtime chain end-to-end | < 100ms | > 500ms |
| Local-only workflow (NodeJS) | < 2ms | > 10ms |
| Throughput (local workflow) | > 5000 req/s | < 1000 req/s |
| Throughput (cross-runtime chain) | > 200 req/s | < 50 req/s |
| Error rate under load | 0% | > 1% |

---

## Common Development Workflows

### Building
```bash
# Build everything
pnpm build

# Build core only
pnpm core:build:dev

# Build CLI only
pnpm build:cli

# Build nodes only
pnpm nodes:build
```

### Testing
```bash
# Run all unit tests
pnpm test

# Runner tests (watch mode)
pnpm runner:test

# CLI tests
pnpm cli:test

# Helper tests
pnpm helper:test

# Integration tests (requires Docker test infra)
docker compose -f infra/testing/docker-compose.yml up -d
cd core/runner && pnpm test:integration

# Cross-runtime E2E tests (requires SDK containers + Blok server)
cd tests/e2e/cross-runtime
npx tsx chain.test.ts
```

### Linting
```bash
# Lint all files
pnpm lint
```

### Documentation
```bash
# Start docs dev server (Mintlify)
pnpm doc:dev

# Generate API reference (TypeDoc)
pnpm doc:generate
```

---

## Project Creation Walkthrough

When a user runs `npx blokctl@latest create project`, the CLI:

1. **Asks for project name** → Creates directory
2. **Asks for template** → HTTP API (default), gRPC, or blank
3. **Scaffolds the project:**
   ```
   my-project/
   ├── src/
   │   └── nodes/           # Node implementations go here
   ├── workflows/            # Workflow JSON files go here
   │   └── example.json     # Example workflow
   ├── package.json          # Dependencies
   ├── tsconfig.json         # TypeScript config
   └── .env                  # Environment variables
   ```
4. **Installs dependencies** via pnpm/npm/yarn
5. **Prints instructions** to start development

---

## Ports Reference

### Blok Core
| Service | Port | Protocol |
|---------|------|----------|
| Blok HTTP Server | 4000 | HTTP |
| Blok Metrics | 9091 | HTTP (Prometheus) |

### SDK Runtimes (HTTP)
| Service | Host Port | Container Port | Protocol |
|---------|-----------|----------------|----------|
| Go SDK | 9001 | 8080 | HTTP |
| Rust SDK | 9002 | 8080 | HTTP |
| Java SDK | 9003 | 8080 | HTTP |
| C# SDK | 9004 | 8080 | HTTP |
| PHP SDK | 9005 | 8080 | HTTP |
| Ruby SDK | 9006 | 8080 | HTTP |
| Python3 SDK | 9007 | 8080 | HTTP |

### Infrastructure
| Service | Port | Protocol |
|---------|------|----------|
| PostgreSQL | 5432 | TCP |
| Redis | 6379 | TCP |
| RabbitMQ | 5672 | AMQP |
| RabbitMQ Management | 15672 | HTTP |
| NATS | 4222 | TCP |
| NATS Monitoring | 8222 | HTTP |
| Kafka | 9092/9094 | TCP |

### Observability
| Service | Port | Protocol |
|---------|------|----------|
| Prometheus | 9090 | HTTP |
| Grafana | 3000 | HTTP |
| Loki | 3100 | HTTP |
| Tempo (OTLP gRPC) | 4317 | gRPC |
| Tempo (OTLP HTTP) | 4318 | HTTP |

### Other
| Service | Port | Protocol |
|---------|------|----------|
| Adminer | 8080 | HTTP |
| Nginx (production) | 80/443 | HTTP/HTTPS |

---

## Network Configuration

Blok uses Docker networks for inter-service communication:
- **`shared-network`** — Development/monitoring (external, must create manually)
- **`blok-net`** — Production stack (auto-created, bridge driver)
- **`blok-test`** — Testing stack (auto-created, bridge driver)

Create the shared network:
```bash
docker network create shared-network
```

---

## Troubleshooting

### Container shows "unhealthy"
All SDK containers use `127.0.0.1` (not `localhost`) in health checks to avoid IPv6 resolution issues on Alpine Linux. If a container shows unhealthy:
```bash
# Check the container logs
docker compose logs sdk-rust

# Test the health endpoint from inside the container
docker exec <container-id> wget -qO- http://127.0.0.1:8080/health
```

### Blok server can't reach SDK containers
When running SDK containers via Docker and Blok locally, the runner connects to `localhost:9001-9007` (the exposed host ports). Verify with:
```bash
curl http://localhost:9001/health
```

If running everything in Docker, use service names instead of `localhost`:
```bash
RUNTIME_GO_HOST=sdk-go
RUNTIME_RUST_HOST=sdk-rust
# etc.
```

### Port conflicts
If ports 9001-9007 are already in use:
```bash
# Find what's using a port
lsof -i :9001

# Kill the process
kill -9 <PID>
```

### Rebuilding a single SDK after code changes
```bash
cd tests/e2e/cross-runtime
docker compose up -d --build sdk-go    # Rebuild only Go
docker compose up -d --build sdk-rust  # Rebuild only Rust
```
