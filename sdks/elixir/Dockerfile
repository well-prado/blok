FROM hexpm/elixir:1.20.4-erlang-29.0.6-ubuntu-jammy-20260810 AS build

WORKDIR /app
ENV MIX_ENV=prod

COPY mix.exs mix.lock .formatter.exs ./
COPY config ./config
COPY proto ./proto
COPY lib ./lib
RUN mix deps.get --only prod
RUN mix release

FROM ubuntu:24.04 AS runtime
RUN useradd --create-home --uid 10001 blok
WORKDIR /app
ENV HOME=/home/blok MIX_ENV=prod LANG=C.UTF-8
COPY --from=build --chown=blok:blok /app/_build/prod/rel/blok ./
USER blok
EXPOSE 10010
ENTRYPOINT ["/app/bin/blok"]
CMD ["start"]
