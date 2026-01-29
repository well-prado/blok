# Blok Quick-Start Setup Guide (Internal Reference)

> This document captures every detail needed to write the "Getting Started" documentation pages. It includes all prerequisites, installation steps, environment variables, Docker Compose configurations, and first-run instructions.

## Prerequisites

### Required
| Tool | Minimum Version | Purpose |
|------|----------------|---------|
| **Node.js** | 18.0.0+ | JavaScript runtime (primary engine) |
| **pnpm** | 10.2.0+ | Package manager (monorepo) |
| **Docker** | 24.0+ | Container runtime (for multi-language runtimes, infrastructure) |
| **Docker Compose** | 2.20+ | Multi-container orchestration |

### Optional (for specific features)
| Tool | Purpose |
|------|---------|
| **Python 3.11+** | Python runtime (if running Python nodes locally without Docker) |
| **Go 1.21+** | Go SDK development |
| **Java 17+** | Java SDK development |
| **Rust 1.70+** | Rust SDK development |
| **.NET 8+** | C# SDK development |
| **PHP 8.2+** | PHP SDK development |
| **Ruby 3.2+** | Ruby SDK development |

---

## Installation Paths

### Path 1: Create a New Project (Recommended for users)
```bash
# Using npx (no global install needed)
npx nanoctl@latest create project

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
git clone https://github.com/deskree-inc/blok.git
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
git clone https://github.com/deskree-inc/blok.git
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

### Python Runtime
```bash
RUNTIME_PYTHON3_HOST=localhost     # Python gRPC server host
RUNTIME_PYTHON3_PORT=50051        # Python gRPC server port
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

### Testing Environment
```bash
# Start all test infrastructure
docker compose -f infra/testing/docker-compose.yml up -d
# → PostgreSQL at localhost:5433 (user: blok, pass: blok_test)
# → Redis at localhost:6380
# → Kafka at localhost:9094
# → RabbitMQ at localhost:5673 (management: 15673)
# → NATS at localhost:4223 (monitoring: 8223)
# → Python runtime at localhost:50052
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

## First Workflow Example

### 1. Create a workflow file
**File:** `workflows/hello.json`
```json
{
  "name": "hello-world",
  "description": "A simple hello world workflow",
  "trigger": {
    "http": {
      "method": "GET",
      "path": "/hello"
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

### 2. Create a node
**File:** `src/nodes/greet/index.ts`
```typescript
import { z } from "zod";
import { defineNode } from "@nanoservice-ts/runner";

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

### 3. Test it
```bash
# Start dev server
pnpm http:dev

# Test with curl
curl http://localhost:4000/hello?name=Blok
# → { "message": "Hello, Blok!" }
```

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
# Run all tests
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

When a user runs `npx nanoctl@latest create project`, the CLI:

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

| Service | Port | Protocol |
|---------|------|----------|
| Blok HTTP | 4000 | HTTP |
| Blok Metrics | 9091 | HTTP (Prometheus) |
| Python Runtime | 50051 | gRPC |
| PostgreSQL | 5432 | TCP |
| Redis | 6379 | TCP |
| RabbitMQ | 5672 | AMQP |
| RabbitMQ Management | 15672 | HTTP |
| NATS | 4222 | TCP |
| NATS Monitoring | 8222 | HTTP |
| Kafka | 9092/9094 | TCP |
| Prometheus | 9090 | HTTP |
| Grafana | 3000 | HTTP |
| Loki | 3100 | HTTP |
| Tempo (gRPC) | 4317 | gRPC |
| Tempo (HTTP) | 4318 | HTTP |
| Adminer | 8080 | HTTP |
| Nginx | 80/443 | HTTP/HTTPS |

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
