using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json;

namespace Blok.Runtime;

/// <summary>
/// NodeRegistry manages registered node handlers and provides execution
/// capabilities with error handling and performance metrics.
/// </summary>
public sealed class NodeRegistry
{
    private readonly ConcurrentDictionary<string, INodeHandler> _nodes = new();

    /// <summary>
    /// Registers a node handler with the given name.
    /// </summary>
    /// <param name="name">The unique name used to identify this node.</param>
    /// <param name="handler">The node handler implementation.</param>
    /// <exception cref="ArgumentNullException">Thrown when name or handler is null.</exception>
    public void Register(string name, INodeHandler handler)
    {
        ArgumentNullException.ThrowIfNull(name);
        ArgumentNullException.ThrowIfNull(handler);
        _nodes[name] = handler;
    }

    /// <summary>
    /// Retrieves a node handler by name.
    /// </summary>
    /// <param name="name">The name of the node to retrieve.</param>
    /// <returns>The node handler, or null if not found.</returns>
    public INodeHandler? Get(string name)
    {
        _nodes.TryGetValue(name, out var handler);
        return handler;
    }

    /// <summary>
    /// Executes a node identified by the execution request.
    /// Captures timing metrics and handles errors gracefully.
    /// </summary>
    /// <param name="request">The execution request from the Blok runner.</param>
    /// <returns>The execution result with data or error details.</returns>
    public async Task<ExecutionResult> ExecuteAsync(ExecutionRequest request)
    {
        var handler = Get(request.Node.Name);

        if (handler is null)
        {
            return ExecutionResult.Fail(
                $"Node '{request.Node.Name}' not found",
                "NodeNotFoundError"
            );
        }

        var stopwatch = Stopwatch.StartNew();

        try
        {
            var data = await handler.ExecuteAsync(request.Context, request.Node.Config);
            stopwatch.Stop();

            var metrics = new ExecutionMetrics
            {
                DurationMs = stopwatch.Elapsed.TotalMilliseconds,
                MemoryBytes = GC.GetTotalMemory(forceFullCollection: false)
            };

            return ExecutionResult.Ok(data, metrics);
        }
        catch (Exception ex)
        {
            stopwatch.Stop();

            return ExecutionResult.Fail(
                ex.Message,
                ex.GetType().Name
            );
        }
    }

    /// <summary>
    /// Returns the health status of the runtime, including the list of
    /// registered node names.
    /// </summary>
    /// <param name="version">The runtime version string.</param>
    /// <returns>A health status object.</returns>
    public HealthStatus GetHealth(string version)
    {
        return new HealthStatus
        {
            Status = "healthy",
            Version = version,
            NodesLoaded = _nodes.Keys.ToList()
        };
    }

    /// <summary>
    /// Returns the number of registered nodes.
    /// </summary>
    public int Count => _nodes.Count;
}
