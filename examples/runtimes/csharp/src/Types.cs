using System.Text.Json;
using System.Text.Json.Serialization;

namespace Blok.Runtime;

/// <summary>
/// Context represents the workflow execution context passed between nodes.
/// </summary>
public class Context
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = string.Empty;

    [JsonPropertyName("workflow_name")]
    public string WorkflowName { get; set; } = string.Empty;

    [JsonPropertyName("workflow_path")]
    public string WorkflowPath { get; set; } = string.Empty;

    [JsonPropertyName("request")]
    public Request Request { get; set; } = new();

    [JsonPropertyName("response")]
    public Response Response { get; set; } = new();

    [JsonPropertyName("vars")]
    public Dictionary<string, JsonElement> Vars { get; set; } = new();

    [JsonPropertyName("env")]
    public Dictionary<string, string> Env { get; set; } = new();
}

/// <summary>
/// Request represents the incoming HTTP request data.
/// </summary>
public class Request
{
    [JsonPropertyName("body")]
    public JsonElement Body { get; set; }

    [JsonPropertyName("headers")]
    public Dictionary<string, string> Headers { get; set; } = new();

    [JsonPropertyName("params")]
    public Dictionary<string, string> Params { get; set; } = new();

    [JsonPropertyName("query")]
    public Dictionary<string, string> Query { get; set; } = new();

    [JsonPropertyName("method")]
    public string Method { get; set; } = string.Empty;

    [JsonPropertyName("url")]
    public string Url { get; set; } = string.Empty;

    [JsonPropertyName("cookies")]
    public Dictionary<string, string> Cookies { get; set; } = new();

    [JsonPropertyName("baseUrl")]
    public string BaseUrl { get; set; } = string.Empty;
}

/// <summary>
/// Response represents the workflow response.
/// </summary>
public class Response
{
    [JsonPropertyName("data")]
    public JsonElement? Data { get; set; }

    [JsonPropertyName("contentType")]
    public string ContentType { get; set; } = string.Empty;

    [JsonPropertyName("success")]
    public bool Success { get; set; } = true;

    [JsonPropertyName("error")]
    public JsonElement? Error { get; set; }
}

/// <summary>
/// NodeConfig represents node-specific configuration from the runner.
/// </summary>
public class NodeConfig
{
    [JsonPropertyName("name")]
    public string Name { get; set; } = string.Empty;

    [JsonPropertyName("path")]
    public string Path { get; set; } = string.Empty;

    [JsonPropertyName("type")]
    public string NodeType { get; set; } = string.Empty;

    [JsonPropertyName("config")]
    public Dictionary<string, JsonElement> Config { get; set; } = new();
}

/// <summary>
/// ExecutionRequest is the request received from the Blok runner.
/// </summary>
public class ExecutionRequest
{
    [JsonPropertyName("node")]
    public NodeConfig Node { get; set; } = new();

    [JsonPropertyName("context")]
    public Context Context { get; set; } = new();
}

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
    public object? Errors { get; set; }

    [JsonPropertyName("logs")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<string>? Logs { get; set; }

    [JsonPropertyName("metrics")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public ExecutionMetrics? Metrics { get; set; }

    /// <summary>
    /// Creates a successful execution result.
    /// </summary>
    public static ExecutionResult Ok(object? data, ExecutionMetrics? metrics = null)
    {
        return new ExecutionResult
        {
            Success = true,
            Data = data,
            Errors = null,
            Metrics = metrics
        };
    }

    /// <summary>
    /// Creates a failed execution result with an error message.
    /// </summary>
    public static ExecutionResult Fail(string message, string? type = null)
    {
        var errors = new Dictionary<string, string> { ["message"] = message };

        if (type is not null)
        {
            errors["type"] = type;
        }

        return new ExecutionResult
        {
            Success = false,
            Data = null,
            Errors = errors
        };
    }
}

/// <summary>
/// ExecutionMetrics captures performance metrics for a node execution.
/// </summary>
public class ExecutionMetrics
{
    [JsonPropertyName("duration_ms")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public double? DurationMs { get; set; }

    [JsonPropertyName("cpu_ms")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public double? CpuMs { get; set; }

    [JsonPropertyName("memory_bytes")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public long? MemoryBytes { get; set; }
}

/// <summary>
/// HealthStatus represents the health status of the runtime.
/// </summary>
public class HealthStatus
{
    [JsonPropertyName("status")]
    public string Status { get; set; } = "healthy";

    [JsonPropertyName("version")]
    public string Version { get; set; } = string.Empty;

    [JsonPropertyName("nodes_loaded")]
    public List<string> NodesLoaded { get; set; } = new();
}
