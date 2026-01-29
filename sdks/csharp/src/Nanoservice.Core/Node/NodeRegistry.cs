using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json;
using Nanoservice.Core.Types;

namespace Nanoservice.Core.Node;

/// <summary>
/// NodeRegistry manages registered node handlers and dispatches execution requests.
/// </summary>
public class NodeRegistry
{
    private readonly ConcurrentDictionary<string, INodeHandler> _nodes = new();
    private readonly string _version;

    public NodeRegistry(string version = "1.0.0")
    {
        _version = version;
    }

    /// <summary>
    /// Register a node handler under the given name.
    /// </summary>
    public void Register(string name, INodeHandler handler)
    {
        _nodes[name] = handler;
    }

    /// <summary>
    /// Look up a node handler by name.
    /// </summary>
    public INodeHandler? Get(string name)
    {
        return _nodes.TryGetValue(name, out var handler) ? handler : null;
    }

    /// <summary>
    /// Return the names of all registered nodes.
    /// </summary>
    public List<string> NodeNames()
    {
        return _nodes.Keys.ToList();
    }

    /// <summary>
    /// Return the number of registered nodes.
    /// </summary>
    public int Count => _nodes.Count;

    /// <summary>
    /// Execute a node by dispatching through the registry.
    /// </summary>
    public async Task<ExecutionResult> ExecuteAsync(ExecutionRequest request)
    {
        var handler = Get(request.Node.Name);
        if (handler is null)
        {
            return ExecutionResult.Fail($"node '{request.Node.Name}' not found in registry");
        }

        var memBefore = GC.GetTotalMemory(false);
        var stopwatch = Stopwatch.StartNew();

        try
        {
            var data = await handler.ExecuteAsync(request.Context, request.Node.Config);
            stopwatch.Stop();
            var memAfter = GC.GetTotalMemory(false);

            return ExecutionResult.Ok(data).WithMetrics(new ExecutionMetrics
            {
                DurationMs = stopwatch.Elapsed.TotalMilliseconds,
                MemoryBytes = Math.Max(0, memAfter - memBefore)
            });
        }
        catch (Exception ex)
        {
            stopwatch.Stop();
            var result = ExecutionResult.Fail(ex.Message);
            result.Metrics = new ExecutionMetrics
            {
                DurationMs = stopwatch.Elapsed.TotalMilliseconds
            };
            return result;
        }
    }

    /// <summary>
    /// Return the health status of the runtime.
    /// </summary>
    public HealthStatus GetHealth()
    {
        return new HealthStatus
        {
            Status = "healthy",
            Version = _version,
            NodesLoaded = NodeNames()
        };
    }
}
