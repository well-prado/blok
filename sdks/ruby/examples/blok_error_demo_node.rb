# frozen_string_literal: true

require_relative "../lib/blok"

# Example node demonstrating the structured +Blok::Errors::BlokError+ API per
# master plan §17.
#
# Used by the cross-language E2E test
# (+core/runner/__tests__/integration/runtimes/ruby-grpc.integration.test.ts+)
# to verify that a Ruby-side structured error flows through the gRPC wire to
# the runner with every field preserved (category, severity, code,
# remediation, retryable hints, cause chain, context snapshot).
#
# Triggered via the +mode+ config:
# - +mode = "dependency"+ (default) — raises +BlokError.dependency+ with a
#   cause chain rooted in a +SocketError+.
# - +mode = "rate-limit"+ — raises +BlokError.rate_limit+ with +retry_after_ms+.
# - +mode = "validation"+ — raises +BlokError.validation+ with +details["issues"]+.
# - +mode = "ok"+ — returns success.
class BlokErrorDemoNode < Blok::Node::NodeHandler
  def execute(ctx, config)
    mode = config["mode"] || "dependency"

    if mode == "ok"
      return { "ok" => true, "language" => "ruby" }
    end

    snapshot = Blok::Errors::BuildContextSnapshot.of(
      inputs: config,
      vars: ctx.respond_to?(:vars) ? (ctx.vars || {}) : {}
    )

    case mode
    when "rate-limit"
      raise Blok::Errors::BlokError.rate_limit(
        code: "UPSTREAM_RATE_LIMITED",
        message: "Upstream API returned 429",
        description: "GitHub API rate limit hit (5000 req/hr).",
        remediation: "Wait until the X-RateLimit-Reset header timestamp.",
        retry_after_ms: 60_000,
        doc_url: "https://docs.example.com/errors/rate-limit",
        details: { "limit" => 5000, "remaining" => 0 },
        context_snapshot: snapshot
      )
    when "validation"
      raise Blok::Errors::BlokError.validation(
        code: "VALIDATION_FAILED",
        message: "2 validation issues",
        description: "Inputs didn't match the node's schema.",
        remediation: "Provide both `email` and `name`.",
        details: {
          "issues" => [
            { "path" => ["email"], "message" => "Required" },
            { "path" => ["name"],  "message" => "Required" }
          ]
        },
        context_snapshot: snapshot
      )
    else
      # default: dependency with a cause chain rooted in a SocketError.
      begin
        raise SocketError, "[Errno 61] Connection refused"
      rescue SocketError => cause
        raise Blok::Errors::BlokError.dependency(
          code: "POSTGRES_CONNECT_TIMEOUT",
          message: "Could not connect to Postgres within 5s",
          description: "Tried host=db.internal port=5432; timeout=5000ms",
          remediation: "Check DATABASE_URL env var and network reachability",
          cause: cause,
          retryable: true,
          retry_after_ms: 5_000,
          doc_url: "https://docs.example.com/errors/POSTGRES_CONNECT_TIMEOUT",
          details: { "host" => "db.internal", "port" => 5432, "timeout_ms" => 5000 },
          context_snapshot: snapshot
        )
      end
    end
  end
end
