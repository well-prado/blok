# frozen_string_literal: true

module Nanoservice
  module Errors
    # NodeError represents a structured error from node execution.
    # It carries a human-readable message, an HTTP-style code, an error category,
    # and optional structured details.
    class NodeError < StandardError
      attr_reader :node_message, :code, :category, :details

      # @param message [String] Human-readable error message
      # @param code [Integer] HTTP-style error code
      # @param category [String] One of ErrorCategory constants
      # @param details [Hash, nil] Optional structured error details
      def initialize(message, code:, category:, details: nil)
        @node_message = message
        @code         = code
        @category     = category
        @details      = details
        super(message)
      end

      # Create a validation error (400).
      # @param message [String] Error message
      # @return [NodeError]
      def self.validation(message)
        new(message, code: 400, category: ErrorCategory::VALIDATION)
      end

      # Create an execution error (500).
      # @param message [String] Error message
      # @return [NodeError]
      def self.execution(message)
        new(message, code: 500, category: ErrorCategory::EXECUTION)
      end

      # Create a configuration error (500).
      # @param message [String] Error message
      # @return [NodeError]
      def self.configuration(message)
        new(message, code: 500, category: ErrorCategory::CONFIGURATION)
      end

      # Create a network error (502).
      # @param message [String] Error message
      # @return [NodeError]
      def self.network(message)
        new(message, code: 502, category: ErrorCategory::NETWORK)
      end

      # Create a not-found error (404).
      # @param message [String] Error message
      # @return [NodeError]
      def self.not_found(message)
        new(message, code: 404, category: ErrorCategory::NOT_FOUND)
      end

      # Attach details to the error (returns a new instance).
      # @param details [Hash] Additional details
      # @return [NodeError]
      def with_details(details)
        self.class.new(@node_message, code: @code, category: @category, details: details)
      end

      # Convert to a Hash for JSON serialization.
      # @return [Hash]
      def to_hash
        h = {
          "message"  => @node_message,
          "code"     => @code,
          "category" => @category
        }
        h["details"] = @details unless @details.nil?
        h
      end

      # Display format: [CATEGORY] message
      # @return [String]
      def to_s
        "[#{@category}] #{@node_message}"
      end
    end
  end
end
