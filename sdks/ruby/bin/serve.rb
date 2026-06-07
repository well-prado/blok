#!/usr/bin/env ruby
# frozen_string_literal: true

# Entry point for the Blok Ruby runtime.
#
# Boots the configured server(s) based on +BLOK_TRANSPORT+:
#   - "http" (default): Sinatra HTTP server only.
#   - "grpc": gRPC server only on +GRPC_PORT+.
#   - "both": HTTP in foreground + gRPC in a background thread (dual-listen).
#
# Usage:
#   ruby bin/serve.rb
#
# Environment:
#   PORT           HTTP port (default: 9006)
#   GRPC_PORT      gRPC port (default: 10006)
#   BLOK_TRANSPORT "http" | "grpc" | "both" (default: "http")
#   HOST           Bind address (default: 0.0.0.0)
#   LOG_LEVEL      DEBUG | INFO | WARN | ERROR (default: INFO)

$LOAD_PATH.unshift File.expand_path("../lib", __dir__)

require "blok"
require_relative "../examples/hello_world_node"
require_relative "../examples/api_call_node"
require_relative "../examples/transform_data_node"
require_relative "../examples/chain_test_node"
require_relative "../examples/blok_error_demo_node"
require_relative "../examples/typed_greet_node"

config = Blok::Config::ServerConfig.from_env

registry = Blok::Node::NodeRegistry.new(config.version)
registry.register("hello-world", HelloWorldNode.new)
registry.register("api-call", ApiCallNode.new)
registry.register("transform-data", TransformDataNode.new)
registry.register("chain-test", ChainTestNode.new)
registry.register("blok-error-demo", BlokErrorDemoNode.new)
registry.register("typed-greet", TypedGreetNode.new)

logger = Blok::Logging::Logger.new(config.log_level)
registry.use(Blok::Middleware::RecoveryMiddleware.new)
registry.use(Blok::Middleware::LoggingMiddleware.new(logger))

warn "Blok Ruby SDK starting (transport=#{config.transport}, http_port=#{config.port}, " \
     "grpc_port=#{config.grpc_port}, #{registry.node_names.length} nodes)"

# Lazy-load the gRPC server only when we actually need it. This keeps the
# HTTP-only path free of grpc dependency load time.
def start_grpc(registry, config, blocking:)
  require_relative "../lib/blok/server/grpc_server"
  Blok::Server::GrpcServer.new(
    registry,
    port: config.grpc_port,
    host: config.host,
    sdk_version: config.version
  ).tap { |s| s.start(blocking: blocking) }
end

def start_http(registry, config)
  Blok::Server::RuntimeApp.registry = registry
  # Sinatra/Puma: bind on host:port and run in the foreground.
  require "rackup"
  app = Rack::Builder.new { run Blok::Server::RuntimeApp }.to_app
  Rackup::Server.start(
    app: app,
    server: "puma",
    Host: config.host,
    Port: config.port,
    quiet: false
  )
end

case config.transport
when Blok::Config::ServerConfig::Transport::HTTP
  start_http(registry, config)
when Blok::Config::ServerConfig::Transport::GRPC
  grpc_server = start_grpc(registry, config, blocking: false)
  # Hand the stop signal off the trap context to the main thread.
  # `GrpcServer#stop` calls `RpcServer#stop` which acquires a Mutex,
  # and `Mutex#synchronize` raises `ThreadError: can't be called from
  # trap context` under Ruby 3.x. `Queue#<<` is signal-safe in MRI.
  stop_queue = Queue.new
  trap("INT")  { stop_queue << "INT" }
  trap("TERM") { stop_queue << "TERM" }
  stop_queue.pop
  grpc_server.stop
  exit 0
when Blok::Config::ServerConfig::Transport::BOTH
  grpc_server = start_grpc(registry, config, blocking: false)
  at_exit { grpc_server.stop }
  start_http(registry, config)
else
  warn "Unknown transport: #{config.transport}"
  exit 1
end
