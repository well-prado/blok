# Build stage
FROM python:3.12-slim AS builder

WORKDIR /app

# Copy requirements first for layer caching
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy source
COPY . .

# Runtime stage
FROM python:3.12-slim

WORKDIR /app

COPY --from=builder /app /app

EXPOSE 8080

ENV PORT=8080
ENV HOST=0.0.0.0
ENV VERSION=1.0.0

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health')" || exit 1

ENTRYPOINT ["python3", "bin/serve.py"]
