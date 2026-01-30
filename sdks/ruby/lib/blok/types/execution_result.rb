# frozen_string_literal: true

module Blok
  module Types
    # ExecutionResult is the response returned to the Blok runner after node execution.
    class ExecutionResult
      attr_accessor :success, :data, :errors, :logs, :metrics, :vars

      # @param success [Boolean] Whether execution succeeded
      # @param data [Object] Result data payload
      # @param errors [Object, nil] Error information
      # @param logs [Array<String>, nil] Log lines captured during execution
      # @param metrics [ExecutionMetrics, nil] Performance metrics
      def initialize(success:, data:, errors: nil, logs: nil, metrics: nil, vars: nil)
        @success = success
        @data    = data
        @errors  = errors
        @logs    = logs
        @metrics = metrics
        @vars    = vars
      end

      # Create a successful result.
      # @param data [Object] Result data payload
      # @return [ExecutionResult]
      def self.success(data)
        new(success: true, data: data)
      end

      # Create a successful result with metrics.
      # @param data [Object] Result data payload
      # @param metrics [ExecutionMetrics] Performance metrics
      # @return [ExecutionResult]
      def self.success_with_metrics(data, metrics)
        new(success: true, data: data, metrics: metrics)
      end

      # Create an error result.
      # @param message [String] Error message
      # @return [ExecutionResult]
      def self.error(message)
        new(
          success: false,
          data:    nil,
          errors:  { "message" => message }
        )
      end

      # Create an error result with details.
      # @param message [String] Error message
      # @param details [Object] Additional error details
      # @return [ExecutionResult]
      def self.error_with_details(message, details)
        new(
          success: false,
          data:    nil,
          errors:  { "message" => message, "details" => details }
        )
      end

      # Attach log entries to the result.
      # @param logs [Array<String>] Log lines
      # @return [self]
      def with_logs(logs)
        @logs = logs
        self
      end

      # Attach metrics to the result.
      # @param metrics [ExecutionMetrics] Performance metrics
      # @return [self]
      def with_metrics(metrics)
        @metrics = metrics
        self
      end

      # Attach context variables to the result.
      # @param vars [Hash] Context variables
      # @return [self]
      def with_vars(vars)
        @vars = vars
        self
      end

      # Build an ExecutionResult from a Hash (JSON-parsed).
      # @param hash [Hash] the parsed JSON hash
      # @return [ExecutionResult]
      def self.from_hash(hash)
        return error("unknown error") if hash.nil?

        new(
          success: hash["success"] || false,
          data:    hash["data"],
          errors:  hash["errors"],
          logs:    hash["logs"],
          metrics: hash["metrics"] ? ExecutionMetrics.from_hash(hash["metrics"]) : nil,
          vars: hash["vars"]
        )
      end

      # Serialize to a Hash suitable for JSON output.
      # Omits nil optional fields to keep the payload compact.
      # @return [Hash]
      def to_hash
        h = {
          "success" => @success,
          "data"    => @data
        }
        h["errors"]  = @errors  unless @errors.nil?
        h["logs"]    = @logs    unless @logs.nil?
        h["metrics"] = @metrics.to_hash unless @metrics.nil?
        h["vars"] = @vars unless @vars.nil?
        h
      end
    end
  end
end
