using System.Text.Json;
using Blok.Core.Errors;
using Blok.Core.Node;

namespace Blok.Core.Nodes;

/// <summary>
/// Example node demonstrating the structured <see cref="BlokError"/> API per
/// master plan §17.
///
/// <para>Used by the cross-language E2E test
/// (<c>core/runner/__tests__/integration/runtimes/csharp-grpc.integration.test.ts</c>)
/// to verify that a C#-side structured error flows through the gRPC wire to
/// the runner with every field preserved (category, severity, code,
/// remediation, retryable hints, cause chain, context snapshot).</para>
///
/// <para>Triggered via the <c>mode</c> config:</para>
/// <list type="bullet">
///   <item><c>mode="dependency"</c> (default) — throws <c>BlokError.Dependency()</c>
///     with a cause chain rooted in an <see cref="IOException"/>.</item>
///   <item><c>mode="rate-limit"</c> — throws <c>BlokError.RateLimit()</c>
///     with <c>retry_after_ms</c>.</item>
///   <item><c>mode="validation"</c> — throws <c>BlokError.Validation()</c>
///     with <c>details.issues</c>.</item>
///   <item><c>mode="ok"</c> — returns success.</item>
/// </list>
/// </summary>
public class BlokErrorDemoNode : INodeHandler
{
    public Task<JsonElement> ExecuteAsync(Types.Context ctx, Dictionary<string, JsonElement> config)
    {
        var mode = "dependency";
        if (config.TryGetValue("mode", out var modeVal) && modeVal.ValueKind == JsonValueKind.String)
        {
            mode = modeVal.GetString() ?? "dependency";
        }

        if (mode == "ok")
        {
            var okJson = JsonSerializer.Serialize(new { ok = true, language = "csharp" });
            return Task.FromResult(JsonDocument.Parse(okJson).RootElement.Clone());
        }

        // Build the snapshot from the resolved inputs + ctx.vars.
        var configMap = ConfigToObjectMap(config);
        var snapshot = BuildContextSnapshot.Of(configMap, ctx.Vars ?? new Dictionary<string, object?>());

        if (mode == "rate-limit")
        {
            throw BlokError.RateLimit()
                .Code("UPSTREAM_RATE_LIMITED")
                .Message("Upstream API returned 429")
                .Description("GitHub API rate limit hit (5000 req/hr).")
                .Remediation("Wait until the X-RateLimit-Reset header timestamp.")
                .RetryAfterMs(60_000)
                .DocUrl("https://docs.example.com/errors/rate-limit")
                .Details(new Dictionary<string, object?>
                {
                    ["limit"] = 5000,
                    ["remaining"] = 0,
                })
                .ContextSnapshot(snapshot)
                .Build();
        }

        if (mode == "validation")
        {
            throw BlokError.Validation()
                .Code("VALIDATION_FAILED")
                .Message("2 validation issues")
                .Description("Inputs didn't match the node's schema.")
                .Remediation("Provide both `email` and `name`.")
                .Details(new Dictionary<string, object?>
                {
                    ["issues"] = new List<Dictionary<string, object?>>
                    {
                        new() { ["path"] = new List<string> { "email" }, ["message"] = "Required" },
                        new() { ["path"] = new List<string> { "name" }, ["message"] = "Required" },
                    },
                })
                .ContextSnapshot(snapshot)
                .Build();
        }

        // default: dependency with a cause chain rooted in an IOException.
        var cause = new IOException("[Errno 61] Connection refused");
        throw BlokError.Dependency()
            .Code("POSTGRES_CONNECT_TIMEOUT")
            .Message("Could not connect to Postgres within 5s")
            .Description("Tried host=db.internal port=5432; timeout=5000ms")
            .Remediation("Check DATABASE_URL env var and network reachability")
            .Cause(cause)
            .Retryable(true)
            .RetryAfter(TimeSpan.FromSeconds(5))
            .DocUrl("https://docs.example.com/errors/POSTGRES_CONNECT_TIMEOUT")
            .Details(new Dictionary<string, object?>
            {
                ["host"] = "db.internal",
                ["port"] = 5432,
                ["timeout_ms"] = 5000,
            })
            .ContextSnapshot(snapshot)
            .Build();
    }

    private static Dictionary<string, object?> ConfigToObjectMap(Dictionary<string, JsonElement> config)
    {
        var map = new Dictionary<string, object?>();
        foreach (var kv in config)
        {
            map[kv.Key] = JsonElementToObject(kv.Value);
        }
        return map;
    }

    private static object? JsonElementToObject(JsonElement el) => el.ValueKind switch
    {
        JsonValueKind.String => el.GetString(),
        JsonValueKind.Number => el.TryGetInt64(out var l) ? (object)l : el.GetDouble(),
        JsonValueKind.True => true,
        JsonValueKind.False => false,
        JsonValueKind.Null => null,
        _ => el.GetRawText(),
    };
}
