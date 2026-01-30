using System.Text.Json;

namespace Blok.Core.Node;

/// <summary>
/// INodeHandler is the core interface that all Blok nodes must implement.
/// </summary>
public interface INodeHandler
{
    /// <summary>
    /// Execute the node logic with the given workflow context and node configuration.
    /// </summary>
    /// <param name="ctx">The workflow execution context.</param>
    /// <param name="config">Node-specific configuration from the runner.</param>
    /// <returns>A JSON element representing the result data.</returns>
    Task<JsonElement> ExecuteAsync(Types.Context ctx, Dictionary<string, JsonElement> config);
}
