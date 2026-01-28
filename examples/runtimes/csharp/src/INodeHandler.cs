using System.Text.Json;

namespace Blok.Runtime;

/// <summary>
/// INodeHandler is the interface that all Blok nodes must implement.
/// Each node receives the workflow context and its specific configuration,
/// then returns a JSON result representing the node's output.
/// </summary>
public interface INodeHandler
{
    /// <summary>
    /// Executes the node logic with the given context and configuration.
    /// </summary>
    /// <param name="ctx">The workflow execution context.</param>
    /// <param name="config">Node-specific configuration as key-value pairs.</param>
    /// <returns>A JSON element representing the node's output data.</returns>
    Task<JsonElement> ExecuteAsync(Context ctx, Dictionary<string, JsonElement> config);
}
