# frozen_string_literal: true

require_relative "../lib/blok"

# ChainTestNode is used in cross-runtime integration tests.
# It reads a chain array from the request body, appends its own entry,
# and returns the updated chain — proving data flows between languages.
class ChainTestNode < Blok::Node::NodeHandler
  def execute(ctx, _config)
    body = ctx.request.body

    # Read existing chain (default to empty array)
    chain = if body.is_a?(Hash) && body["chain"].is_a?(Array)
              body["chain"].dup
            else
              []
            end

    # Read origin
    origin = if body.is_a?(Hash) && body["origin"].is_a?(String)
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
