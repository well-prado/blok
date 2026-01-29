# Build stage
FROM ruby:3.2-alpine AS builder

RUN apk add --no-cache build-base

WORKDIR /app

# Install dependencies
COPY Gemfile Gemfile.lock* ./
RUN bundle config set --local without 'development test' \
    && bundle install --jobs 4 --retry 3

# Copy application source
COPY . .

# Runtime stage
FROM ruby:3.2-alpine

RUN apk add --no-cache ca-certificates wget

WORKDIR /app

# Copy installed gems from builder
COPY --from=builder /usr/local/bundle /usr/local/bundle

# Copy application source
COPY --from=builder /app .

# Expose port
EXPOSE 8080

# Set environment variables
ENV PORT=8080
ENV RACK_ENV=production

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:8080/health || exit 1

# Run the application with Puma via Rack
CMD ["bundle", "exec", "puma", "-C", "-", "-b", "tcp://0.0.0.0:8080", "config.ru"]
