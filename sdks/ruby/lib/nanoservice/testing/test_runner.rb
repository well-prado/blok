# frozen_string_literal: true

module Nanoservice
  module Testing
    # TestRunner provides in-process node execution for testing.
    # Register nodes, then execute them with mock contexts and configs.
    #
    # @example
    #   runner = Nanoservice::Testing::TestRunner.new
    #   runner.register("greet", GreetNode.new)
    #   result = runner.execute("greet", ctx, { "prefix" => "Hi" })
    #   assert result.success
    #
    class TestRunner
      def initialize
        @registry = Node::NodeRegistry.new("test")
      end

      # Register a node handler for testing.
      # @param name [String] Node name
      # @param handler [Node::NodeHandler] Handler instance
      # @return [self]
      def register(name, handler)
        @registry.register(name, handler)
        self
      end

      # Execute a node with a context and optional config.
      # @param name [String] Node name
      # @param ctx [Types::Context] Workflow context
      # @param config [Hash] Node configuration
      # @return [Types::ExecutionResult]
      def execute(name, ctx, config = {})
        node_config = Types::NodeConfig.new(name: name, config: config)
        request     = Types::ExecutionRequest.new(node: node_config, context: ctx)
        @registry.execute(request)
      end
    end
  end
end
