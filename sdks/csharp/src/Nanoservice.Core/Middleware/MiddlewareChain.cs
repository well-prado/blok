using Nanoservice.Core.Node;

namespace Nanoservice.Core.Middleware;

/// <summary>
/// MiddlewareChain applies a chain of middleware to a handler.
/// </summary>
public class MiddlewareChain
{
    private readonly List<IMiddleware> _middlewares = new();

    /// <summary>
    /// Add a middleware to the chain.
    /// </summary>
    public MiddlewareChain Use(IMiddleware middleware)
    {
        _middlewares.Add(middleware);
        return this;
    }

    /// <summary>
    /// Apply all middleware to the given handler, returning the wrapped handler.
    /// Middleware is applied in order: first added wraps outermost.
    /// </summary>
    public INodeHandler Apply(INodeHandler handler)
    {
        var current = handler;
        // Apply in reverse so that the first middleware added is the outermost wrapper
        for (int i = _middlewares.Count - 1; i >= 0; i--)
        {
            current = _middlewares[i].Wrap(current);
        }
        return current;
    }
}
