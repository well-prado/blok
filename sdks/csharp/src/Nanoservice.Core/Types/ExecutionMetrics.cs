using System.Text.Json.Serialization;

namespace Nanoservice.Core.Types;

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
