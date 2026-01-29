# frozen_string_literal: true

module Nanoservice
  module Types
    # ExecutionMetrics captures performance metrics for a node execution.
    class ExecutionMetrics
      attr_accessor :duration_ms, :cpu_ms, :memory_bytes

      # @param duration_ms [Float, nil] Wall-clock execution time in milliseconds
      # @param cpu_ms [Float, nil] CPU time in milliseconds
      # @param memory_bytes [Integer, nil] Peak memory usage in bytes
      def initialize(duration_ms: nil, cpu_ms: nil, memory_bytes: nil)
        @duration_ms  = duration_ms
        @cpu_ms       = cpu_ms
        @memory_bytes = memory_bytes
      end

      # Build an ExecutionMetrics from a Hash (JSON-parsed).
      # @param hash [Hash] the parsed JSON hash
      # @return [ExecutionMetrics]
      def self.from_hash(hash)
        return new if hash.nil?

        new(
          duration_ms:  hash["duration_ms"],
          cpu_ms:       hash["cpu_ms"],
          memory_bytes: hash["memory_bytes"]
        )
      end

      # Serialize to a Hash suitable for JSON output.
      # Omits nil values to keep the payload compact.
      # @return [Hash]
      def to_hash
        h = {}
        h["duration_ms"]  = @duration_ms  unless @duration_ms.nil?
        h["cpu_ms"]       = @cpu_ms       unless @cpu_ms.nil?
        h["memory_bytes"] = @memory_bytes unless @memory_bytes.nil?
        h
      end
    end
  end
end
