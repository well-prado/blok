# frozen_string_literal: true

module Nanoservice
  module Types
    # NodeConfig represents node-specific configuration from the runner.
    class NodeConfig
      attr_accessor :name, :path, :node_type, :config

      # @param name [String] Node name (used for registry lookup)
      # @param path [String] Node path in the workflow
      # @param node_type [String] Type of the node
      # @param config [Hash] Key-value configuration for the node
      def initialize(name: "", path: "", node_type: "", config: {})
        @name      = name
        @path      = path
        @node_type = node_type
        @config    = config
      end

      # Build a NodeConfig from a Hash (JSON-parsed).
      # @param hash [Hash] the parsed JSON hash
      # @return [NodeConfig]
      def self.from_hash(hash)
        return new if hash.nil?

        new(
          name:      hash["name"] || "",
          path:      hash["path"] || "",
          node_type: hash["type"] || "",
          config:    hash["config"] || {}
        )
      end

      # Serialize to a Hash suitable for JSON output.
      # @return [Hash]
      def to_hash
        {
          "name"   => @name,
          "path"   => @path,
          "type"   => @node_type,
          "config" => @config
        }
      end

      # Get a string config value with a default.
      # @param key [String] Config key
      # @param default [String] Default value
      # @return [String]
      def config_str(key, default = "")
        val = @config[key]
        val.is_a?(String) ? val : default
      end

      # Get an integer config value with a default.
      # @param key [String] Config key
      # @param default [Integer] Default value
      # @return [Integer]
      def config_int(key, default = 0)
        val = @config[key]
        val.is_a?(Integer) ? val : default
      end

      # Get a boolean config value with a default.
      # @param key [String] Config key
      # @param default [Boolean] Default value
      # @return [Boolean]
      def config_bool(key, default = false)
        val = @config[key]
        val == true || val == false ? val : default
      end
    end
  end
end
