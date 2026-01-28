# frozen_string_literal: true

require_relative "../node_handler"

module Blok
  module Nodes
    # HelloWorldNode is an example Blok node in Ruby.
    #
    # It reads a +name+ from the request body and an optional +prefix+
    # from the node config, then returns a greeting message.
    class HelloWorldNode < Blok::NodeHandler
      # Execute the hello-world node.
      #
      # @param ctx [Blok::Context] the workflow execution context
      # @param config [Hash] the node configuration (supports "prefix" key)
      # @return [Hash] a hash containing the greeting message, timestamp, and language
      def execute(ctx, config)
        # Get name from request body or use default
        name = "World"
        body = ctx.request.body
        if body.is_a?(Hash) && body.key?("name")
          name = body["name"].to_s
        end

        # Get greeting prefix from config or use default
        prefix = config&.fetch("prefix", nil) || "Hello"

        message = "#{prefix}, #{name}!"

        # Store in context vars for downstream nodes
        ctx.vars["greeting"]  = message
        ctx.vars["timestamp"] = Time.now.to_i

        # Return response
        {
          "message"   => message,
          "timestamp" => Time.now.iso8601,
          "language"  => "Ruby"
        }
      end
    end
  end
end
