# Stage 1: Install dependencies
FROM php:8.2-cli-alpine AS builder

# Install Composer
COPY --from=composer:2 /usr/bin/composer /usr/bin/composer

WORKDIR /app

# spiral/roadrunner-worker requires ext-sockets (needs linux-headers to compile on alpine)
RUN apk add --no-cache linux-headers && docker-php-ext-install sockets

# Copy composer files first for better layer caching
COPY composer.json composer.lock* ./

# Install dependencies (no dev)
RUN composer install --no-dev --no-scripts --no-interaction --prefer-dist --optimize-autoloader --no-security-blocking

# Copy source code
COPY . .

# Regenerate autoloader with all files
RUN composer dump-autoload --optimize --no-dev

# Stage 2: Production image
FROM php:8.2-cli-alpine

# The RoadRunner daemon (`rr`) is a Go binary — grab it from the official image
# instead of downloading. It handles HTTP/2 + gRPC framing and dispatches each
# call to the PHP worker (bin/serve.php) over goridge pipes.
COPY --from=ghcr.io/roadrunner-server/roadrunner:2024.3.5 /usr/bin/rr /usr/bin/rr

# Install required PHP extensions (none needed beyond defaults for this SDK)
# Add ca-certificates for HTTPS requests in ApiCallNode
RUN apk add --no-cache ca-certificates

# ext-sockets is needed at runtime by spiral/roadrunner
RUN apk add --no-cache --virtual .ext-deps linux-headers && docker-php-ext-install sockets && apk del .ext-deps

WORKDIR /app

# Copy built application from builder
COPY --from=builder /app /app

# HTTP port (informational /health) + gRPC port (the runner only speaks gRPC).
EXPOSE 8080 10005

# Set default environment variables
ENV PORT=8080
ENV HOST=0.0.0.0
ENV GRPC_PORT=10005
ENV VERSION=1.0.0
ENV LOG_LEVEL=INFO
ENV ENABLE_CORS=false

# Readiness = the gRPC port accepts a TCP connection (matches the runner's probe).
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
    CMD php -r "exit(@fsockopen('127.0.0.1', (int)(getenv('GRPC_PORT') ?: 10005)) ? 0 : 1);" || exit 1

# Run the gRPC server via RoadRunner (rr starts `php bin/serve.php` with
# BLOK_TRANSPORT=grpc per .rr.yaml). The runner reaches PHP only over gRPC.
CMD ["rr", "serve", "-c", ".rr.yaml"]
