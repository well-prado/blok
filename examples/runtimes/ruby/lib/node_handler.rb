# frozen_string_literal: true

module Blok
  # NodeHandler is the base class that all Blok nodes must inherit from.
  #
  # Subclasses must implement the +execute+ method to define the node's behavior.
  #
  # @example
  #   class MyNode < Blok::NodeHandler
  #     def execute(ctx, config)
  #       name = ctx.request.body&.dig("name") || "World"
  #       { "message" => "Hello, #{name}!" }
  #     end
  #   end
  #
  class NodeHandler
    # Execute the node logic.
    #
    # @param ctx [Blok::Context] the workflow execution context
    # @param config [Hash] the node-specific configuration
    # @return [Object] the result data to be returned in the execution result
    # @raise [NotImplementedError] if the subclass does not implement this method
    def execute(ctx, config)
      raise NotImplementedError, "#{self.class}#execute must be implemented by the subclass"
    end
  end
end
