using System.Text.Json;
using Blok.Core.Node;
using Blok.Core.Types;

namespace Blok.Core.Nodes;

/// <summary>
/// ChainTestNode is used in cross-runtime integration tests.
/// It reads a chain array from the request body, appends its own entry,
/// and returns the updated chain — proving data flows between languages.
/// </summary>
public class ChainTestNode : INodeHandler
{
    public async Task<JsonElement> ExecuteAsync(Context ctx, Dictionary<string, JsonElement> config)
    {
        await Task.CompletedTask;

        // Read existing chain — gRPC inputs first (carried on
        // `node.config`), HTTP body fallback (legacy wire shape where
        // the runner mapped resolvedInputs → request.body). Dual-read
        // keeps the cross-runtime-chain demo working over both
        // transports during the §11 deprecation window.
        var chain = new List<object>();
        JsonElement chainSrc = default;
        if (config.TryGetValue("chain", out var configChain) && configChain.ValueKind == JsonValueKind.Array)
        {
            chainSrc = configChain;
        }
        else if (ctx.Request?.Body.ValueKind == JsonValueKind.Object &&
                 ctx.Request.Body.TryGetProperty("chain", out var bodyChain) &&
                 bodyChain.ValueKind == JsonValueKind.Array)
        {
            chainSrc = bodyChain;
        }
        if (chainSrc.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in chainSrc.EnumerateArray())
            {
                chain.Add(item);
            }
        }

        // Read origin — same dual-read.
        var origin = "unknown";
        if (config.TryGetValue("origin", out var configOrigin) &&
            configOrigin.ValueKind == JsonValueKind.String &&
            !string.IsNullOrEmpty(configOrigin.GetString()))
        {
            origin = configOrigin.GetString() ?? "unknown";
        }
        else if (ctx.Request?.Body.ValueKind == JsonValueKind.Object &&
                 ctx.Request.Body.TryGetProperty("origin", out var originProp) &&
                 originProp.ValueKind == JsonValueKind.String)
        {
            origin = originProp.GetString() ?? "unknown";
        }

        // Append this language's entry
        var entry = new
        {
            language = "csharp",
            order = chain.Count + 1,
            timestamp = DateTime.UtcNow.ToString("o")
        };
        chain.Add(entry);

        // Store in context vars
        ctx.Vars["chain"] = JsonSerializer.SerializeToElement(chain);

        // Return updated chain
        var result = new
        {
            chain,
            origin
        };

        return JsonSerializer.SerializeToElement(result);
    }
}
