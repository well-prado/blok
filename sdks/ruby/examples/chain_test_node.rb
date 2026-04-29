# frozen_string_literal: true

require_relative "../lib/blok"

# ChainTestNode is used in cross-runtime integration tests.
# It reads a chain array from the request body, appends its own entry,
# and returns the updated chain — proving data flows between languages.
class ChainTestNode < Blok::Node::NodeHandler
  def execute(ctx, config)
    body = ctx.request.body

    # Read existing chain — gRPC inputs first (carried on `node.config`),
    # HTTP body fallback (legacy wire shape where the runner mapped
    # resolvedInputs → request.body). Dual-read keeps the
    # cross-runtime-chain demo working over both transports during the
    # §11 deprecation window.
    chain =
      if config.is_a?(Hash) && config["chain"].is_a?(Array)
        config["chain"].dup
      elsif body.is_a?(Hash) && body["chain"].is_a?(Array)
        body["chain"].dup
      else
        []
      end

    # Read origin — same dual-read.
    origin =
      if config.is_a?(Hash) && config["origin"].is_a?(String) && !config["origin"].empty?
        config["origin"]
      elsif body.is_a?(Hash) && body["origin"].is_a?(String)
        body["origin"]
      else
        "unknown"
      end

    # Append this language's entry
    chain << {
      "language"  => "ruby",
      "order"     => chain.length + 1,
      "timestamp" => Time.now.utc.iso8601
    }

    # Store in context vars
    ctx.set_var("chain", chain)

    {
      "chain"  => chain,
      "origin" => origin
    }
  end
end
