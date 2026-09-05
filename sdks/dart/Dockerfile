# Standalone Dart sidecar. Flutter is intentionally absent.
FROM dart:3.13.3 AS build

WORKDIR /app
COPY pubspec.yaml pubspec.lock ./
RUN dart pub get --offline || dart pub get
COPY . .
RUN dart compile exe bin/serve.dart -o bin/blok-dart

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install --no-install-recommends --yes netcat-openbsd \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 --shell /usr/sbin/nologin blok
WORKDIR /app
COPY --from=build /app/bin/blok-dart /app/bin/blok-dart
USER blok
ENV HOST=0.0.0.0 \
    PORT=9008 \
    GRPC_PORT=10008 \
    BLOK_TRANSPORT=grpc
EXPOSE 9008 10008
HEALTHCHECK --interval=5s --timeout=2s --retries=12 CMD /bin/sh -c 'nc -z 127.0.0.1 "$${GRPC_PORT}"'
ENTRYPOINT ["/app/bin/blok-dart"]
