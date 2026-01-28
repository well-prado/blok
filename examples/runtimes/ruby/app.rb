# frozen_string_literal: true

require "sinatra/base"
require "json"
require_relative "lib/blok"

module Blok
  # RuntimeApp is the Sinatra HTTP server for the Blok Ruby runtime.
  #
  # It exposes two endpoints:
  #   POST /execute  - Execute a registered node
  #   GET  /health   - Return runtime health status
  class RuntimeApp < Sinatra::Base
    VERSION = "1.0.0"

    configure do
      set :port, Integer(ENV.fetch("PORT", 8080))
      set :bind, "0.0.0.0"
      set :show_exceptions, false
      set :raise_errors, false
      set :logging, true
    end

    # Initialize the node registry and register built-in nodes
    def self.registry
      @registry ||= begin
        reg = NodeRegistry.new

        # Register nodes
        reg.register("hello-world", Nodes::HelloWorldNode.new)
        # Add more nodes here as needed:
        # reg.register("another-node", Nodes::AnotherNode.new)

        reg
      end
    end

    # -- Routes ----------------------------------------------------------------

    # POST /execute - Execute a registered node
    post "/execute" do
      content_type :json

      begin
        body = request.body.read
        raw  = JSON.parse(body)
        exec_request = ExecutionRequest.from_hash(raw)

        result = self.class.registry.execute(exec_request)
        JSON.generate(result.to_hash)
      rescue JSON::ParserError => e
        status 400
        result = ExecutionResult.new(
          success: false,
          errors: { "message" => "Invalid request body", "error" => e.message }
        )
        JSON.generate(result.to_hash)
      rescue StandardError => e
        status 500
        result = ExecutionResult.new(
          success: false,
          errors: { "message" => e.message, "type" => e.class.name }
        )
        JSON.generate(result.to_hash)
      end
    end

    # GET /health - Return runtime health status
    get "/health" do
      content_type :json
      health = self.class.registry.health(VERSION)
      JSON.generate(health.to_hash)
    end

    # Startup logging
    def self.boot!
      $stdout.puts "Blok Ruby Runtime v#{VERSION} starting on port #{settings.port}"
      $stdout.puts "Registered nodes: #{registry.size}"
    end
  end
end

# Trigger startup logging when loaded
Blok::RuntimeApp.boot!
