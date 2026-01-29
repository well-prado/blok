# frozen_string_literal: true

module Nanoservice
  module Logging
    # LogLevel defines the severity levels for structured logging.
    # Levels are ordered: debug < info < warn < error.
    module LogLevel
      DEBUG = :debug
      INFO  = :info
      WARN  = :warn
      ERROR = :error

      ALL = [DEBUG, INFO, WARN, ERROR].freeze

      PRIORITY = {
        debug: 0,
        info:  1,
        warn:  2,
        error: 3
      }.freeze

      # Return the integer priority for a given level symbol.
      # @param level [Symbol] Log level
      # @return [Integer]
      def self.priority(level)
        PRIORITY.fetch(level, 1)
      end

      # Return the uppercase string label for a given level symbol.
      # @param level [Symbol] Log level
      # @return [String]
      def self.label(level)
        level.to_s.upcase
      end

      # Parse a string into a log level symbol.
      # @param str [String] Level string (e.g. "DEBUG", "info")
      # @return [Symbol]
      def self.parse(str)
        case str.to_s.downcase
        when "debug" then DEBUG
        when "warn"  then WARN
        when "error" then ERROR
        else INFO
        end
      end
    end
  end
end
