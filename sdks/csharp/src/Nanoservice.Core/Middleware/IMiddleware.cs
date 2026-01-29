using Nanoservice.Core.Node;

namespace Nanoservice.Core.Middleware;

/// <summary>
/// IMiddleware wraps a node handler to add cross-cutting behavior.
/// </summary>
public interface IMiddleware
{
    /// <summary>
    /// Wrap a handler and return a new handler with additional behavior.
    /// </summary>
    INodeHandler Wrap(INodeHandler next);
}
