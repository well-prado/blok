using System.Text.Json;
using Nanoservice.Core.Node;

namespace Nanoservice.Core.Middleware;

/// <summary>
/// RecoveryMiddleware catches exceptions and returns them as error JSON.
/// </summary>
public class RecoveryMiddleware : IMiddleware
{
    public INodeHandler Wrap(INodeHandler next)
    {
        return new RecoveryHandler(next);
    }

    private class RecoveryHandler : INodeHandler
    {
        private readonly INodeHandler _inner;

        public RecoveryHandler(INodeHandler inner)
        {
            _inner = inner;
        }

        public async Task<JsonElement> ExecuteAsync(Types.Context ctx, Dictionary<string, JsonElement> config)
        {
            try
            {
                return await _inner.ExecuteAsync(ctx, config);
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[RECOVERY] Caught exception: {ex.Message}");

                var errorJson = JsonSerializer.Serialize(new
                {
                    error = ex.Message,
                    type = ex.GetType().Name,
                    recovered = true
                });

                return JsonDocument.Parse(errorJson).RootElement.Clone();
            }
        }
    }
}
