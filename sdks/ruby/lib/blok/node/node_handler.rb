# frozen_string_literal: true

module Blok
  module Node
    # NodeHandler is the base class that all Blok nodes must inherit from.
    #
    # Subclasses must implement the +execute+ method which receives the
    # workflow context and node-specific configuration, and returns a
    # data hash (or any JSON-serializable value).
    #
    # @example
    #   class GreetNode < Blok::Node::NodeHandler
    #     def execute(ctx, config)
    #       name = ctx.request.body_str("name") || "World"
    #       prefix = config["prefix"] || "Hello"
    #       { "message" => "#{prefix}, #{name}!" }
    #     end
    #   end
    #
    class NodeHandler
      # Execute the node logic.
      #
      # @param ctx [Blok::Types::Context] The workflow execution context
      # @param config [Hash] Node-specific configuration
      # @return [Object] JSON-serializable result data
      # @raise [NotImplementedError] if not overridden by a subclass
      def execute(ctx, config)
        raise NotImplementedError, "#{self.class}#execute must be implemented"
      end
    end
  end
end
