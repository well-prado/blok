using System.Text.Json;
using System.Text.Json.Serialization;

namespace Blok.Core.Types;

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
    public string Type { get; set; } = string.Empty;

    [JsonPropertyName("config")]
    public Dictionary<string, JsonElement> Config { get; set; } = new();

    /// <summary>
    /// Get a string config value with a default.
    /// </summary>
    public string GetConfigString(string key, string defaultValue = "")
    {
        if (Config.TryGetValue(key, out var element) && element.ValueKind == JsonValueKind.String)
        {
            return element.GetString() ?? defaultValue;
        }
        return defaultValue;
    }

    /// <summary>
    /// Get an integer config value with a default.
    /// </summary>
    public int GetConfigInt(string key, int defaultValue = 0)
    {
        if (Config.TryGetValue(key, out var element) && element.ValueKind == JsonValueKind.Number)
        {
            return element.TryGetInt32(out var result) ? result : defaultValue;
        }
        return defaultValue;
    }

    /// <summary>
    /// Get a boolean config value with a default.
    /// </summary>
    public bool GetConfigBool(string key, bool defaultValue = false)
    {
        if (Config.TryGetValue(key, out var element))
        {
            if (element.ValueKind == JsonValueKind.True) return true;
            if (element.ValueKind == JsonValueKind.False) return false;
        }
        return defaultValue;
    }
}
