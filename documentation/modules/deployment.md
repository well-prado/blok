# Module Reference: Deployment & Infrastructure

> **Path:** `infra/`, `dockerfiles/`
> **Purpose:** Production deployment, containerization, orchestration, and infrastructure-as-code

## What It Does

Blok provides comprehensive deployment infrastructure including Docker containers, Docker Compose stacks (development, production, testing, monitoring), Kubernetes Helm charts, Terraform modules, AWS CloudFormation, Azure ARM templates, edge deployment, and multi-region configurations.

## Dockerfiles

### `dockerfiles/Dockerfile.deploy.http`
The main production Dockerfile that builds a Blok HTTP trigger application:
- **Base:** Python 3.11 slim + Node.js LTS
- **Process manager:** supervisord (manages Node.js + Python processes)
- **Ports:** 4000 (HTTP), 9091 (metrics)
- **Environment:**
  - `WORKFLOWS_PATH=/app/workflows`
  - `CONSOLE_LOG_ACTIVE=true`
  - `NODE_ENV=production`
  - `APP_NAME=nanoservice-http`

### `dockerfiles/Dockerfile`
Generic Blok container (without Python runtime).

### `dockerfiles/Dockerfile.node`
Node.js-only container for projects without Python nodes.

## Docker Compose Environments

### Development (`infra/development/docker-compose.yml`)
- PostgreSQL + Adminer
- Shared Docker network
- **Usage:** `docker compose -f infra/development/docker-compose.yml up`

### Production (`infra/docker-compose.production.yml`)
Full production stack:
- **Blok app** (3 replicas, 2 CPU / 2GB memory limit)
- **Redis** (caching, queues, rate limiting)
- **RabbitMQ** (message queuing)
- **NATS** (pub/sub with JetStream)
- **Nginx** (reverse proxy, TLS termination)
- **Monitoring profile:** Prometheus, Grafana, Loki, Tempo
- **Usage:**
  ```bash
  docker compose -f infra/docker-compose.production.yml up -d
  docker compose -f infra/docker-compose.production.yml --profile monitoring up -d
  docker compose -f infra/docker-compose.production.yml --profile full up -d
  ```
- **Environment variables:**
  - `PORT` (default: 4000)
  - `REDIS_PASSWORD`
  - `RABBITMQ_PASSWORD`
  - `SENTRY_DSN`
  - `GRAFANA_PASSWORD`
  - `BLOK_REPLICAS` (default: 3)

### Testing (`infra/testing/docker-compose.yml`)
Test infrastructure:
- PostgreSQL 16
- Redis 7
- Kafka (Bitnami, KRaft mode)
- RabbitMQ
- NATS with JetStream
- Python gRPC runtime
- **Usage:** `docker compose -f infra/testing/docker-compose.yml up -d`

### Monitoring (`infra/metrics/docker-compose.yml`)
Observability stack:
- Prometheus (metrics collection)
- Grafana (dashboards + visualization)
- Loki (log aggregation)
- Tempo (distributed tracing)
- Nginx (Loki proxy)
- **Usage:** `docker compose -f infra/metrics/docker-compose.yml up`

## Kubernetes / Helm

### Helm Chart (`infra/helm/blok/`)
```
infra/helm/blok/
├── Chart.yaml                      # Chart metadata
├── values.yaml                     # Default values
├── values-multiregion.yaml         # Multi-region values
└── templates/
    ├── _helpers.tpl                # Template helpers
    ├── configmap.yaml              # Configuration
    ├── deployment.yaml             # Pod deployment
    ├── service.yaml                # Kubernetes service
    ├── ingress.yaml                # Ingress rules
    ├── hpa.yaml                    # Horizontal Pod Autoscaler
    ├── pvc.yaml                    # Persistent Volume Claims
    ├── secret.yaml                 # Secrets
    ├── serviceaccount.yaml         # Service account
    ├── servicemonitor.yaml         # Prometheus ServiceMonitor
    └── NOTES.txt                   # Post-install notes
```

**Installation:**
```bash
helm install blok ./infra/helm/blok \
  --set image.repository=your-registry/blok \
  --set image.tag=latest \
  --set env.REDIS_URL=redis://redis:6379
```

## Terraform (`infra/terraform/`)
```
infra/terraform/
├── main.tf                         # Main infrastructure definition
├── variables.tf                    # Input variables
└── outputs.tf                      # Output values
```

## AWS CloudFormation (`infra/cloudformation/`)
```
infra/cloudformation/
└── blok-stack.yaml                 # Full AWS stack (ECS, RDS, ElastiCache, etc.)
```

## Azure ARM Templates (`infra/arm/`)
```
infra/arm/
└── blok-deploy.json                # Azure deployment template
```

## Edge Deployment (`infra/edge/`)
```
infra/edge/
└── edge-deployment.yaml            # Edge/CDN deployment configuration
```

## Multi-Region (`infra/multi-region/`)
```
infra/multi-region/
└── multi-region-deployment.yaml    # Cross-region deployment with failover
```

## CI/CD Pipelines

| Platform | File | Features |
|----------|------|----------|
| **GitHub Actions** | `.github/workflows/ci.yml` | Build, test, lint, security scan |
| **GitHub Actions** | `.github/workflows/security-scan.yml` | Snyk, dependency audit |
| **GitHub Actions** | `.github/workflows/perf-regression.yml` | Performance regression tests |
| **GitHub Actions** | `.github/workflows/license-check.yml` | License compliance |
| **GitLab CI** | `.gitlab-ci.yml` | Full pipeline (build, test, deploy) |
| **CircleCI** | `.circleci/config.yml` | Build and test |
| **Jenkins** | `Jenkinsfile` | Full pipeline |
| **Travis CI** | `.travis.yml` | Build and test |

## What to Document

1. **Docker quick start** — Building and running with Docker
2. **Docker Compose environments** — Dev, prod, test, monitoring
3. **Production deployment** — Step-by-step production setup
4. **Kubernetes** — Helm chart installation and configuration
5. **Cloud deployment** — AWS, Azure, Terraform guides
6. **CI/CD setup** — Per-platform pipeline setup guides
7. **Environment variables** — Complete reference
8. **Scaling** — Horizontal scaling, auto-scaling, multi-region
9. **SSL/TLS** — Certificate setup for production
10. **Monitoring in production** — Prometheus, Grafana, alerting
