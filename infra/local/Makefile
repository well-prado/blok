# Local Blok dev environment — Docker Compose and/or local Kubernetes (kind).
# The Kubernetes path uses the SAME chart (../helm/blok) that deploys to
# Hetzner / AWS / anywhere — only values-dev.yaml differs.
#
#   make k8s-up APP_DIR=/path/to/your/blok/project   # full local k8s bringup
#   make forward                                      # → http://localhost:4000
#   make k8s-down
#
#   make compose-up APP_DIR=...                        # or the lighter Docker path
#   make compose-down

IMAGE_REPO ?= blok/runtime
IMAGE_TAG  ?= dev
IMAGE      := $(IMAGE_REPO):$(IMAGE_TAG)
APP_DIR    ?=
CLUSTER    ?= blok-dev
NS         ?= blok
HERE       := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))
REPO       := $(abspath $(HERE)/../..)
CHART      := $(REPO)/infra/helm/blok
VALUES     := $(HERE)/values-dev.yaml

.DEFAULT_GOAL := help

.PHONY: help
help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | \
		awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

# --- image ---------------------------------------------------------------
.PHONY: image
image: ## Build blok/runtime:dev from your Blok project (APP_DIR=...)
	@test -n "$(APP_DIR)" || { echo "Set APP_DIR=/path/to/your/blok/project"; exit 1; }
	docker build -f $(REPO)/dockerfiles/Dockerfile.deploy.http -t $(IMAGE) $(APP_DIR)

.PHONY: stub
stub: ## Build a tiny /health-check stub as blok/runtime:dev (no app needed)
	docker build -t $(IMAGE) $(HERE)/healthcheck-stub

# --- docker compose path -------------------------------------------------
COMPOSE := docker compose -f $(REPO)/infra/development/docker-compose.yml -f $(HERE)/docker-compose.app.yml

.PHONY: compose-up
compose-up: ## Run app + postgres + redis + nats on Docker Compose
	$(COMPOSE) up -d
	@echo "→ http://localhost:4000/health-check"

.PHONY: compose-down
compose-down: ## Stop the Docker Compose stack
	$(COMPOSE) down

.PHONY: compose-logs
compose-logs: ## Tail the app container logs
	$(COMPOSE) logs -f blok

# --- local kubernetes (kind) path ---------------------------------------
.PHONY: cluster
cluster: ## Create the kind cluster (idempotent)
	@kind get clusters 2>/dev/null | grep -qx $(CLUSTER) || kind create cluster --name $(CLUSTER) --config $(HERE)/kind.yaml

.PHONY: load
load: ## Load the local image into the kind node
	kind load docker-image $(IMAGE) --name $(CLUSTER)

.PHONY: deploy
deploy: ## helm upgrade --install with the dev overlay
	helm upgrade --install blok $(CHART) -n $(NS) --create-namespace \
		-f $(VALUES) --set image.repository=$(IMAGE_REPO) --set image.tag=$(IMAGE_TAG)
	kubectl -n $(NS) rollout status deploy/blok --timeout=120s

.PHONY: k8s-up
k8s-up: cluster load deploy ## Full local k8s bringup (build the image first: make image|stub)
	@echo "Deployed. Run 'make forward' then: curl http://localhost:4000/health-check"

.PHONY: forward
forward: ## Port-forward the service to http://localhost:4000
	kubectl -n $(NS) port-forward svc/blok 4000:80

.PHONY: status
status: ## Show pods + service
	kubectl -n $(NS) get pods,svc

.PHONY: logs
logs: ## Tail pod logs
	kubectl -n $(NS) logs deploy/blok -f

.PHONY: k8s-down
k8s-down: ## Delete the kind cluster
	kind delete cluster --name $(CLUSTER)
