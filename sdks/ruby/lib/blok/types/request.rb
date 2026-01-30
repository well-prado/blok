# frozen_string_literal: true

module Blok
  module Types
    # Request represents the incoming HTTP request data passed through the workflow context.
    class Request
      attr_accessor :body, :headers, :params, :query, :method, :url, :cookies, :base_url

      # @param body [Hash, nil] The request body
      # @param headers [Hash] HTTP headers
      # @param params [Hash] URL path parameters
      # @param query [Hash] URL query parameters
      # @param method [String] HTTP method
      # @param url [String] Request URL
      # @param cookies [Hash] Request cookies
      # @param base_url [String] Base URL of the request
      def initialize(body: {}, headers: {}, params: {}, query: {},
                     method: "", url: "", cookies: {}, base_url: "")
        @body     = body
        @headers  = headers
        @params   = params
        @query    = query
        @method   = method
        @url      = url
        @cookies  = cookies
        @base_url = base_url
      end

      # Build a Request from a Hash (JSON-parsed).
      # @param hash [Hash] the parsed JSON hash
      # @return [Request]
      def self.from_hash(hash)
        return new if hash.nil?

        new(
          body:     hash["body"] || {},
          headers:  hash["headers"] || {},
          params:   hash["params"] || {},
          query:    hash["query"] || {},
          method:   hash["method"] || "",
          url:      hash["url"] || "",
          cookies:  hash["cookies"] || {},
          base_url: hash["baseUrl"] || ""
        )
      end

      # Serialize to a Hash suitable for JSON output.
      # @return [Hash]
      def to_hash
        {
          "body"    => @body,
          "headers" => @headers,
          "params"  => @params,
          "query"   => @query,
          "method"  => @method,
          "url"     => @url,
          "cookies" => @cookies,
          "baseUrl" => @base_url
        }
      end

      # Get a string value from the body by key.
      # @param key [String] the body field key
      # @return [String, nil]
      def body_str(key)
        val = @body.is_a?(Hash) ? @body[key] : nil
        val.is_a?(String) ? val : nil
      end
    end
  end
end
