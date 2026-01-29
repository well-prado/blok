using System.Text.Json;
using Nanoservice.Core.Node;

namespace Nanoservice.Core.Nodes;

/// <summary>
/// HelloWorldNode greets the user with a configurable prefix.
/// </summary>
public class HelloWorldNode : INodeHandler
{
    public Task<JsonElement> ExecuteAsync(Types.Context ctx, Dictionary<string, JsonElement> config)
    {
        // Get name from body, default to "World"
        var name = "World";
        if (ctx.Request.Body.ValueKind == JsonValueKind.Object &&
            ctx.Request.Body.TryGetProperty("name", out var nameProp) &&
            nameProp.ValueKind == JsonValueKind.String)
        {
            name = nameProp.GetString() ?? "World";
        }

        // Get prefix from config, default to "Hello"
        var prefix = "Hello";
        if (config.TryGetValue("prefix", out var prefixProp) &&
            prefixProp.ValueKind == JsonValueKind.String)
        {
            prefix = prefixProp.GetString() ?? "Hello";
        }

        var message = $"{prefix}, {name}!";

        // Store greeting in context vars
        ctx.SetVar("greeting", message);

        var result = JsonSerializer.Serialize(new
        {
            message,
            timestamp = DateTime.UtcNow.ToString("O"),
            language = "csharp"
        });

        var element = JsonDocument.Parse(result).RootElement.Clone();
        return Task.FromResult(element);
    }
}
