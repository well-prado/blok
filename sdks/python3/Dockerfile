# Build stage
FROM python:3.12-slim AS builder

WORKDIR /app

# Copy requirements first for layer caching
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy source
COPY . .

# Runtime stage (HTTP server - default)
FROM python:3.12-slim AS runtime

WORKDIR /app

COPY --from=builder /app /app

# gRPC transport needs grpcio (the `[grpc]` extra) — the runner speaks gRPC
RUN pip install --no-cache-dir 'grpcio>=1.60' 'grpcio-health-checking>=1.60'

EXPOSE 8080

ENV PORT=8080
ENV HOST=0.0.0.0
ENV VERSION=1.0.0

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health')" || exit 1

ENTRYPOINT ["python3", "bin/serve.py"]

# Worker stage (NATS JetStream background jobs)
FROM python:3.12-slim AS worker

WORKDIR /app

COPY --from=builder /app /app

RUN pip install --no-cache-dir nats-py>=2.9.0

EXPOSE 8080

ENV PORT=8080
ENV HOST=0.0.0.0
ENV VERSION=1.0.0
ENV NATS_SERVERS=localhost:4222
ENV NATS_STREAM_NAME=blok-worker
ENV WORKER_CONCURRENCY=1
ENV WORKER_MAX_RETRIES=3
ENV WORKER_ACK_WAIT_SECS=30

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health')" || exit 1

ENTRYPOINT ["python3", "bin/worker.py"]
