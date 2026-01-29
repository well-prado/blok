# Stage 1: Build
FROM ruby:3.2-alpine AS builder

RUN apk add --no-cache build-base

WORKDIR /app

COPY Gemfile nanoservice.gemspec ./
COPY lib/nanoservice/version.rb lib/nanoservice/version.rb

RUN bundle install --without development test --jobs 4 --retry 3

COPY . .

# Stage 2: Production
FROM ruby:3.2-alpine

RUN apk add --no-cache libstdc++

WORKDIR /app

COPY --from=builder /usr/local/bundle /usr/local/bundle
COPY --from=builder /app /app

EXPOSE 8080

ENV PORT=8080
ENV HOST=0.0.0.0
ENV RACK_ENV=production

CMD ["bundle", "exec", "rackup", "--host", "0.0.0.0", "--port", "8080", "config.ru"]
