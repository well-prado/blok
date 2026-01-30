using System.Text.Json;
using Blok.Core.Errors;
using Blok.Core.Node;

namespace Blok.Core.Nodes;

/// <summary>
/// TransformDataNode transforms JSON data based on field mappings.
///
/// Config:
///   - mappings (object): Map of target field name to source field path (dot-notation)
///   - include_only (array, optional): Only include these fields
///   - exclude (array, optional): Exclude these fields
///   - defaults (object, optional): Default values for missing fields
/// </summary>
public class TransformDataNode : INodeHandler
{
    public Task<JsonElement> ExecuteAsync(Types.Context ctx, Dictionary<string, JsonElement> config)
    {
        if (ctx.Request.Body.ValueKind != JsonValueKind.Object)
        {
            throw NodeException.Validation("request body must be a JSON object");
        }

        var result = new Dictionary<string, JsonElement>();

        // Apply field mappings if configured
        if (config.TryGetValue("mappings", out var mappingsProp) && mappingsProp.ValueKind == JsonValueKind.Object)
        {
            foreach (var mapping in mappingsProp.EnumerateObject())
            {
                var targetField = mapping.Name;
                if (mapping.Value.ValueKind == JsonValueKind.String)
                {
                    var sourcePath = mapping.Value.GetString()!;
                    var value = GetNestedValue(ctx.Request.Body, sourcePath);
                    if (value.HasValue)
                    {
                        result[targetField] = value.Value.Clone();
                    }
                }
            }
        }
        else
        {
            // No mappings - copy all fields
            foreach (var prop in ctx.Request.Body.EnumerateObject())
            {
                result[prop.Name] = prop.Value.Clone();
            }
        }

        // Apply include_only filter
        if (config.TryGetValue("include_only", out var includeOnlyProp) && includeOnlyProp.ValueKind == JsonValueKind.Array)
        {
            var allowed = new HashSet<string>();
            foreach (var item in includeOnlyProp.EnumerateArray())
            {
                if (item.ValueKind == JsonValueKind.String)
                {
                    allowed.Add(item.GetString()!);
                }
            }
            var keysToRemove = result.Keys.Where(k => !allowed.Contains(k)).ToList();
            foreach (var key in keysToRemove)
            {
                result.Remove(key);
            }
        }

        // Apply exclude filter
        if (config.TryGetValue("exclude", out var excludeProp) && excludeProp.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in excludeProp.EnumerateArray())
            {
                if (item.ValueKind == JsonValueKind.String)
                {
                    result.Remove(item.GetString()!);
                }
            }
        }

        // Apply defaults
        if (config.TryGetValue("defaults", out var defaultsProp) && defaultsProp.ValueKind == JsonValueKind.Object)
        {
            foreach (var def in defaultsProp.EnumerateObject())
            {
                if (!result.ContainsKey(def.Name))
                {
                    result[def.Name] = def.Value.Clone();
                }
            }
        }

        var outputJson = JsonSerializer.Serialize(result);
        var output = JsonDocument.Parse(outputJson).RootElement.Clone();

        ctx.SetVar("transformed_data", outputJson);

        return Task.FromResult(output);
    }

    private static JsonElement? GetNestedValue(JsonElement data, string path)
    {
        var current = data;
        foreach (var part in path.Split('.'))
        {
            if (current.ValueKind == JsonValueKind.Object && current.TryGetProperty(part, out var next))
            {
                current = next;
            }
            else
            {
                return null;
            }
        }
        return current;
    }
}
