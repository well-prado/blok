using System.ComponentModel.DataAnnotations;
using System.Text;
using System.Text.Json;
using Blok.Core.Errors;
using Blok.Core.Types;

namespace Blok.Core.Node;

/// <summary>
/// Implemented by typed nodes (<see cref="TypedNode{TInput,TOutput}"/>) to expose
/// a description + JSON Schema for the node catalog (GET /__blok/nodes) via gRPC
/// ListNodes (SPEC-B P4). Legacy <see cref="INodeHandler"/> nodes don't implement it.
/// </summary>
public interface INodeReflector
{
    string Description { get; }
    byte[] InputSchemaJson();
    byte[] OutputSchemaJson();
}

/// <summary>
/// Typed node base (SPEC-B P4) — the C# equivalent of the TypeScript
/// <c>defineNode</c> / Python <c>@node</c> / Rust <c>TypedNode</c>. Declare typed
/// <typeparamref name="TInput"/>/<typeparamref name="TOutput"/> (records with
/// <see cref="System.ComponentModel.DataAnnotations"/> attributes) and override
/// <see cref="RunAsync"/>; the SDK deserializes + validates the config into the
/// typed input BEFORE running, serializes the output, and reflects both JSON
/// Schemas — instead of a raw <c>Dictionary&lt;string, JsonElement&gt;</c>.
/// </summary>
/// <example>
/// <code>
/// public sealed record SearchInput([property: Required, MinLength(1)] string Query, int Limit = 10);
/// public sealed record SearchOutput(IReadOnlyList&lt;string&gt; Results, int Count);
///
/// public sealed class SearchNode : TypedNode&lt;SearchInput, SearchOutput&gt;
/// {
///     public override string Name =&gt; "@acme/search";
///     public override string Description =&gt; "Full-text search";
///     public override Task&lt;SearchOutput&gt; RunAsync(Context ctx, SearchInput input)
///     {
///         var rows = DoSearch(input.Query, input.Limit);
///         return Task.FromResult(new SearchOutput(rows, rows.Count));
///     }
/// }
/// </code>
/// </example>
public abstract class TypedNode<TInput, TOutput> : INodeHandler, INodeReflector
{
    private static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web);

    /// <summary>The node's registered name (e.g. <c>"@acme/search"</c>).</summary>
    public abstract string Name { get; }

    /// <summary>Human-readable description, surfaced in the node catalog.</summary>
    public virtual string Description => "";

    /// <summary>Run the node with a VALIDATED, typed input.</summary>
    public abstract Task<TOutput> RunAsync(Context ctx, TInput input);

    /// <inheritdoc />
    public async Task<JsonElement> ExecuteAsync(Context ctx, Dictionary<string, JsonElement> config)
    {
        TInput input;
        try
        {
            var json = JsonSerializer.Serialize(config, Options);
            input = JsonSerializer.Deserialize<TInput>(json, Options)
                ?? throw new JsonException("config deserialized to null");
        }
        catch (Exception e) when (e is not BlokError)
        {
            throw ValidationError($"Input validation failed for node '{Name}': {e.Message}");
        }

        var results = new List<ValidationResult>();
        if (!Validator.TryValidateObject(input!, new ValidationContext(input!), results, validateAllProperties: true))
        {
            var msg = string.Join("; ", results.Select(r => r.ErrorMessage ?? "invalid"));
            throw ValidationError($"Input validation failed for node '{Name}': {msg}");
        }

        var output = await RunAsync(ctx, input);
        return JsonSerializer.SerializeToElement(output, Options);
    }

    private BlokError ValidationError(string message) =>
        BlokError.Validation().Code("NODE_INPUT_VALIDATION").Message(message).HttpStatus(400).Node(Name).Build();

    /// <inheritdoc />
    public byte[] InputSchemaJson() => SchemaBytes(typeof(TInput));

    /// <inheritdoc />
    public byte[] OutputSchemaJson() => SchemaBytes(typeof(TOutput));

    private static byte[] SchemaBytes(Type type)
    {
        try
        {
            return Encoding.UTF8.GetBytes(NJsonSchema.JsonSchema.FromType(type).ToJson());
        }
        catch
        {
            return Array.Empty<byte>();
        }
    }
}
