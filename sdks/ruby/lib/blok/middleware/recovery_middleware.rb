# frozen_string_literal: true

module Blok
  module Middleware
    # RecoveryMiddleware rescues unhandled exceptions and converts them
    # into structured error results, preventing the runtime from crashing.
    class RecoveryMiddleware < Middleware
      # Wrap the handler with exception recovery.
      # @param handler [#call] Inner handler callable
      # @return [#call] Wrapped callable with recovery
      def wrap(handler)
        ->(ctx, config) {
          begin
            handler.call(ctx, config)
          rescue Errors::BlokError
            # Master plan §17 BlokError passes through verbatim — the
            # registry catches it directly and stashes the typed instance
            # on `ExecutionResult.errors` for the gRPC servicer.
            raise
          rescue Errors::NodeError
            # Legacy structured exceptions pass through as-is too.
            raise
          rescue StandardError => e
            # Convert unexpected errors into a structured error response
            raise Errors::NodeError.execution("unexpected error: #{e.message}")
          end
        }
      end
    end
  end
end
