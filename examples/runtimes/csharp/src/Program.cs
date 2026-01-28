using System.Text.Json;
using Blok.Runtime;
using Blok.Runtime.Nodes;

const string Version = "1.0.0";

// --- Configure JSON serialization options ---
var jsonOptions = new JsonSerializerOptions
{
    PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    PropertyNameCaseInsensitive = true,
    WriteIndented = false
};

// --- Initialize node registry ---
var registry = new NodeRegistry();

registry.Register("hello-world", new HelloWorldNode());
// Add more nodes here as needed:
// registry.Register("another-node", new AnotherNode());

// --- Build and configure the web application ---
var builder = WebApplication.CreateBuilder(args);

// Read PORT from environment variable, default to 8080
var port = Environment.GetEnvironmentVariable("PORT") ?? "8080";
builder.WebHost.UseUrls($"http://0.0.0.0:{port}");

// Configure JSON serialization for the entire application
builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
    options.SerializerOptions.PropertyNameCaseInsensitive = true;
});

var app = builder.Build();

// --- POST /execute - Execute a node ---
app.MapPost("/execute", async (HttpContext httpContext) =>
{
    try
    {
        var request = await JsonSerializer.DeserializeAsync<ExecutionRequest>(
            httpContext.Request.Body,
            jsonOptions
        );

        if (request is null)
        {
            httpContext.Response.StatusCode = 400;
            httpContext.Response.ContentType = "application/json";
            var errorResult = ExecutionResult.Fail("Invalid request body");
            await JsonSerializer.SerializeAsync(httpContext.Response.Body, errorResult, jsonOptions);
            return;
        }

        var result = await registry.ExecuteAsync(request);

        httpContext.Response.ContentType = "application/json";
        await JsonSerializer.SerializeAsync(httpContext.Response.Body, result, jsonOptions);
    }
    catch (JsonException ex)
    {
        httpContext.Response.StatusCode = 400;
        httpContext.Response.ContentType = "application/json";
        var errorResult = ExecutionResult.Fail($"Invalid JSON: {ex.Message}", "JsonParseError");
        await JsonSerializer.SerializeAsync(httpContext.Response.Body, errorResult, jsonOptions);
    }
    catch (Exception ex)
    {
        httpContext.Response.StatusCode = 500;
        httpContext.Response.ContentType = "application/json";
        var errorResult = ExecutionResult.Fail($"Internal server error: {ex.Message}", ex.GetType().Name);
        await JsonSerializer.SerializeAsync(httpContext.Response.Body, errorResult, jsonOptions);
    }
});

// --- GET /health - Health check ---
app.MapGet("/health", () =>
{
    var health = registry.GetHealth(Version);
    return Results.Json(health, jsonOptions);
});

// --- Start the server ---
app.Logger.LogInformation("Blok C# Runtime v{Version} starting on port {Port}", Version, port);
app.Logger.LogInformation("Registered nodes: {Count}", registry.Count);

app.Run();
