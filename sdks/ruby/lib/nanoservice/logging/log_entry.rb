# frozen_string_literal: true

require "time"

module Nanoservice
  module Logging
    # LogEntry represents a single structured log entry captured during node execution.
    class LogEntry
      attr_reader :level, :message, :timestamp, :fields

      # @param level [Symbol] Log level (:debug, :info, :warn, :error)
      # @param message [String] Log message
      # @param timestamp [String] ISO 8601 timestamp
      # @param fields [Hash, nil] Optional structured fields
      def initialize(level:, message:, timestamp: nil, fields: nil)
        @level     = level
        @message   = message
        @timestamp = timestamp || Time.now.utc.iso8601
        @fields    = fields
      end

      # Format the log entry as a human-readable string.
      # @return [String]
      def to_s
        label = LogLevel.label(@level)
        if @fields
          "[#{label}] #{@timestamp} #{@message} #{JSON.generate(@fields)}"
        else
          "[#{label}] #{@timestamp} #{@message}"
        end
      end

      # Serialize to a Hash suitable for JSON output.
      # @return [Hash]
      def to_hash
        h = {
          "level"     => LogLevel.label(@level),
          "message"   => @message,
          "timestamp" => @timestamp
        }
        h["fields"] = @fields unless @fields.nil?
        h
      end
    end
  end
end
