using System.Text.Json;
using Blok.Core.Errors;
using Blok.Core.Node;

namespace Blok.Core.Middleware;

/// <summary>
/// RecoveryMiddleware catches exceptions and returns them as error JSON.
///
/// <para>Structured exceptions (<see cref="BlokError"/>, <see cref="NodeException"/>)
/// pass through verbatim so the registry / gRPC servicer can serialize them
/// losslessly. All other exceptions are wrapped in a recovered JSON shape.</para>
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
            catch (BlokError)
            {
                // Master plan §17 BlokError passes through verbatim — the
                // registry catches it directly and stashes the typed instance
                // on `ExecutionResult.Errors` for the gRPC servicer.
                throw;
            }
            catch (NodeException)
            {
                // Legacy structured exceptions pass through as-is too.
                throw;
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
