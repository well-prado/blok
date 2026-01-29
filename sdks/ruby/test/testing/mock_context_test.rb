# frozen_string_literal: true

require_relative "../test_helper"

class MockContextTest < Minitest::Test
  def test_default_values
    ctx = Nanoservice::Testing::MockContext.new.build

    assert_equal "test-execution-id", ctx.id
    assert_equal "test-workflow", ctx.workflow_name
    assert_equal "/workflows/test", ctx.workflow_path
    assert_equal "POST", ctx.request.method
    assert_equal "/test", ctx.request.url
    assert_equal({}, ctx.vars)
    assert_equal({}, ctx.env)
  end

  def test_with_id
    ctx = Nanoservice::Testing::MockContext.new
      .with_id("custom-id")
      .build

    assert_equal "custom-id", ctx.id
  end

  def test_with_workflow
    ctx = Nanoservice::Testing::MockContext.new
      .with_workflow("my-workflow", "/wf/my-workflow")
      .build

    assert_equal "my-workflow", ctx.workflow_name
    assert_equal "/wf/my-workflow", ctx.workflow_path
  end

  def test_with_workflow_default_path
    ctx = Nanoservice::Testing::MockContext.new
      .with_workflow("auth")
      .build

    assert_equal "auth", ctx.workflow_name
    assert_equal "/workflows/auth", ctx.workflow_path
  end

  def test_with_body
    ctx = Nanoservice::Testing::MockContext.new
      .with_body({ "name" => "John", "age" => 30 })
      .build

    assert_equal "John", ctx.request.body["name"]
    assert_equal 30, ctx.request.body["age"]
  end

  def test_with_headers
    ctx = Nanoservice::Testing::MockContext.new
      .with_headers({ "Authorization" => "Bearer token" })
      .build

    assert_equal "Bearer token", ctx.request.headers["Authorization"]
  end

  def test_with_method
    ctx = Nanoservice::Testing::MockContext.new
      .with_method("GET")
      .build

    assert_equal "GET", ctx.request.method
  end

  def test_with_var
    ctx = Nanoservice::Testing::MockContext.new
      .with_var("key1", "value1")
      .with_var("key2", 42)
      .build

    assert_equal "value1", ctx.vars["key1"]
    assert_equal 42, ctx.vars["key2"]
  end

  def test_with_env
    ctx = Nanoservice::Testing::MockContext.new
      .with_env("API_KEY", "secret123")
      .with_env("DEBUG", "true")
      .build

    assert_equal "secret123", ctx.env["API_KEY"]
    assert_equal "true", ctx.env["DEBUG"]
  end

  def test_fluent_chaining
    ctx = Nanoservice::Testing::MockContext.new
      .with_id("chain-test")
      .with_workflow("wf")
      .with_body({ "x" => 1 })
      .with_headers({ "H" => "V" })
      .with_var("a", "b")
      .with_env("E", "F")
      .build

    assert_equal "chain-test", ctx.id
    assert_equal "wf", ctx.workflow_name
    assert_equal 1, ctx.request.body["x"]
    assert_equal "V", ctx.request.headers["H"]
    assert_equal "b", ctx.vars["a"]
    assert_equal "F", ctx.env["E"]
  end

  def test_context_set_and_get_var
    ctx = Nanoservice::Testing::MockContext.new.build

    ctx.set_var("greeting", "Hello!")
    assert_equal "Hello!", ctx.get_var("greeting")
    assert_equal "Hello!", ctx.get_var_str("greeting")
    assert_nil ctx.get_var("missing")
    assert_nil ctx.get_var_str("missing")
  end

  def test_context_get_var_str_non_string
    ctx = Nanoservice::Testing::MockContext.new
      .with_var("count", 42)
      .build

    assert_equal 42, ctx.get_var("count")
    assert_nil ctx.get_var_str("count")
  end

  def test_context_to_hash_roundtrip
    ctx = Nanoservice::Testing::MockContext.new
      .with_id("roundtrip")
      .with_body({ "key" => "val" })
      .with_var("v", "1")
      .build

    hash     = ctx.to_hash
    restored = Nanoservice::Types::Context.from_hash(hash)

    assert_equal "roundtrip", restored.id
    assert_equal "val", restored.request.body["key"]
    assert_equal "1", restored.vars["v"]
  end

  def test_request_body_str
    ctx = Nanoservice::Testing::MockContext.new
      .with_body({ "name" => "Alice", "count" => 5 })
      .build

    assert_equal "Alice", ctx.request.body_str("name")
    assert_nil ctx.request.body_str("count")  # Not a string
    assert_nil ctx.request.body_str("missing")
  end
end
