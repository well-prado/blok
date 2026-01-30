using System.Text.Json.Serialization;

namespace Blok.Core.Types;

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
