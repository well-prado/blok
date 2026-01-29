using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Nanoservice.Core.Config;
using Nanoservice.Core.Node;
using Nanoservice.Core.Types;

namespace Nanoservice.Core.Server;

/// <summary>
/// RuntimeServer hosts the nanoservice HTTP endpoints using ASP.NET Minimal APIs.
/// </summary>
public static class RuntimeServer
{
    private static readonly JsonSerializerOptions SerializerOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull
    };

    /// <summary>
    /// Start the runtime server with the given registry and optional configuration.
    /// </summary>
    public static async Task Run(NodeRegistry registry, ServerConfig? config = null)
    {
        config ??= ServerConfig.FromEnv();

        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseUrls($"http://{config.Address()}");
        builder.Services.AddSingleton(registry);

        if (config.EnableCors)
        {
            builder.Services.AddCors(options =>
            {
                options.AddDefaultPolicy(policy =>
                {
                    policy.AllowAnyOrigin()
                          .AllowAnyMethod()
                          .AllowAnyHeader();
                });
            });
        }

        var app = builder.Build();

        if (config.EnableCors)
        {
            app.UseCors();
        }

        MapEndpoints(app, registry);

        Console.WriteLine($"Nanoservice C# Runtime v{config.Version} listening on {config.Address()}");
        Console.WriteLine($"  {registry.Count} node(s) registered: [{string.Join(", ", registry.NodeNames())}]");

        await app.RunAsync();
    }

    /// <summary>
    /// Map the /execute and /health endpoints.
    /// </summary>
    internal static void MapEndpoints(IEndpointRouteBuilder app, NodeRegistry registry)
    {
        app.MapPost("/execute", async (HttpContext httpContext) =>
        {
            string body;
            using (var reader = new StreamReader(httpContext.Request.Body))
            {
                body = await reader.ReadToEndAsync();
            }

            ExecutionRequest? request;
            try
            {
                request = JsonSerializer.Deserialize<ExecutionRequest>(body, SerializerOptions);
            }
            catch (JsonException ex)
            {
                httpContext.Response.StatusCode = 400;
                httpContext.Response.ContentType = "application/json";
                var errorResult = ExecutionResult.Fail($"invalid JSON: {ex.Message}");
                await httpContext.Response.WriteAsJsonAsync(errorResult, SerializerOptions);
                return;
            }

            if (request is null)
            {
                httpContext.Response.StatusCode = 400;
                httpContext.Response.ContentType = "application/json";
                var errorResult = ExecutionResult.Fail("request body is empty");
                await httpContext.Response.WriteAsJsonAsync(errorResult, SerializerOptions);
                return;
            }

            var result = await registry.ExecuteAsync(request);

            httpContext.Response.StatusCode = 200;
            httpContext.Response.ContentType = "application/json";
            await httpContext.Response.WriteAsJsonAsync(result, SerializerOptions);
        });

        app.MapGet("/health", (HttpContext httpContext) =>
        {
            httpContext.Response.ContentType = "application/json";
            return Results.Json(registry.GetHealth(), SerializerOptions);
        });

        // Return 405 for non-POST on /execute
        app.MapGet("/execute", (HttpContext httpContext) =>
        {
            httpContext.Response.StatusCode = 405;
            return Results.Json(ExecutionResult.Fail("method not allowed: use POST"), SerializerOptions);
        });

        // Return 405 for non-GET on /health
        app.MapPost("/health", (HttpContext httpContext) =>
        {
            httpContext.Response.StatusCode = 405;
            return Results.Json(ExecutionResult.Fail("method not allowed: use GET"), SerializerOptions);
        });
    }
}
