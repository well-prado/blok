using System.Text.Json;
using Blok.Core.Node;
using Blok.Core.Types;

namespace Blok.Core.Testing;

/// <summary>
/// TestNodeRunner executes nodes in-process for testing.
/// </summary>
public class TestNodeRunner
{
    private readonly NodeRegistry _registry;

    public TestNodeRunner()
    {
        _registry = new NodeRegistry("test");
    }

    /// <summary>
    /// Register a node for testing.
    /// </summary>
    public TestNodeRunner Register(string name, INodeHandler handler)
    {
        _registry.Register(name, handler);
        return this;
    }

    /// <summary>
    /// Execute a node with the given context and config.
    /// </summary>
    public async Task<ExecutionResult> ExecuteAsync(
        string name,
        Context context,
        Dictionary<string, JsonElement>? config = null)
    {
        var request = new ExecutionRequest
        {
            Node = new NodeConfig
            {
                Name = name,
                Path = string.Empty,
                Type = string.Empty,
                Config = config ?? new Dictionary<string, JsonElement>()
            },
            Context = context
        };

        return await _registry.ExecuteAsync(request);
    }
}
