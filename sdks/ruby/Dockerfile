# Stage 1: Build
FROM ruby:3.2-alpine AS builder

RUN apk add --no-cache build-base

WORKDIR /app

COPY Gemfile blok.gemspec ./
COPY lib/blok/version.rb lib/blok/version.rb

RUN bundle install --without development test --jobs 4 --retry 3

COPY . .

# Stage 2: Production
FROM ruby:3.2-alpine

RUN apk add --no-cache libstdc++

WORKDIR /app

COPY --from=builder /usr/local/bundle /usr/local/bundle
COPY --from=builder /app /app

# HTTP port (informational /health) + gRPC port (the runner only speaks gRPC).
EXPOSE 8080 10006

ENV PORT=8080
ENV HOST=0.0.0.0
ENV GRPC_PORT=10006
ENV BLOK_TRANSPORT=grpc
ENV RACK_ENV=production

# bin/serve.rb honors BLOK_TRANSPORT and registers all 6 example nodes
# (typed-greet/chain-test included). `rackup config.ru` was HTTP-only and
# registered only 4 nodes — the runner reaches Ruby over gRPC.
CMD ["bundle", "exec", "ruby", "bin/serve.rb"]
