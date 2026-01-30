# frozen_string_literal: true

module Blok
  module Middleware
    # Middleware is the base class for execution pipeline middleware.
    # Each middleware wraps a callable (lambda/proc) and returns
    # a new callable with additional behavior.
    #
    # Subclasses must implement +wrap+ which receives the inner handler
    # (a callable responding to +call(ctx, config)+) and returns a new
    # callable with the same signature.
    #
    # @example
    #   class MyMiddleware < Blok::Middleware::Middleware
    #     def wrap(handler)
    #       ->(ctx, config) {
    #         # pre-processing
    #         result = handler.call(ctx, config)
    #         # post-processing
    #         result
    #       }
    #     end
    #   end
    #
    class Middleware
      # Wrap the inner handler and return a new callable.
      #
      # @param handler [#call] A callable that accepts (ctx, config)
      # @return [#call] A wrapped callable
      # @raise [NotImplementedError] if not overridden
      def wrap(handler)
        raise NotImplementedError, "#{self.class}#wrap must be implemented"
      end
    end
  end
end
