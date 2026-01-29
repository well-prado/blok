# Build stage - install dependencies
FROM php:8.2-cli-alpine AS builder

WORKDIR /app

# Install composer
COPY --from=composer:2 /usr/bin/composer /usr/bin/composer

# Copy composer files first for caching
COPY composer.json ./

# Install dependencies
RUN composer install --no-dev --optimize-autoloader --no-interaction --no-progress

# Copy source code
COPY . .

# Rebuild autoloader with all source files
RUN composer dump-autoload --optimize --no-dev

# Runtime stage
FROM php:8.2-cli-alpine

WORKDIR /app

# Copy application with dependencies from builder
COPY --from=builder /app /app

# Expose port
EXPOSE 8080

# Set environment variables
ENV PORT=8080

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:8080/health || exit 1

# Run the application
CMD ["php", "index.php"]
