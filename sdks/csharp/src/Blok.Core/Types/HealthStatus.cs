using System.Text.Json.Serialization;

namespace Blok.Core.Types;

/// <summary>
/// HealthStatus represents the health status of the runtime.
/// </summary>
public class HealthStatus
{
    [JsonPropertyName("status")]
    public string Status { get; set; } = "healthy";

    [JsonPropertyName("version")]
    public string Version { get; set; } = "1.0.0";

    [JsonPropertyName("nodes_loaded")]
    public List<string> NodesLoaded { get; set; } = new();
}
