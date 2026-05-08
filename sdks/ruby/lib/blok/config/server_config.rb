# frozen_string_literal: true

module Blok
  module Config
    # ServerConfig holds runtime server configuration, loadable from environment variables.
    class ServerConfig
      # Selects which transport(s) to start.
      module Transport
        HTTP = :http
        GRPC = :grpc
        BOTH = :both
      end

      attr_accessor :port, :host, :version, :grpc_port, :transport, :log_level, :enable_cors

      # @param port [Integer] HTTP port (default: 9006 — matches DEFAULT_PORTS.ruby)
      # @param host [String] Bind host (default: "0.0.0.0")
      # @param version [String] Runtime version (default: Blok::VERSION)
      # @param grpc_port [Integer] gRPC port (default: 10006 — matches DEFAULT_GRPC_PORTS.ruby = HTTP+1000)
      # @param transport [Symbol] One of :http | :grpc | :both (default: :http)
      # @param log_level [Symbol] Minimum log level (default: :info)
      # @param enable_cors [Boolean] Enable CORS headers (default: false)
      def initialize(port: 9006, host: "0.0.0.0", version: nil,
                     grpc_port: 10006, transport: Transport::HTTP,
                     log_level: Logging::LogLevel::INFO, enable_cors: false)
        @port        = port
        @host        = host
        @version     = version || Blok::VERSION
        @grpc_port   = grpc_port
        @transport   = transport
        @log_level   = log_level
        @enable_cors = enable_cors
      end

      # Load configuration from environment variables with sensible defaults.
      #
      # Environment variables:
      #   PORT           - HTTP port (default: 9006)
      #   HOST           - Bind host (default: "0.0.0.0")
      #   VERSION        - Runtime version (default: Blok::VERSION)
      #   GRPC_PORT      - gRPC port (default: 10006)
      #   BLOK_TRANSPORT - "http" | "grpc" | "both" (default: "http"; invalid -> "http")
      #   LOG_LEVEL      - Minimum log level: DEBUG, INFO, WARN, ERROR (default: INFO)
      #   ENABLE_CORS    - Enable CORS: "true" or "false" (default: false)
      #
      # @return [ServerConfig]
      def self.from_env
        new(
          port:        Integer(ENV.fetch("PORT", "9006")),
          host:        ENV.fetch("HOST", "0.0.0.0"),
          version:     ENV.fetch("VERSION", Blok::VERSION),
          grpc_port:   Integer(ENV.fetch("GRPC_PORT", "10006")),
          transport:   parse_transport(ENV.fetch("BLOK_TRANSPORT", "http")),
          log_level:   Logging::LogLevel.parse(ENV.fetch("LOG_LEVEL", "INFO")),
          enable_cors: ENV.fetch("ENABLE_CORS", "false") == "true"
        )
      end

      # Parse a transport string into a Transport symbol. Invalid values fall
      # back to {Transport::HTTP} so a typo never crashes the boot.
      def self.parse_transport(value)
        case value.to_s.downcase
        when "grpc" then Transport::GRPC
        when "both" then Transport::BOTH
        else Transport::HTTP
        end
      end

      # Return the bind address as "host:port".
      # @return [String]
      def address
        "#{@host}:#{@port}"
      end
    end
  end
end
