# Local Blok dev environment — Docker & Kubernetes

Run a Blok app locally two ways, both on Docker:

- **Docker Compose** — the app container + its backing services (postgres, redis, nats). Fast, simple.
- **Local Kubernetes (kind)** — the app on a real Kubernetes cluster running inside Docker, using the **same Helm chart** ([`../helm/blok`](../helm/blok)) that deploys to Hetzner, AWS, or anywhere. Only [`values-dev.yaml`](./values-dev.yaml) differs from production.

> **Why kind?** It runs Kubernetes *inside Docker* — no VM, no extra daemon. So "run everything on Docker" and "deploy anywhere via Kubernetes" are the same artifacts, just a different cluster.

## Prerequisites

`docker`, `kubectl`, `helm`, and [`kind`](https://kind.sigs.k8s.io/) (`brew install kind`). The Docker-Compose path needs only `docker`.

## Build the image once

The deployable unit is a built Blok **app** — your scaffolded project, containerized via [`dockerfiles/Dockerfile.deploy.http`](../../dockerfiles/Dockerfile.deploy.http) (it copies the project, `npm install && npm run build`, and runs every trigger + runtime under supervisord).

```bash
make image APP_DIR=/path/to/your/blok/project    # → blok/runtime:dev
```

No app handy? `make stub` builds a tiny `/health-check` responder as `blok/runtime:dev` so you can exercise the whole pipeline first.

## Docker Compose path

```bash
make compose-up      # app + postgres + redis + nats
curl http://localhost:4000/health-check
make compose-logs    # tail the app
make compose-down
```

It layers [`docker-compose.app.yml`](./docker-compose.app.yml) (just the `blok` service) on top of the existing [`../development/docker-compose.yml`](../development/docker-compose.yml) (the backing services) — no duplication.

## Local Kubernetes path

```bash
make image APP_DIR=/path/to/your/blok/project    # or: make stub
make k8s-up                                       # kind create + load + helm install + rollout
make forward                                      # → http://localhost:4000
curl http://localhost:4000/health-check
make status          # pods + service
make logs            # tail pod logs
make k8s-down        # delete the cluster
```

`make help` lists every target.

## Deploying to Hetzner / AWS / anywhere

Identical chart, different cluster and values — **no new artifacts**:

```bash
helm upgrade --install blok infra/helm/blok -n blok --create-namespace \
  --set image.repository=<your-registry>/blok-app --set image.tag=<sha> \
  -f your-prod-values.yaml
```

Point `kubectl` at your managed cluster (Hetzner kops/k3s, EKS, GKE, …), push the image to a registry it can pull, and set `ingress.enabled`, `autoscaling.enabled`, `monitoring.enabled`, and a real `traceStore.postgres.url` in your prod values. The local path above is a faithful rehearsal of that flow.

## What's verified

The pipeline is tested end-to-end: `make stub && make k8s-up` brings up a kind cluster, loads the image, installs the chart, the pod reaches `1/1 Running`, and `curl /health-check` returns `200`. Swapping `make stub` for `make image APP_DIR=...` is the only change for a real app.

## Note on LocalStack / AWS

LocalStack emulates AWS services — it's only useful once Blok provisions AWS resources (e.g. the future registry's object storage, or the [`../terraform`](../terraform) stack). A local *Blok runtime* needs none of it, so it's intentionally not part of this dev env. If you want a LocalStack-backed Terraform dry-run, that's a separate track — ask.
