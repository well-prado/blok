# frozen_string_literal: true

module Blok
  module Types
    # Response represents the workflow response accumulated through node execution.
    class Response
      attr_accessor :data, :content_type, :success, :error

      # @param data [Object] Response data
      # @param content_type [String] Content type of the response
      # @param success [Boolean] Whether the response is successful
      # @param error [Object, nil] Error information
      def initialize(data: nil, content_type: "", success: false, error: nil)
        @data         = data
        @content_type = content_type
        @success      = success
        @error        = error
      end

      # Build a Response from a Hash (JSON-parsed).
      # @param hash [Hash] the parsed JSON hash
      # @return [Response]
      def self.from_hash(hash)
        return new if hash.nil?

        new(
          data:         hash["data"],
          content_type: hash["contentType"] || "",
          success:      hash["success"] || false,
          error:        hash["error"]
        )
      end

      # Serialize to a Hash suitable for JSON output.
      # @return [Hash]
      def to_hash
        {
          "data"        => @data,
          "contentType" => @content_type,
          "success"     => @success,
          "error"       => @error
        }
      end
    end
  end
end
