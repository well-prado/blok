using System.Linq;
using Blok.Core.Node;
using Blok.Core.Types;

namespace Blok.Core.Nodes;

/// <summary>Typed greeting node demonstrating the SPEC-B TypedNode contract.</summary>
public sealed record TypedGreetInput(string Name, int Repeat = 1);

public sealed record TypedGreetOutput(string Greeting, int Length);

public sealed class TypedGreetNode : TypedNode<TypedGreetInput, TypedGreetOutput>
{
    public override string Name => "typed-greet";
    public override string Description => "Typed greeting (SPEC-B contract demo)";

    public override Task<TypedGreetOutput> RunAsync(Context ctx, TypedGreetInput input)
    {
        var repeat = input.Repeat > 0 ? input.Repeat : 1;
        var greeting = string.Concat(Enumerable.Repeat("Hello, " + input.Name, repeat));
        return Task.FromResult(new TypedGreetOutput(greeting, greeting.Length));
    }
}
