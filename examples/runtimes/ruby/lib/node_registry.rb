# frozen_string_literal: true

module Blok
  # NodeRegistry manages registered node handlers.
  #
  # It provides methods to register, retrieve, and execute node handlers,
  # as well as report health status for the runtime.
  class NodeRegistry
    def initialize
      @nodes = {}
    end

    # Register a node handler with the given name.
    #
    # @param name [String] the unique name for this node
    # @param handler [Blok::NodeHandler] the handler instance
    # @return [void]
    def register(name, handler)
      @nodes[name] = handler
    end

    # Retrieve a node handler by name.
    #
    # @param name [String] the node name
    # @return [Blok::NodeHandler] the registered handler
    # @raise [KeyError] if the node is not found
    def get(name)
      unless @nodes.key?(name)
        raise KeyError, "Node '#{name}' not found"
      end

      @nodes[name]
    end

    # Execute a node by processing an ExecutionRequest.
    #
    # Looks up the handler by node name, runs it, and wraps the result
    # in an ExecutionResult. Errors are caught and returned as a failed result.
    #
    # @param request [Blok::ExecutionRequest] the execution request
    # @return [Blok::ExecutionResult] the execution result
    def execute(request)
      handler = get(request.node.name)
      data = handler.execute(request.context, request.node.config)

      ExecutionResult.new(success: true, data: data)
    rescue StandardError => e
      ExecutionResult.new(
        success: false,
        data: nil,
        errors: { "message" => e.message, "type" => e.class.name }
      )
    end

    # Return health status for the runtime.
    #
    # @param version [String] the runtime version string
    # @return [Blok::HealthStatus]
    def health(version)
      HealthStatus.new(
        version: version,
        nodes_loaded: @nodes.keys
      )
    end

    # Return the number of registered nodes.
    #
    # @return [Integer]
    def size
      @nodes.size
    end
  end
end
