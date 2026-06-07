using System.ComponentModel.DataAnnotations;
using System.Text;
using System.Text.Json;
using Blok.Core.Errors;
using Blok.Core.Node;
using Blok.Core.Types;
using FluentAssertions;
using Xunit;

namespace Blok.Core.Tests;

public sealed record SearchInput([property: Required, MinLength(1)] string Query, int Limit = 10);

public sealed record SearchOutput(IReadOnlyList<string> Results, int Count);

public sealed class SearchNode : TypedNode<SearchInput, SearchOutput>
{
    public override string Name => "@acme/search";
    public override string Description => "Full-text search";

    public override Task<SearchOutput> RunAsync(Context ctx, SearchInput input)
    {
        var rows = Enumerable.Repeat(input.Query, input.Limit).ToList();
        return Task.FromResult(new SearchOutput(rows, rows.Count));
    }
}

public class TypedNodeTests
{
    private static readonly JsonSerializerOptions Web = new(JsonSerializerDefaults.Web);

    private static Dictionary<string, JsonElement> Cfg(object o)
    {
        var json = JsonSerializer.Serialize(o, Web);
        return JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(json, Web)!;
    }

    [Fact]
    public async Task ValidatesInputAndSerializesOutput()
    {
        var node = new SearchNode();
        var result = await node.ExecuteAsync(new Context(), Cfg(new { query = "ada", limit = 2 }));
        var output = result.Deserialize<SearchOutput>(Web)!;
        output.Count.Should().Be(2);
        output.Results[0].Should().Be("ada");
    }

    [Fact]
    public async Task InvalidInputThrowsStructuredBlokError()
    {
        var node = new SearchNode();
        // Query is [Required, MinLength(1)] → empty string fails DataAnnotations.
        var act = async () => await node.ExecuteAsync(new Context(), Cfg(new { query = "" }));
        var ex = await act.Should().ThrowAsync<BlokError>();
        ex.Which.HttpStatus.Should().Be(400);
        ex.Which.Code.Should().Be("NODE_INPUT_VALIDATION");
    }

    [Fact]
    public void ReflectsSchemasAndDescription()
    {
        INodeReflector node = new SearchNode();
        node.Description.Should().Be("Full-text search");

        var inputSchema = Encoding.UTF8.GetString(node.InputSchemaJson());
        inputSchema.Should().Contain("properties");
        node.OutputSchemaJson().Length.Should().BeGreaterThan(0);
    }
}
