# frozen_string_literal: true

module Blok
  module Types
    # HealthStatus represents the health status of the blok runtime.
    class HealthStatus
      attr_accessor :status, :version, :nodes_loaded

      # @param status [String] Health status ("healthy" or "unhealthy")
      # @param version [String] Runtime version
      # @param nodes_loaded [Array<String>] Names of registered nodes
      def initialize(status: "healthy", version: "1.0.0", nodes_loaded: [])
        @status       = status
        @version      = version
        @nodes_loaded = nodes_loaded
      end

      # Build a HealthStatus from a Hash (JSON-parsed).
      # @param hash [Hash] the parsed JSON hash
      # @return [HealthStatus]
      def self.from_hash(hash)
        return new if hash.nil?

        new(
          status:       hash["status"] || "healthy",
          version:      hash["version"] || "1.0.0",
          nodes_loaded: hash["nodes_loaded"] || []
        )
      end

      # Serialize to a Hash suitable for JSON output.
      # @return [Hash]
      def to_hash
        {
          "status"       => @status,
          "version"      => @version,
          "nodes_loaded" => @nodes_loaded
        }
      end
    end
  end
end
