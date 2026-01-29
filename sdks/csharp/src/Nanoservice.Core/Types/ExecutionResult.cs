using System.Text.Json;
using System.Text.Json.Serialization;

namespace Nanoservice.Core.Types;

/// <summary>
/// ExecutionResult is the response returned to the Blok runner.
/// </summary>
public class ExecutionResult
{
    [JsonPropertyName("success")]
    public bool Success { get; set; }

    [JsonPropertyName("data")]
    public object? Data { get; set; }

    [JsonPropertyName("errors")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public object? Errors { get; set; }

    [JsonPropertyName("logs")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<string>? Logs { get; set; }

    [JsonPropertyName("metrics")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public ExecutionMetrics? Metrics { get; set; }

    [JsonPropertyName("vars")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public Dictionary<string, object?>? Vars { get; set; }

    /// <summary>
    /// Create a successful result with the given data.
    /// </summary>
    public static ExecutionResult Ok(object? data)
    {
        return new ExecutionResult
        {
            Success = true,
            Data = data,
            Errors = null,
            Logs = null,
            Metrics = null
        };
    }

    /// <summary>
    /// Create an error result with a message.
    /// </summary>
    public static ExecutionResult Fail(string message)
    {
        return new ExecutionResult
        {
            Success = false,
            Data = null,
            Errors = new { message },
            Logs = null,
            Metrics = null
        };
    }

    /// <summary>
    /// Create an error result with a message and details.
    /// </summary>
    public static ExecutionResult FailWithDetails(string message, object? details)
    {
        return new ExecutionResult
        {
            Success = false,
            Data = null,
            Errors = new { message, details },
            Logs = null,
            Metrics = null
        };
    }

    /// <summary>
    /// Attach log entries to the result.
    /// </summary>
    public ExecutionResult WithLogs(List<string> logs)
    {
        Logs = logs;
        return this;
    }

    /// <summary>
    /// Attach metrics to the result.
    /// </summary>
    public ExecutionResult WithMetrics(ExecutionMetrics metrics)
    {
        Metrics = metrics;
        return this;
    }

    /// <summary>
    /// Attach context variables to the result.
    /// </summary>
    public ExecutionResult WithVars(Dictionary<string, object?> vars)
    {
        Vars = vars;
        return this;
    }
}
