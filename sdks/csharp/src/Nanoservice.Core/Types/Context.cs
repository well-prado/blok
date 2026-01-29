using System.Text.Json;
using System.Text.Json.Serialization;

namespace Nanoservice.Core.Types;

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
    public Dictionary<string, object?> Vars { get; set; } = new();

    [JsonPropertyName("env")]
    public Dictionary<string, string> Env { get; set; } = new();

    /// <summary>
    /// Store a variable in context for downstream nodes.
    /// </summary>
    public void SetVar(string key, object? value)
    {
        Vars[key] = value;
    }

    /// <summary>
    /// Retrieve a variable from context.
    /// </summary>
    public object? GetVar(string key)
    {
        return Vars.TryGetValue(key, out var value) ? value : null;
    }

    /// <summary>
    /// Retrieve a variable from context as a string.
    /// </summary>
    public string? GetVarString(string key)
    {
        var value = GetVar(key);
        return value?.ToString();
    }
}
