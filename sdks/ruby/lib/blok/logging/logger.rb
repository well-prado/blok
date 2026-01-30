# frozen_string_literal: true

module Blok
  module Logging
    # Logger captures structured log entries during node execution.
    # Thread-safe via Mutex. Entries can be retrieved for inclusion
    # in ExecutionResult.logs.
    class Logger
      # @param min_level [Symbol] Minimum log level to capture (default: :info)
      def initialize(min_level = LogLevel::INFO)
        @min_level = min_level
        @entries   = []
        @mutex     = Mutex.new
      end

      # Log a debug message.
      # @param message [String] Log message
      # @param fields [Hash, nil] Optional structured fields
      def debug(message, fields: nil)
        log(LogLevel::DEBUG, message, fields)
      end

      # Log an info message.
      # @param message [String] Log message
      # @param fields [Hash, nil] Optional structured fields
      def info(message, fields: nil)
        log(LogLevel::INFO, message, fields)
      end

      # Log a warning message.
      # @param message [String] Log message
      # @param fields [Hash, nil] Optional structured fields
      def warn(message, fields: nil)
        log(LogLevel::WARN, message, fields)
      end

      # Log an error message.
      # @param message [String] Log message
      # @param fields [Hash, nil] Optional structured fields
      def error(message, fields: nil)
        log(LogLevel::ERROR, message, fields)
      end

      # Return all captured log entries.
      # @return [Array<LogEntry>]
      def entries
        @mutex.synchronize { @entries.dup }
      end

      # Return log entries as formatted strings for ExecutionResult.logs.
      # @return [Array<String>]
      def lines
        @mutex.synchronize { @entries.map(&:to_s) }
      end

      # Clear all captured entries.
      def clear
        @mutex.synchronize { @entries.clear }
      end

      private

      def log(level, message, fields)
        return if LogLevel.priority(level) < LogLevel.priority(@min_level)

        entry = LogEntry.new(level: level, message: message, fields: fields)
        @mutex.synchronize { @entries << entry }
      end
    end
  end
end
