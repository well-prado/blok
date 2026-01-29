# frozen_string_literal: true

module Nanoservice
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
          rescue Errors::NodeError
            # Let NodeErrors propagate so the registry can handle them
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
