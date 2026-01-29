using System.Text.Json;

namespace Nanoservice.Core.Validation;

/// <summary>
/// SchemaValidator validates a JsonElement against a JSON Schema (Draft 7 subset).
/// Supports: type, required, properties, enum, minLength, maxLength, minimum, maximum.
/// </summary>
public class SchemaValidator
{
    /// <summary>
    /// Validate data against a JSON Schema. Returns a list of error messages.
    /// An empty list means validation passed.
    /// </summary>
    public List<string> Validate(JsonElement data, JsonElement schema)
    {
        var errors = new List<string>();
        ValidateValue(data, schema, "$", errors);
        return errors;
    }

    private void ValidateValue(JsonElement data, JsonElement schema, string path, List<string> errors)
    {
        if (schema.ValueKind != JsonValueKind.Object)
            return;

        // Type check
        if (schema.TryGetProperty("type", out var typeVal) && typeVal.ValueKind == JsonValueKind.String)
        {
            var expectedType = typeVal.GetString()!;
            if (!CheckType(data, expectedType))
            {
                errors.Add($"{path}: expected type \"{expectedType}\", got {TypeName(data)}");
                return;
            }
        }

        // Enum check
        if (schema.TryGetProperty("enum", out var enumVal) && enumVal.ValueKind == JsonValueKind.Array)
        {
            bool found = false;
            foreach (var item in enumVal.EnumerateArray())
            {
                if (JsonElementEquals(data, item))
                {
                    found = true;
                    break;
                }
            }
            if (!found)
            {
                errors.Add($"{path}: value not in allowed enum values");
            }
        }

        // Object: required fields
        if (data.ValueKind == JsonValueKind.Object &&
            schema.TryGetProperty("required", out var requiredVal) &&
            requiredVal.ValueKind == JsonValueKind.Array)
        {
            foreach (var field in requiredVal.EnumerateArray())
            {
                var fieldName = field.GetString();
                if (fieldName is not null && !data.TryGetProperty(fieldName, out _))
                {
                    errors.Add($"{path}: missing required field \"{fieldName}\"");
                }
            }
        }

        // Object: properties
        if (data.ValueKind == JsonValueKind.Object &&
            schema.TryGetProperty("properties", out var propertiesVal) &&
            propertiesVal.ValueKind == JsonValueKind.Object)
        {
            foreach (var prop in propertiesVal.EnumerateObject())
            {
                if (data.TryGetProperty(prop.Name, out var propData))
                {
                    var propPath = $"{path}.{prop.Name}";
                    ValidateValue(propData, prop.Value, propPath, errors);
                }
            }
        }

        // String constraints
        if (data.ValueKind == JsonValueKind.String)
        {
            var str = data.GetString() ?? string.Empty;

            if (schema.TryGetProperty("minLength", out var minLen) && minLen.TryGetInt32(out var min))
            {
                if (str.Length < min)
                {
                    errors.Add($"{path}: string length {str.Length} is less than minimum {min}");
                }
            }

            if (schema.TryGetProperty("maxLength", out var maxLen) && maxLen.TryGetInt32(out var max))
            {
                if (str.Length > max)
                {
                    errors.Add($"{path}: string length {str.Length} exceeds maximum {max}");
                }
            }
        }

        // Numeric constraints
        if (data.ValueKind == JsonValueKind.Number)
        {
            var num = data.GetDouble();

            if (schema.TryGetProperty("minimum", out var minVal) && minVal.ValueKind == JsonValueKind.Number)
            {
                var minimum = minVal.GetDouble();
                if (num < minimum)
                {
                    errors.Add($"{path}: value {num} is less than minimum {minimum}");
                }
            }

            if (schema.TryGetProperty("maximum", out var maxVal) && maxVal.ValueKind == JsonValueKind.Number)
            {
                var maximum = maxVal.GetDouble();
                if (num > maximum)
                {
                    errors.Add($"{path}: value {num} exceeds maximum {maximum}");
                }
            }
        }

        // Array items
        if (data.ValueKind == JsonValueKind.Array &&
            schema.TryGetProperty("items", out var itemsSchema))
        {
            int i = 0;
            foreach (var item in data.EnumerateArray())
            {
                var itemPath = $"{path}[{i}]";
                ValidateValue(item, itemsSchema, itemPath, errors);
                i++;
            }
        }
    }

    private static bool CheckType(JsonElement data, string expectedType)
    {
        return expectedType switch
        {
            "string" => data.ValueKind == JsonValueKind.String,
            "number" => data.ValueKind == JsonValueKind.Number,
            "integer" => data.ValueKind == JsonValueKind.Number && IsInteger(data),
            "boolean" => data.ValueKind == JsonValueKind.True || data.ValueKind == JsonValueKind.False,
            "object" => data.ValueKind == JsonValueKind.Object,
            "array" => data.ValueKind == JsonValueKind.Array,
            "null" => data.ValueKind == JsonValueKind.Null,
            _ => true
        };
    }

    private static bool IsInteger(JsonElement data)
    {
        if (data.TryGetInt64(out _)) return true;
        var d = data.GetDouble();
        return Math.Abs(d % 1) < double.Epsilon;
    }

    private static string TypeName(JsonElement data)
    {
        return data.ValueKind switch
        {
            JsonValueKind.String => "string",
            JsonValueKind.Number => "number",
            JsonValueKind.True => "boolean",
            JsonValueKind.False => "boolean",
            JsonValueKind.Object => "object",
            JsonValueKind.Array => "array",
            JsonValueKind.Null => "null",
            JsonValueKind.Undefined => "undefined",
            _ => "unknown"
        };
    }

    private static bool JsonElementEquals(JsonElement a, JsonElement b)
    {
        if (a.ValueKind != b.ValueKind) return false;

        return a.ValueKind switch
        {
            JsonValueKind.String => a.GetString() == b.GetString(),
            JsonValueKind.Number => a.GetDouble() == b.GetDouble(),
            JsonValueKind.True => true,
            JsonValueKind.False => true,
            JsonValueKind.Null => true,
            _ => a.GetRawText() == b.GetRawText()
        };
    }
}
