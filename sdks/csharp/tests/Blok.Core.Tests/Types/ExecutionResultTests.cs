using System.Text.Json;
using FluentAssertions;
using Blok.Core.Types;
using Xunit;

namespace Blok.Core.Tests.Types;

public class ExecutionResultTests
{
    [Fact]
    public void Ok_ShouldCreateSuccessResult()
    {
        var data = new { message = "hello" };
        var result = ExecutionResult.Ok(data);

        result.Success.Should().BeTrue();
        result.Data.Should().NotBeNull();
        result.Errors.Should().BeNull();
        result.Logs.Should().BeNull();
        result.Metrics.Should().BeNull();
    }

    [Fact]
    public void Fail_ShouldCreateErrorResult()
    {
        var result = ExecutionResult.Fail("something broke");

        result.Success.Should().BeFalse();
        result.Data.Should().BeNull();
        result.Errors.Should().NotBeNull();
    }

    [Fact]
    public void FailWithDetails_ShouldIncludeDetails()
    {
        var details = new { field = "name", reason = "required" };
        var result = ExecutionResult.FailWithDetails("validation failed", details);

        result.Success.Should().BeFalse();
        result.Errors.Should().NotBeNull();

        var json = JsonSerializer.Serialize(result.Errors);
        json.Should().Contain("validation failed");
        json.Should().Contain("name");
    }

    [Fact]
    public void WithLogs_ShouldAttachLogs()
    {
        var logs = new List<string> { "step 1", "step 2" };
        var result = ExecutionResult.Ok(new { done = true }).WithLogs(logs);

        result.Logs.Should().NotBeNull();
        result.Logs.Should().HaveCount(2);
        result.Logs![0].Should().Be("step 1");
    }

    [Fact]
    public void WithMetrics_ShouldAttachMetrics()
    {
        var metrics = new ExecutionMetrics
        {
            DurationMs = 12.5,
            MemoryBytes = 1024
        };
        var result = ExecutionResult.Ok(new { done = true }).WithMetrics(metrics);

        result.Metrics.Should().NotBeNull();
        result.Metrics!.DurationMs.Should().Be(12.5);
        result.Metrics.MemoryBytes.Should().Be(1024);
        result.Metrics.CpuMs.Should().BeNull();
    }

    [Fact]
    public void FluentChaining_ShouldWork()
    {
        var result = ExecutionResult.Ok(new { value = 42 })
            .WithLogs(new List<string> { "log1" })
            .WithMetrics(new ExecutionMetrics { DurationMs = 5.0 });

        result.Success.Should().BeTrue();
        result.Logs.Should().HaveCount(1);
        result.Metrics!.DurationMs.Should().Be(5.0);
    }

    [Fact]
    public void JsonSerialization_ShouldOmitNulls()
    {
        var result = ExecutionResult.Ok(new { msg = "hi" });
        var json = JsonSerializer.Serialize(result);

        json.Should().NotContain("logs");
        json.Should().NotContain("metrics");
        json.Should().NotContain("errors");
        json.Should().Contain("success");
        json.Should().Contain("data");
    }

    [Fact]
    public void JsonSerialization_ShouldIncludeMetricsWhenPresent()
    {
        var result = ExecutionResult.Ok(new { msg = "hi" })
            .WithMetrics(new ExecutionMetrics { DurationMs = 10.0 });

        var json = JsonSerializer.Serialize(result);
        json.Should().Contain("duration_ms");
        json.Should().NotContain("cpu_ms");
        json.Should().NotContain("memory_bytes");
    }
}
