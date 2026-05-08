using System.Text.Json;

namespace Blok.Core.Errors;

/// <summary>
/// Bounded slice of inputs + recent vars for the
/// <c>BlokError.ContextSnapshot</c> field, per master plan §17.6.
///
/// <para>Default budget: 4 KB serialized + last-16 vars keys, with
/// progressive trimming when oversize. <c>inputs</c> is preserved as-is —
/// it's the most LLM-actionable context. Mirrors Python's
/// <c>build_context_snapshot</c>, Go's <c>BuildContextSnapshot</c>, Rust's
/// <c>build_context_snapshot</c>, and Java's <c>BuildContextSnapshot.of</c>.</para>
/// </summary>
public static class BuildContextSnapshot
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.Never,
    };

    /// <summary>Snapshot of <c>inputs</c> + last-16 vars keys, capped at 4 KB.</summary>
    public static Dictionary<string, object?> Of(
        IReadOnlyDictionary<string, object?> inputs,
        IReadOnlyDictionary<string, object?> vars)
        => Of(inputs, vars, BlokError.ContextSnapshotMaxBytes, 16);

    /// <summary>
    /// Customizable variant. <c>maxVarsKeys=0</c> drops vars entirely.
    /// <c>maxBytes&lt;=0</c> disables byte-budget trimming.
    /// </summary>
    public static Dictionary<string, object?> Of(
        IReadOnlyDictionary<string, object?> inputs,
        IReadOnlyDictionary<string, object?> vars,
        int maxBytes,
        int maxVarsKeys)
    {
        var safeInputs = JsonSafeMap(inputs);

        // SortedDictionary gives a deterministic "last N" slice.
        // Dictionary<TKey,TValue> iteration order is implementation-defined;
        // tests need determinism. Mirrors Java's TreeMap and Rust's BTreeMap.
        var sorted = new SortedDictionary<string, object?>(
            (vars as IDictionary<string, object?>) ?? new Dictionary<string, object?>(vars ?? new Dictionary<string, object?>()));
        var keys = sorted.Keys.ToList();
        if (maxVarsKeys >= 0 && keys.Count > maxVarsKeys)
        {
            keys = keys.GetRange(keys.Count - maxVarsKeys, maxVarsKeys);
        }

        var recent = new Dictionary<string, object?>();
        foreach (var k in keys)
        {
            recent[k] = JsonSafe(sorted[k]);
        }

        var snapshot = new Dictionary<string, object?>
        {
            ["inputs"] = safeInputs,
            ["vars"] = recent,
        };

        if (maxBytes <= 0) return snapshot;
        if (EncodedBytes(snapshot) <= maxBytes) return snapshot;

        // Trim from the front (oldest keys) until the snapshot fits.
        while (keys.Count > 0)
        {
            keys.RemoveAt(0);
            recent = new Dictionary<string, object?>();
            foreach (var k in keys)
            {
                recent[k] = JsonSafe(sorted[k]);
            }
            snapshot["vars"] = recent;
            if (EncodedBytes(snapshot) <= maxBytes) return snapshot;
        }

        return new Dictionary<string, object?>
        {
            ["inputs"] = safeInputs,
            ["vars"] = new Dictionary<string, object?>(),
            ["_truncated"] = true,
        };
    }

    private static int EncodedBytes(object value)
    {
        try
        {
            return JsonSerializer.SerializeToUtf8Bytes(value, JsonOptions).Length;
        }
        catch
        {
            return int.MaxValue;
        }
    }

    private static Dictionary<string, object?> JsonSafeMap(IReadOnlyDictionary<string, object?> m)
    {
        var output = new Dictionary<string, object?>();
        if (m is null) return output;
        foreach (var kv in m)
        {
            output[kv.Key] = JsonSafe(kv.Value);
        }
        return output;
    }

    private static object? JsonSafe(object? v)
    {
        if (v is null
            || v is string
            || v is bool
            || v is sbyte || v is byte
            || v is short || v is ushort
            || v is int || v is uint
            || v is long || v is ulong
            || v is float || v is double || v is decimal
            || v is JsonElement)
        {
            return v;
        }

        if (v is IReadOnlyDictionary<string, object?> readOnlyMap)
        {
            return JsonSafeMap(readOnlyMap);
        }

        if (v is IDictionary<string, object?> map)
        {
            var output = new Dictionary<string, object?>();
            foreach (var kv in map)
            {
                output[kv.Key] = JsonSafe(kv.Value);
            }
            return output;
        }

        if (v is System.Collections.IDictionary rawMap)
        {
            var output = new Dictionary<string, object?>();
            foreach (System.Collections.DictionaryEntry e in rawMap)
            {
                output[e.Key.ToString() ?? ""] = JsonSafe(e.Value);
            }
            return output;
        }

        if (v is System.Collections.IEnumerable list && v is not string)
        {
            var output = new List<object?>();
            foreach (var x in list) output.Add(JsonSafe(x));
            return output;
        }

        // Anything else — try a JSON round-trip; on failure fall back to ToString.
        try
        {
            var json = JsonSerializer.Serialize(v, JsonOptions);
            return JsonSerializer.Deserialize<object?>(json, JsonOptions);
        }
        catch
        {
            return v.ToString();
        }
    }
}
