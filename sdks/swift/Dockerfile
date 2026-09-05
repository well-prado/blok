FROM swift:6.1-jammy AS build

WORKDIR /src
COPY . .
RUN swift build -c release --product blok-swift-runtime

FROM swift:6.1-jammy

RUN useradd --create-home --uid 10001 blok
WORKDIR /app
COPY --from=build /src/.build/release/blok-swift-runtime /app/blok-swift-runtime
USER blok

ENV HOST=0.0.0.0 \
    HEALTH_PORT=9008 \
    GRPC_PORT=10008 \
    BLOK_TRANSPORT=grpc \
    BLOK_GRPC_MAX_MESSAGE_BYTES=16777216
EXPOSE 9008 10008
ENTRYPOINT ["/app/blok-swift-runtime"]
