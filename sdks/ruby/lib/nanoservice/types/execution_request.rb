# frozen_string_literal: true

module Nanoservice
  module Types
    # ExecutionRequest is the request received from the Blok runner.
    # It wraps the node configuration and the workflow execution context.
    class ExecutionRequest
      attr_accessor :node, :context

      # @param node [NodeConfig] Node configuration
      # @param context [Context] Workflow execution context
      def initialize(node: nil, context: nil)
        @node    = node || NodeConfig.new
        @context = context || Context.new
      end

      # Build an ExecutionRequest from a Hash (JSON-parsed).
      # @param hash [Hash] the parsed JSON hash
      # @return [ExecutionRequest]
      def self.from_hash(hash)
        return new if hash.nil?

        new(
          node:    NodeConfig.from_hash(hash["node"]),
          context: Context.from_hash(hash["context"])
        )
      end

      # Serialize to a Hash suitable for JSON output.
      # @return [Hash]
      def to_hash
        {
          "node"    => @node.to_hash,
          "context" => @context.to_hash
        }
      end
    end
  end
end
