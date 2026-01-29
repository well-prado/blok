using System.Diagnostics;
using System.Text.Json;
using Nanoservice.Core.Node;

namespace Nanoservice.Core.Middleware;

/// <summary>
/// LoggingMiddleware logs node execution with timing.
/// </summary>
public class LoggingMiddleware : IMiddleware
{
    public INodeHandler Wrap(INodeHandler next)
    {
        return new LoggingHandler(next);
    }

    private class LoggingHandler : INodeHandler
    {
        private readonly INodeHandler _inner;

        public LoggingHandler(INodeHandler inner)
        {
            _inner = inner;
        }

        public async Task<JsonElement> ExecuteAsync(Types.Context ctx, Dictionary<string, JsonElement> config)
        {
            var stopwatch = Stopwatch.StartNew();
            Console.WriteLine($"[INFO] {DateTime.UtcNow:O} Node execution started workflow={ctx.WorkflowName}");

            try
            {
                var result = await _inner.ExecuteAsync(ctx, config);
                stopwatch.Stop();
                Console.WriteLine($"[INFO] {DateTime.UtcNow:O} Node execution completed workflow={ctx.WorkflowName} duration_ms={stopwatch.Elapsed.TotalMilliseconds:F2}");
                return result;
            }
            catch (Exception ex)
            {
                stopwatch.Stop();
                Console.WriteLine($"[ERROR] {DateTime.UtcNow:O} Node execution failed workflow={ctx.WorkflowName} duration_ms={stopwatch.Elapsed.TotalMilliseconds:F2} error={ex.Message}");
                throw;
            }
        }
    }
}
