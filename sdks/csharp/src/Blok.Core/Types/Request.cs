using System.Text.Json;
using System.Text.Json.Serialization;

namespace Blok.Core.Types;

/// <summary>
/// Request represents the incoming HTTP request data.
/// </summary>
public class Request
{
    [JsonPropertyName("body")]
    public JsonElement Body { get; set; } = default;

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

    /// <summary>
    /// Deserialize the body to a typed value.
    /// </summary>
    public T? BodyAs<T>()
    {
        if (Body.ValueKind == JsonValueKind.Undefined)
            return default;

        return JsonSerializer.Deserialize<T>(Body.GetRawText());
    }

    /// <summary>
    /// Get a string field from the body by key.
    /// </summary>
    public string? BodyString(string key)
    {
        if (Body.ValueKind == JsonValueKind.Object && Body.TryGetProperty(key, out var prop))
        {
            return prop.ValueKind == JsonValueKind.String ? prop.GetString() : prop.GetRawText();
        }
        return null;
    }
}
