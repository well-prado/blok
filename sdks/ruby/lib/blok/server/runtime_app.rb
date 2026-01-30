# frozen_string_literal: true

require "sinatra/base"
require "json"

module Blok
  module Server
    # RuntimeApp is a Sinatra-based HTTP server that exposes the Blok
    # blok protocol endpoints:
    #
    #   POST /execute  - Execute a node (JSON ExecutionRequest -> ExecutionResult)
    #   GET  /health   - Return runtime health status
    #
    # The app uses a singleton NodeRegistry that nodes register into at boot.
    #
    # @example config.ru
    #   require "blok"
    #
    #   registry = Blok::Server::RuntimeApp.registry
    #   registry.register("hello-world", HelloWorldNode.new)
    #
    #   run Blok::Server::RuntimeApp
    #
    class RuntimeApp < Sinatra::Base
      configure do
        set :show_exceptions, false
        set :raise_errors, false
        set :dump_errors, false
      end

      # Return the singleton registry.
      # @return [Blok::Node::NodeRegistry]
      def self.registry
        @registry ||= Node::NodeRegistry.new
      end

      # Set the registry (useful for testing).
      # @param reg [Blok::Node::NodeRegistry]
      def self.registry=(reg)
        @registry = reg
      end

      # POST /execute
      # Accepts a JSON ExecutionRequest body, dispatches to the node registry,
      # and returns a JSON ExecutionResult.
      post "/execute" do
        content_type :json

        body = request.body.read

        begin
          parsed = JSON.parse(body)
        rescue JSON::ParserError => e
          status 400
          return JSON.generate(
            Types::ExecutionResult.error("invalid JSON: #{e.message}").to_hash
          )
        end

        execution_request = Types::ExecutionRequest.from_hash(parsed)
        result = self.class.registry.execute(execution_request)

        status 200
        JSON.generate(result.to_hash)
      end

      # GET /health
      # Returns the health status of the runtime with loaded nodes.
      get "/health" do
        content_type :json
        health = self.class.registry.health
        JSON.generate(health.to_hash)
      end

      # Handle unexpected errors gracefully.
      error do
        content_type :json
        err = env["sinatra.error"]
        status 200
        JSON.generate(
          Types::ExecutionResult.error("internal server error: #{err&.message}").to_hash
        )
      end
    end
  end
end
