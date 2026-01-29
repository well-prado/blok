# frozen_string_literal: true

require_relative "../test_helper"

class ExecutionResultTest < Minitest::Test
  def test_success_factory
    result = Nanoservice::Types::ExecutionResult.success({ "msg" => "hello" })

    assert result.success
    assert_equal({ "msg" => "hello" }, result.data)
    assert_nil result.errors
    assert_nil result.logs
    assert_nil result.metrics
  end

  def test_success_with_metrics_factory
    metrics = Nanoservice::Types::ExecutionMetrics.new(duration_ms: 12.5)
    result  = Nanoservice::Types::ExecutionResult.success_with_metrics({ "ok" => true }, metrics)

    assert result.success
    assert_equal({ "ok" => true }, result.data)
    assert_equal 12.5, result.metrics.duration_ms
  end

  def test_error_factory
    result = Nanoservice::Types::ExecutionResult.error("something broke")

    refute result.success
    assert_nil result.data
    assert_equal "something broke", result.errors["message"]
  end

  def test_error_with_details_factory
    result = Nanoservice::Types::ExecutionResult.error_with_details(
      "validation failed",
      { "field" => "name" }
    )

    refute result.success
    assert_equal "validation failed", result.errors["message"]
    assert_equal({ "field" => "name" }, result.errors["details"])
  end

  def test_with_logs
    result = Nanoservice::Types::ExecutionResult.success({ "x" => 1 })
    result.with_logs(["line1", "line2"])

    assert_equal ["line1", "line2"], result.logs
  end

  def test_with_metrics
    result  = Nanoservice::Types::ExecutionResult.success({})
    metrics = Nanoservice::Types::ExecutionMetrics.new(duration_ms: 5.0, cpu_ms: 3.0)
    result.with_metrics(metrics)

    assert_equal 5.0, result.metrics.duration_ms
    assert_equal 3.0, result.metrics.cpu_ms
  end

  def test_to_hash_success
    result = Nanoservice::Types::ExecutionResult.success({ "key" => "val" })
    hash   = result.to_hash

    assert_equal true, hash["success"]
    assert_equal({ "key" => "val" }, hash["data"])
    refute hash.key?("errors")
    refute hash.key?("logs")
    refute hash.key?("metrics")
  end

  def test_to_hash_with_all_fields
    metrics = Nanoservice::Types::ExecutionMetrics.new(duration_ms: 10.0)
    result  = Nanoservice::Types::ExecutionResult.success({ "a" => 1 })
    result.with_logs(["log1"])
    result.with_metrics(metrics)

    hash = result.to_hash

    assert_equal true, hash["success"]
    assert_equal ["log1"], hash["logs"]
    assert_equal({ "duration_ms" => 10.0 }, hash["metrics"])
  end

  def test_to_hash_error
    result = Nanoservice::Types::ExecutionResult.error("fail")
    hash   = result.to_hash

    assert_equal false, hash["success"]
    assert_nil hash["data"]
    assert_equal "fail", hash["errors"]["message"]
  end

  def test_from_hash_roundtrip
    original = Nanoservice::Types::ExecutionResult.success_with_metrics(
      { "msg" => "hi" },
      Nanoservice::Types::ExecutionMetrics.new(duration_ms: 7.5)
    )
    original.with_logs(["entry"])

    json     = JSON.generate(original.to_hash)
    restored = Nanoservice::Types::ExecutionResult.from_hash(JSON.parse(json))

    assert restored.success
    assert_equal "hi", restored.data["msg"]
    assert_equal 7.5, restored.metrics.duration_ms
  end

  def test_metrics_to_hash_omits_nil
    metrics = Nanoservice::Types::ExecutionMetrics.new(duration_ms: 5.0)
    hash    = metrics.to_hash

    assert_equal({ "duration_ms" => 5.0 }, hash)
    refute hash.key?("cpu_ms")
    refute hash.key?("memory_bytes")
  end

  def test_metrics_to_hash_all_fields
    metrics = Nanoservice::Types::ExecutionMetrics.new(
      duration_ms: 10.0,
      cpu_ms: 8.0,
      memory_bytes: 1024
    )
    hash = metrics.to_hash

    assert_equal 10.0, hash["duration_ms"]
    assert_equal 8.0, hash["cpu_ms"]
    assert_equal 1024, hash["memory_bytes"]
  end
end
