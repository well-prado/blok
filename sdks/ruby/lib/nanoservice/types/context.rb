# frozen_string_literal: true

module Nanoservice
  module Types
    # Context represents the workflow execution context passed between nodes.
    # It carries the request data, response state, variables, and environment.
    class Context
      attr_accessor :id, :workflow_name, :workflow_path, :request, :response, :vars, :env

      # @param id [String] Unique execution identifier
      # @param workflow_name [String] Name of the executing workflow
      # @param workflow_path [String] Path of the executing workflow
      # @param request [Request] Incoming request data
      # @param response [Response] Accumulated response data
      # @param vars [Hash] Variables shared between nodes
      # @param env [Hash] Environment variables
      def initialize(id: "", workflow_name: "", workflow_path: "",
                     request: nil, response: nil, vars: {}, env: {})
        @id            = id
        @workflow_name = workflow_name
        @workflow_path = workflow_path
        @request       = request || Request.new
        @response      = response || Response.new
        @vars          = vars
        @env           = env
      end

      # Build a Context from a Hash (JSON-parsed).
      # @param hash [Hash] the parsed JSON hash
      # @return [Context]
      def self.from_hash(hash)
        return new if hash.nil?

        new(
          id:            hash["id"] || "",
          workflow_name: hash["workflow_name"] || "",
          workflow_path: hash["workflow_path"] || "",
          request:       Request.from_hash(hash["request"]),
          response:      Response.from_hash(hash["response"]),
          vars:          hash["vars"] || {},
          env:           hash["env"] || {}
        )
      end

      # Serialize to a Hash suitable for JSON output.
      # @return [Hash]
      def to_hash
        {
          "id"            => @id,
          "workflow_name" => @workflow_name,
          "workflow_path" => @workflow_path,
          "request"       => @request.to_hash,
          "response"      => @response.to_hash,
          "vars"          => @vars,
          "env"           => @env
        }
      end

      # Store a variable in context for downstream nodes.
      # @param key [String] Variable name
      # @param value [Object] Variable value
      def set_var(key, value)
        @vars[key] = value
      end

      # Retrieve a variable from context.
      # @param key [String] Variable name
      # @return [Object, nil]
      def get_var(key)
        @vars[key]
      end

      # Retrieve a string variable from context.
      # @param key [String] Variable name
      # @return [String, nil]
      def get_var_str(key)
        val = @vars[key]
        val.is_a?(String) ? val : nil
      end
    end
  end
end
