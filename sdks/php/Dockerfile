# Stage 1: Install dependencies
FROM php:8.2-cli-alpine AS builder

# Install Composer
COPY --from=composer:2 /usr/bin/composer /usr/bin/composer

WORKDIR /app

# Copy composer files first for better layer caching
COPY composer.json composer.lock* ./

# Install dependencies (no dev)
RUN composer install --no-dev --no-scripts --no-interaction --prefer-dist --optimize-autoloader

# Copy source code
COPY . .

# Regenerate autoloader with all files
RUN composer dump-autoload --optimize --no-dev

# Stage 2: Production image
FROM php:8.2-cli-alpine

# Install required PHP extensions (none needed beyond defaults for this SDK)
# Add ca-certificates for HTTPS requests in ApiCallNode
RUN apk add --no-cache ca-certificates

WORKDIR /app

# Copy built application from builder
COPY --from=builder /app /app

# Expose the default port
EXPOSE 8080

# Set default environment variables
ENV PORT=8080
ENV HOST=0.0.0.0
ENV VERSION=1.0.0
ENV LOG_LEVEL=INFO
ENV ENABLE_CORS=false

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD php -r "echo file_get_contents('http://localhost:${PORT}/health');" || exit 1

# Run the server
CMD ["php", "bin/serve.php"]
