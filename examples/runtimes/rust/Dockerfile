# Build stage
FROM rust:1.77-alpine AS builder

RUN apk add --no-cache musl-dev protobuf-dev protoc

WORKDIR /app

# Copy manifests for dependency caching
COPY Cargo.toml Cargo.lock ./

# Create dummy source to build deps first (layer caching)
RUN mkdir -p src && \
    echo 'fn main() {}' > src/main.rs && \
    echo '' > src/lib.rs && \
    mkdir -p proto && \
    echo 'syntax = "proto3"; package dummy; service Dummy { }' > proto/node.proto && \
    echo 'fn main() -> Result<(), Box<dyn std::error::Error>> { Ok(()) }' > build.rs && \
    cargo build --release 2>/dev/null || true && \
    rm -rf src proto build.rs

# Copy actual source
COPY . .

# Build the application
RUN cargo build --release

# Runtime stage
FROM alpine:latest

RUN apk --no-cache add ca-certificates

WORKDIR /app

# Copy the binary from builder
COPY --from=builder /app/target/release/blok-runtime .

# Expose HTTP and gRPC ports
EXPOSE 8080
EXPOSE 50051

# Set environment variables
ENV PORT=8080
ENV GRPC_PORT=50051
ENV ENABLE_GRPC=false
ENV RUST_LOG=info

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:8080/health || exit 1

# Run the application
CMD ["./blok-runtime"]
