# Build stage
FROM rust:1.84-alpine AS builder

RUN apk add --no-cache musl-dev pkgconfig openssl-dev openssl-libs-static

WORKDIR /app

COPY Cargo.toml Cargo.lock* ./

# Create dummy source for dependency caching
RUN mkdir -p src && \
    echo 'fn main() {}' > src/main.rs && \
    echo '' > src/lib.rs && \
    cargo build --release 2>/dev/null || true && \
    rm -rf src

COPY . .
RUN cargo build --release

# Runtime stage
FROM alpine:3.19
RUN apk --no-cache add ca-certificates
WORKDIR /app
COPY --from=builder /app/target/release/blok .

EXPOSE 8080

ENV PORT=8080
ENV VERSION=1.0.0
ENV RUST_LOG=info

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/health || exit 1

ENTRYPOINT ["./blok"]
