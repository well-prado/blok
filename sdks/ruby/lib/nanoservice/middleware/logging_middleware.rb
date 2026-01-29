# frozen_string_literal: true

module Nanoservice
  module Middleware
    # LoggingMiddleware logs node execution with timing information.
    # It captures start/complete/failed events using the provided Logger.
    class LoggingMiddleware < Middleware
      # @param logger [Nanoservice::Logging::Logger] Logger instance
      def initialize(logger)
        super()
        @logger = logger
      end

      # Wrap the handler with logging behavior.
      # @param handler [#call] Inner handler callable
      # @return [#call] Wrapped callable with logging
      def wrap(handler)
        logger = @logger

        ->(ctx, config) {
          start_time = Process.clock_gettime(Process::CLOCK_MONOTONIC)
          logger.info("node execution started", fields: { "workflow" => ctx.workflow_name })

          begin
            result = handler.call(ctx, config)
            duration_ms = (Process.clock_gettime(Process::CLOCK_MONOTONIC) - start_time) * 1000.0
            logger.info("node execution completed", fields: {
              "workflow"    => ctx.workflow_name,
              "duration_ms" => duration_ms.round(2)
            })
            result
          rescue StandardError => e
            duration_ms = (Process.clock_gettime(Process::CLOCK_MONOTONIC) - start_time) * 1000.0
            logger.error("node execution failed", fields: {
              "workflow"    => ctx.workflow_name,
              "duration_ms" => duration_ms.round(2),
              "error"       => e.message
            })
            raise
          end
        }
      end
    end
  end
end
