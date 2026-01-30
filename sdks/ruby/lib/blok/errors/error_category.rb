# frozen_string_literal: true

module Blok
  module Errors
    # ErrorCategory classifies the type of error that occurred during node execution.
    module ErrorCategory
      VALIDATION    = "VALIDATION"
      EXECUTION     = "EXECUTION"
      CONFIGURATION = "CONFIGURATION"
      NETWORK       = "NETWORK"
      NOT_FOUND     = "NOT_FOUND"

      ALL = [VALIDATION, EXECUTION, CONFIGURATION, NETWORK, NOT_FOUND].freeze
    end
  end
end
