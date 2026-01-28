using System.Text.Json;

namespace Blok.Runtime.Nodes;

/// <summary>
/// HelloWorldNode is an example Blok node implemented in C#.
/// It reads a name from the request body and a greeting prefix from the
/// node configuration, then returns a greeting message.
/// </summary>
public class HelloWorldNode : INodeHandler
{
    /// <inheritdoc />
    public Task<JsonElement> ExecuteAsync(Context ctx, Dictionary<string, JsonElement> config)
    {
        // Get name from request body or use default
        var name = "World";

        if (ctx.Request.Body.ValueKind == JsonValueKind.Object
            && ctx.Request.Body.TryGetProperty("name", out var nameElement)
            && nameElement.ValueKind == JsonValueKind.String)
        {
            name = nameElement.GetString() ?? "World";
        }

        // Get greeting prefix from config or use default
        var prefix = "Hello";

        if (config.TryGetValue("prefix", out var prefixElement)
            && prefixElement.ValueKind == JsonValueKind.String)
        {
            prefix = prefixElement.GetString() ?? "Hello";
        }

        var message = $"{prefix}, {name}!";
        var timestamp = DateTimeOffset.UtcNow;

        // Store in context vars for downstream nodes
        ctx.Vars["greeting"] = JsonSerializer.SerializeToElement(message);
        ctx.Vars["timestamp"] = JsonSerializer.SerializeToElement(timestamp.ToUnixTimeSeconds());

        // Build the response
        var response = new Dictionary<string, object>
        {
            ["message"] = message,
            ["timestamp"] = timestamp.ToString("o"),
            ["language"] = "C#"
        };

        var result = JsonSerializer.SerializeToElement(response);
        return Task.FromResult(result);
    }
}
