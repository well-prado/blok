# frozen_string_literal: true

module Nanoservice
  module Node
    # NodeRegistry manages registered node handlers and dispatches
    # execution requests. It holds a map of node names to handler instances,
    # applies middleware, and measures execution timing.
    class NodeRegistry
      # @param version [String] Runtime version string
      def initialize(version = Nanoservice::VERSION)
        @nodes      = {}
        @middlewares = []
        @version    = version
      end

      # Register a node handler under the given name.
      # @param name [String] Node name (used for dispatch)
      # @param handler [NodeHandler] Handler instance
      def register(name, handler)
        @nodes[name] = handler
      end

      # Look up a node handler by name.
      # @param name [String] Node name
      # @return [NodeHandler, nil]
      def get(name)
        @nodes[name]
      end

      # Add a middleware to the execution pipeline.
      # @param middleware [Middleware::Middleware] Middleware instance
      def use(middleware)
        @middlewares << middleware
      end

      # Return the names of all registered nodes.
      # @return [Array<String>]
      def node_names
        @nodes.keys.sort
      end

      # Execute a node by dispatching through the registry.
      # Returns an ExecutionResult with timing metrics.
      #
      # @param execution_request [Types::ExecutionRequest] The execution request
      # @return [Types::ExecutionResult]
      def execute(execution_request)
        node_name = execution_request.node.name
        handler   = get(node_name)

        unless handler
          return Types::ExecutionResult.error("node '#{node_name}' not found in registry")
        end

        # Build a callable that invokes the handler
        callable = ->(ctx, config) { handler.execute(ctx, config) }

        # Apply middleware chain (each middleware wraps the callable)
        @middlewares.each do |mw|
          callable = mw.wrap(callable)
        end

        start_time = Process.clock_gettime(Process::CLOCK_MONOTONIC)

        begin
          data = callable.call(execution_request.context, execution_request.node.config)
          duration_ms = (Process.clock_gettime(Process::CLOCK_MONOTONIC) - start_time) * 1000.0

          metrics = Types::ExecutionMetrics.new(duration_ms: duration_ms)
          result = Types::ExecutionResult.success_with_metrics(data, metrics)

          # Include context vars so the runner can propagate them downstream
          ctx_vars = execution_request.context.vars
          result.with_vars(ctx_vars) if ctx_vars && !ctx_vars.empty?

          result
        rescue Errors::NodeError => e
          duration_ms = (Process.clock_gettime(Process::CLOCK_MONOTONIC) - start_time) * 1000.0
          result = Types::ExecutionResult.error_with_details(e.message, e.to_hash)
          result.with_metrics(Types::ExecutionMetrics.new(duration_ms: duration_ms))
        rescue StandardError => e
          duration_ms = (Process.clock_gettime(Process::CLOCK_MONOTONIC) - start_time) * 1000.0
          result = Types::ExecutionResult.error(e.message)
          result.with_metrics(Types::ExecutionMetrics.new(duration_ms: duration_ms))
        end
      end

      # Return the health status of the runtime.
      # @return [Types::HealthStatus]
      def health
        Types::HealthStatus.new(
          status:       "healthy",
          version:      @version,
          nodes_loaded: node_names
        )
      end
    end
  end
end
