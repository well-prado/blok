# frozen_string_literal: true

module Blok
  module Testing
    # MockContext provides a fluent builder for creating test workflow contexts.
    #
    # @example
    #   ctx = Blok::Testing::MockContext.new
    #     .with_id("test-123")
    #     .with_body({ "name" => "World" })
    #     .with_var("key", "value")
    #     .build
    #
    class MockContext
      def initialize
        @id            = "test-execution-id"
        @workflow_name = "test-workflow"
        @workflow_path = "/workflows/test"
        @body          = {}
        @headers       = {}
        @method        = "POST"
        @url           = "/test"
        @vars          = {}
        @env           = {}
      end

      # Set the execution ID.
      # @param id [String]
      # @return [self]
      def with_id(id)
        @id = id
        self
      end

      # Set the workflow name and path.
      # @param name [String]
      # @param path [String]
      # @return [self]
      def with_workflow(name, path = "/workflows/#{name}")
        @workflow_name = name
        @workflow_path = path
        self
      end

      # Set the request body.
      # @param body [Hash] Request body
      # @return [self]
      def with_body(body)
        @body = body
        self
      end

      # Set the request headers.
      # @param headers [Hash<String, String>]
      # @return [self]
      def with_headers(headers)
        @headers = headers
        self
      end

      # Set the request method.
      # @param method [String] HTTP method
      # @return [self]
      def with_method(method)
        @method = method
        self
      end

      # Set a context variable.
      # @param key [String] Variable name
      # @param value [Object] Variable value
      # @return [self]
      def with_var(key, value)
        @vars[key] = value
        self
      end

      # Set an environment variable.
      # @param key [String] Variable name
      # @param value [String] Variable value
      # @return [self]
      def with_env(key, value)
        @env[key] = value
        self
      end

      # Build the Context instance.
      # @return [Blok::Types::Context]
      def build
        request = Types::Request.new(
          body:     @body,
          headers:  @headers,
          method:   @method,
          url:      @url,
          base_url: "http://localhost:8080"
        )

        Types::Context.new(
          id:            @id,
          workflow_name: @workflow_name,
          workflow_path: @workflow_path,
          request:       request,
          vars:          @vars,
          env:           @env
        )
      end
    end
  end
end
