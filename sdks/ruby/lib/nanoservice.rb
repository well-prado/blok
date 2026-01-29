# frozen_string_literal: true

require "json"

require_relative "nanoservice/version"

# Types
require_relative "nanoservice/types/context"
require_relative "nanoservice/types/request"
require_relative "nanoservice/types/response"
require_relative "nanoservice/types/node_config"
require_relative "nanoservice/types/execution_request"
require_relative "nanoservice/types/execution_result"
require_relative "nanoservice/types/execution_metrics"
require_relative "nanoservice/types/health_status"

# Errors
require_relative "nanoservice/errors/error_category"
require_relative "nanoservice/errors/node_error"

# Logging
require_relative "nanoservice/logging/log_level"
require_relative "nanoservice/logging/log_entry"
require_relative "nanoservice/logging/logger"

# Node
require_relative "nanoservice/node/node_handler"
require_relative "nanoservice/node/node_registry"

# Middleware
require_relative "nanoservice/middleware/middleware"
require_relative "nanoservice/middleware/logging_middleware"
require_relative "nanoservice/middleware/recovery_middleware"

# Validation
require_relative "nanoservice/validation/schema_validator"

# Config
require_relative "nanoservice/config/server_config"

# Server
require_relative "nanoservice/server/runtime_app"

# Testing
require_relative "nanoservice/testing/mock_context"
require_relative "nanoservice/testing/test_runner"

module Nanoservice
end
