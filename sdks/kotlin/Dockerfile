FROM gradle:8.10.2-jdk17 AS build

WORKDIR /app
COPY . .
RUN ./gradlew installDist --no-daemon

FROM eclipse-temurin:17-jre

RUN apt-get update \
    && apt-get install -y --no-install-recommends wget \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 blok \
    && useradd --system --uid 10001 --gid 10001 --home-dir /nonexistent --shell /usr/sbin/nologin blok
WORKDIR /app
COPY --from=build --chown=blok:blok /app/build/install/blok-kotlin /app

ENV HOST=0.0.0.0 \
    PORT=9011 \
    GRPC_PORT=10011 \
    BLOK_TRANSPORT=grpc
EXPOSE 9011 10011
USER 10001

HEALTHCHECK --interval=10s --timeout=3s --retries=12 CMD ["/bin/sh", "-c", "command -v wget >/dev/null && wget -qO- http://127.0.0.1:9011/health >/dev/null || exit 1"]
ENTRYPOINT ["/app/bin/blok-kotlin"]
