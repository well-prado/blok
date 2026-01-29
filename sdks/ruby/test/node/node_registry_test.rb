# frozen_string_literal: true

require_relative "../test_helper"

# Simple test node that returns configured data.
class TestNode < Nanoservice::Node::NodeHandler
  def initialize(data = { "ok" => true })
    super()
    @data = data
  end

  def execute(_ctx, _config)
    @data
  end
end

# Node that raises an error.
class ErrorNode < Nanoservice::Node::NodeHandler
  def execute(_ctx, _config)
    raise Nanoservice::Errors::NodeError.validation("bad input")
  end
end

class NodeRegistryTest < Minitest::Test
  def setup
    @registry = Nanoservice::Node::NodeRegistry.new("1.0.0")
  end

  def test_register_and_get
    @registry.register("test", TestNode.new)

    assert_instance_of TestNode, @registry.get("test")
    assert_nil @registry.get("missing")
  end

  def test_node_names
    @registry.register("beta", TestNode.new)
    @registry.register("alpha", TestNode.new)

    names = @registry.node_names
    assert_equal %w[alpha beta], names
  end

  def test_execute_success
    @registry.register("test", TestNode.new({ "msg" => "hello" }))

    ctx     = Nanoservice::Testing::MockContext.new.build
    request = Nanoservice::Types::ExecutionRequest.new(
      node:    Nanoservice::Types::NodeConfig.new(name: "test"),
      context: ctx
    )
    result = @registry.execute(request)

    assert result.success
    assert_equal "hello", result.data["msg"]
    assert result.metrics
    assert result.metrics.duration_ms > 0
  end

  def test_execute_not_found
    ctx     = Nanoservice::Testing::MockContext.new.build
    request = Nanoservice::Types::ExecutionRequest.new(
      node:    Nanoservice::Types::NodeConfig.new(name: "missing"),
      context: ctx
    )
    result = @registry.execute(request)

    refute result.success
    assert_match(/not found/, result.errors["message"])
  end

  def test_execute_error_handling
    @registry.register("error", ErrorNode.new)

    ctx     = Nanoservice::Testing::MockContext.new.build
    request = Nanoservice::Types::ExecutionRequest.new(
      node:    Nanoservice::Types::NodeConfig.new(name: "error"),
      context: ctx
    )
    result = @registry.execute(request)

    refute result.success
    assert result.metrics
    assert result.metrics.duration_ms >= 0
  end

  def test_health
    @registry.register("a", TestNode.new)
    @registry.register("b", TestNode.new)

    health = @registry.health

    assert_equal "healthy", health.status
    assert_equal "1.0.0", health.version
    assert_equal 2, health.nodes_loaded.length
    assert_includes health.nodes_loaded, "a"
    assert_includes health.nodes_loaded, "b"
  end

  def test_middleware_applied
    log_entries = []
    middleware = Class.new(Nanoservice::Middleware::Middleware) do
      define_method(:initialize) do |entries|
        super()
        @entries = entries
      end

      define_method(:wrap) do |handler|
        entries = @entries
        ->(ctx, config) {
          entries << "before"
          result = handler.call(ctx, config)
          entries << "after"
          result
        }
      end
    end

    @registry.use(middleware.new(log_entries))
    @registry.register("test", TestNode.new)

    ctx     = Nanoservice::Testing::MockContext.new.build
    request = Nanoservice::Types::ExecutionRequest.new(
      node:    Nanoservice::Types::NodeConfig.new(name: "test"),
      context: ctx
    )
    result = @registry.execute(request)

    assert result.success
    assert_equal %w[before after], log_entries
  end
end
