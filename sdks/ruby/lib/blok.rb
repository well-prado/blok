# frozen_string_literal: true

require "json"

require_relative "blok/version"

# Types
require_relative "blok/types/context"
require_relative "blok/types/request"
require_relative "blok/types/response"
require_relative "blok/types/node_config"
require_relative "blok/types/execution_request"
require_relative "blok/types/execution_result"
require_relative "blok/types/execution_metrics"
require_relative "blok/types/health_status"

# Errors
require_relative "blok/errors/error_category"
require_relative "blok/errors/node_error"
require_relative "blok/errors/blok_error"
require_relative "blok/errors/build_context_snapshot"

# Logging
require_relative "blok/logging/log_level"
require_relative "blok/logging/log_entry"
require_relative "blok/logging/logger"

# Node
require_relative "blok/node/node_handler"
require_relative "blok/node/typed_node"
require_relative "blok/node/node_registry"
require_relative "blok/node/discovery"

# Middleware
require_relative "blok/middleware/middleware"
require_relative "blok/middleware/logging_middleware"
require_relative "blok/middleware/recovery_middleware"

# Validation
require_relative "blok/validation/schema_validator"

# Config
require_relative "blok/config/server_config"

# Server
require_relative "blok/server/runtime_app"

# Testing
require_relative "blok/testing/mock_context"
require_relative "blok/testing/test_runner"

module Blok
end
