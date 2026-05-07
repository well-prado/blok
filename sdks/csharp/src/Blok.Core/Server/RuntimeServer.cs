using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.Server.Kestrel.Core;
using Microsoft.Extensions.DependencyInjection;
using Blok.Core.Config;
using Blok.Core.Node;
using Blok.Core.Types;

namespace Blok.Core.Server;

/// <summary>
/// RuntimeServer hosts the blok HTTP and/or gRPC endpoints using Kestrel.
///
/// Selects transports via <see cref="ServerConfig.Transport" />:
/// <list type="bullet">
///   <item><description><see cref="Transport.Http" />: HTTP only on <see cref="ServerConfig.Port" />.</description></item>
///   <item><description><see cref="Transport.Grpc" />: gRPC only on <see cref="ServerConfig.GrpcPort" />.</description></item>
///   <item><description><see cref="Transport.Both" />: HTTP + gRPC concurrently on separate Kestrel listeners.</description></item>
/// </list>
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
        builder.Services.AddSingleton(registry);

        var transport = config.Transport;
        var includeHttp = transport == Transport.Http || transport == Transport.Both;
        var includeGrpc = transport == Transport.Grpc || transport == Transport.Both;

        // Register Kestrel listeners separately per transport so each port
        // negotiates the right HTTP protocol.
        builder.WebHost.ConfigureKestrel(options =>
        {
            if (includeHttp)
            {
                options.ListenAnyIP(config.Port, listenOpts =>
                {
                    listenOpts.Protocols = HttpProtocols.Http1AndHttp2;
                });
            }
            if (includeGrpc)
            {
                options.ListenAnyIP(config.GrpcPort, listenOpts =>
                {
                    // gRPC requires HTTP/2 over h2c (cleartext) when no TLS.
                    listenOpts.Protocols = HttpProtocols.Http2;
                });
            }
        });

        if (includeGrpc)
        {
            builder.Services.AddGrpc(options =>
            {
                // Match the runner-side default + PHP-buffer ceiling from FIXES.md #5.
                options.MaxReceiveMessageSize = 16 * 1024 * 1024;
                options.MaxSendMessageSize = 16 * 1024 * 1024;
            });
            builder.Services.AddSingleton<BlokNodeRuntimeService>(sp => new BlokNodeRuntimeService(
                sp.GetRequiredService<NodeRegistry>(),
                config.Version));
        }

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

        app.UseRouting();

        if (includeHttp)
        {
            MapEndpoints(app, registry);
        }
        if (includeGrpc)
        {
            app.MapGrpcService<BlokNodeRuntimeService>();
        }

        Console.WriteLine($"Blok C# Runtime v{config.Version} (transport={transport})");
        if (includeHttp) Console.WriteLine($"  HTTP listening on {config.Host}:{config.Port}");
        if (includeGrpc) Console.WriteLine($"  gRPC listening on {config.Host}:{config.GrpcPort}");
        Console.WriteLine($"  {registry.Count} node(s) registered: [{string.Join(", ", registry.NodeNames())}]");

        await app.RunAsync();
    }

    /// <summary>
    /// Map the /execute and /health endpoints (HTTP transport).
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
