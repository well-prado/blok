# frozen_string_literal: true

module Blok
  module Config
    # ServerConfig holds runtime server configuration, loadable from environment variables.
    class ServerConfig
      attr_accessor :port, :host, :version, :log_level, :enable_cors

      # @param port [Integer] HTTP port (default: 8080)
      # @param host [String] Bind host (default: "0.0.0.0")
      # @param version [String] Runtime version (default: Blok::VERSION)
      # @param log_level [Symbol] Minimum log level (default: :info)
      # @param enable_cors [Boolean] Enable CORS headers (default: false)
      def initialize(port: 8080, host: "0.0.0.0", version: nil,
                     log_level: Logging::LogLevel::INFO, enable_cors: false)
        @port        = port
        @host        = host
        @version     = version || Blok::VERSION
        @log_level   = log_level
        @enable_cors = enable_cors
      end

      # Load configuration from environment variables with sensible defaults.
      #
      # Environment variables:
      #   PORT        - HTTP port (default: 8080)
      #   HOST        - Bind host (default: "0.0.0.0")
      #   VERSION     - Runtime version (default: Blok::VERSION)
      #   LOG_LEVEL   - Minimum log level: DEBUG, INFO, WARN, ERROR (default: INFO)
      #   ENABLE_CORS - Enable CORS: "true" or "false" (default: false)
      #
      # @return [ServerConfig]
      def self.from_env
        new(
          port:        Integer(ENV.fetch("PORT", "8080")),
          host:        ENV.fetch("HOST", "0.0.0.0"),
          version:     ENV.fetch("VERSION", Blok::VERSION),
          log_level:   Logging::LogLevel.parse(ENV.fetch("LOG_LEVEL", "INFO")),
          enable_cors: ENV.fetch("ENABLE_CORS", "false") == "true"
        )
      end

      # Return the bind address as "host:port".
      # @return [String]
      def address
        "#{@host}:#{@port}"
      end
    end
  end
end
