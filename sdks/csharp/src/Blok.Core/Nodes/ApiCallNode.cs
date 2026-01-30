using System.Text;
using System.Text.Json;
using Blok.Core.Errors;
using Blok.Core.Node;

namespace Blok.Core.Nodes;

/// <summary>
/// ApiCallNode makes HTTP requests to external APIs.
///
/// Config:
///   - url (string, required): The URL to call
///   - method (string, optional): HTTP method (default: GET)
///   - timeout (number, optional): Timeout in seconds (default: 10)
/// </summary>
public class ApiCallNode : INodeHandler
{
    public async Task<JsonElement> ExecuteAsync(Types.Context ctx, Dictionary<string, JsonElement> config)
    {
        // Get URL (required)
        if (!config.TryGetValue("url", out var urlProp) || urlProp.ValueKind != JsonValueKind.String)
        {
            throw NodeException.Configuration("'url' is required in node config");
        }
        var url = urlProp.GetString()!;

        // Get method (optional, default GET)
        var method = "GET";
        if (config.TryGetValue("method", out var methodProp) && methodProp.ValueKind == JsonValueKind.String)
        {
            method = methodProp.GetString()?.ToUpperInvariant() ?? "GET";
        }

        // Get timeout (optional, default 10)
        var timeoutSeconds = 10;
        if (config.TryGetValue("timeout", out var timeoutProp) && timeoutProp.ValueKind == JsonValueKind.Number)
        {
            timeoutSeconds = timeoutProp.TryGetInt32(out var t) ? t : 10;
        }

        using var httpClient = new HttpClient
        {
            Timeout = TimeSpan.FromSeconds(timeoutSeconds)
        };

        try
        {
            var httpMethod = method switch
            {
                "POST" => HttpMethod.Post,
                "PUT" => HttpMethod.Put,
                "PATCH" => HttpMethod.Patch,
                "DELETE" => HttpMethod.Delete,
                "HEAD" => HttpMethod.Head,
                _ => HttpMethod.Get
            };

            var requestMessage = new HttpRequestMessage(httpMethod, url);

            // Add body for POST/PUT/PATCH
            if (method is "POST" or "PUT" or "PATCH")
            {
                if (ctx.Request.Body.ValueKind == JsonValueKind.Object &&
                    ctx.Request.Body.TryGetProperty("body", out var bodyProp))
                {
                    requestMessage.Content = new StringContent(
                        bodyProp.GetRawText(),
                        Encoding.UTF8,
                        "application/json");
                }
            }

            // Add headers from config
            if (config.TryGetValue("headers", out var headersProp) && headersProp.ValueKind == JsonValueKind.Object)
            {
                foreach (var header in headersProp.EnumerateObject())
                {
                    if (header.Value.ValueKind == JsonValueKind.String)
                    {
                        requestMessage.Headers.TryAddWithoutValidation(header.Name, header.Value.GetString());
                    }
                }
            }

            var response = await httpClient.SendAsync(requestMessage);
            var statusCode = (int)response.StatusCode;
            var bodyText = await response.Content.ReadAsStringAsync();

            // Try to parse response as JSON, fall back to string
            JsonElement data;
            try
            {
                data = JsonDocument.Parse(bodyText).RootElement.Clone();
            }
            catch
            {
                data = JsonDocument.Parse($"\"{bodyText.Replace("\"", "\\\"")}\"").RootElement.Clone();
            }

            // Collect response headers
            var responseHeaders = new Dictionary<string, string>();
            foreach (var header in response.Headers)
            {
                responseHeaders[header.Key] = string.Join(", ", header.Value);
            }
            foreach (var header in response.Content.Headers)
            {
                responseHeaders[header.Key] = string.Join(", ", header.Value);
            }

            var result = JsonSerializer.Serialize(new
            {
                status = statusCode,
                data,
                headers = responseHeaders
            });

            return JsonDocument.Parse(result).RootElement.Clone();
        }
        catch (TaskCanceledException)
        {
            throw NodeException.Network($"request to {url} timed out after {timeoutSeconds}s");
        }
        catch (HttpRequestException ex)
        {
            throw NodeException.Network($"request to {url} failed: {ex.Message}");
        }
    }
}
