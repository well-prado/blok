using System.Text.Json;
using Blok.Core.Node;
using Blok.Core.Types;
using Blok.Runtime.V1;
using Google.Protobuf;
using Google.Protobuf.WellKnownTypes;
using Grpc.Core;

namespace Blok.Core.Server;

/// <summary>
/// gRPC implementation of the canonical Blok <c>NodeRuntime</c> v1 service.
///
/// Wire contract: <c>proto/blok/runtime/v1/runtime.proto</c>. Generated stubs
/// are produced by <c>Grpc.Tools</c> at build time (configured in
/// <c>Blok.Core.csproj</c>).
///
/// Single Responsibility: translate proto messages into the SDK's internal
/// <see cref="ExecutionRequest" /> / <see cref="ExecutionResult" /> and
/// dispatch to <see cref="NodeRegistry" />. All node-level error handling
/// lives in <see cref="NodeRegistry.ExecuteAsync(ExecutionRequest)" />.
///
/// The proto sends <c>inputs</c>, <c>previous_output</c>, <c>vars</c>, and
/// the request <c>body</c> as raw JSON-encoded <c>bytes</c>. The SDK
/// JSON-decodes them lazily here at the proto boundary so node handlers
/// see the same <see cref="JsonElement" /> shapes as the HTTP path.
/// </summary>
public sealed class BlokNodeRuntimeService : NodeRuntime.NodeRuntimeBase
{
    private static readonly JsonSerializerOptions SerializerOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly NodeRegistry _registry;
    private readonly string _sdkVersion;

    public BlokNodeRuntimeService(NodeRegistry registry, string sdkVersion)
    {
        _registry = registry;
        _sdkVersion = sdkVersion;
    }

    /// <inheritdoc />
    public override async Task<ExecuteResponse> Execute(ExecuteRequest request, ServerCallContext context)
    {
        ExecutionRequest executionRequest;
        try
        {
            executionRequest = DecodeExecuteRequest(request);
        }
        catch (DecodeException ex)
        {
            throw new RpcException(new Status(StatusCode.InvalidArgument, ex.Message));
        }

        var result = await _registry.ExecuteAsync(executionRequest);
        return EncodeExecuteResponse(result, executionRequest.Node.Name, _sdkVersion);
    }

    /// <inheritdoc />
    /// <remarks>
    /// Server-streaming variant of <see cref="Execute" />. Emits, in order:
    /// (1) one <c>NodeStarted</c> event marking call acceptance, (2) one
    /// terminal <c>ExecuteResponse</c> matching the unary payload.
    ///
    /// Log capture (LogLine events) is intentionally out of scope for the
    /// Phase 5 C# pilot — <see cref="INodeHandler" /> has no per-call
    /// logger sink, and threading one through would change the SDK API.
    /// Real-time log streaming arrives in a follow-up.
    /// </remarks>
    public override async Task ExecuteStream(ExecuteRequest request, IServerStreamWriter<ExecuteEvent> responseStream, ServerCallContext context)
    {
        ExecutionRequest executionRequest;
        try
        {
            executionRequest = DecodeExecuteRequest(request);
        }
        catch (DecodeException ex)
        {
            throw new RpcException(new Status(StatusCode.InvalidArgument, ex.Message));
        }

        await responseStream.WriteAsync(new ExecuteEvent
        {
            Started = new NodeStarted { At = Timestamp.FromDateTime(DateTime.UtcNow) },
        });

        var result = await _registry.ExecuteAsync(executionRequest);
        var finalResponse = EncodeExecuteResponse(result, executionRequest.Node.Name, _sdkVersion);

        await responseStream.WriteAsync(new ExecuteEvent { Final = finalResponse });
    }

    /// <inheritdoc />
    public override Task<HealthResponse> Health(HealthRequest request, ServerCallContext context)
    {
        var health = new HealthResponse
        {
            Status = HealthResponse.Types.Status.Serving,
            SdkVersion = _sdkVersion,
        };
        health.RegisteredNodes.AddRange(_registry.NodeNames());
        return Task.FromResult(health);
    }

    /// <inheritdoc />
    public override Task<ListNodesResponse> ListNodes(ListNodesRequest request, ServerCallContext context)
    {
        var response = new ListNodesResponse
        {
            SdkName = "blok-csharp",
            SdkVersion = _sdkVersion,
            ProtoVersion = "1.0.0",
        };
        foreach (var name in _registry.NodeNames())
        {
            response.Nodes.Add(new NodeDescriptor
            {
                Name = name,
                Description = "",
            });
        }
        return Task.FromResult(response);
    }

    // =========================================================================
    // Codec — proto ↔ internal types
    // =========================================================================

    private sealed class DecodeException : Exception
    {
        public DecodeException(string message) : base(message) { }
    }

    private static ExecutionRequest DecodeExecuteRequest(ExecuteRequest req)
    {
        if (req.Node is null || string.IsNullOrEmpty(req.Node.Name))
        {
            throw new DecodeException("ExecuteRequest.node is required");
        }

        var inputsConfig = DecodeJsonObject(req.Inputs, "inputs");
        var previousOutput = DecodeJsonValue(req.State?.PreviousOutput ?? ByteString.Empty, "previous_output");
        var vars = DecodeJsonValueObject(req.State?.Vars ?? ByteString.Empty, "vars");
        var bodyElement = DecodeRequestBody(req.Trigger?.Body ?? ByteString.Empty, req.Trigger?.Headers);

        var trigger = req.Trigger;
        var state = req.State;
        var workflow = req.Workflow;

        return new ExecutionRequest
        {
            Node = new NodeConfig
            {
                Name = req.Node.Name,
                Type = req.Node.Type,
                Config = inputsConfig,
            },
            Context = new Types.Context
            {
                Id = workflow?.RunId ?? string.Empty,
                WorkflowName = workflow?.Name ?? string.Empty,
                WorkflowPath = workflow?.Path ?? string.Empty,
                Request = new Request
                {
                    Body = bodyElement,
                    Headers = trigger is null ? new Dictionary<string, string>() : new Dictionary<string, string>(trigger.Headers),
                    Params = trigger is null ? new Dictionary<string, string>() : new Dictionary<string, string>(trigger.Params),
                    Query = trigger is null ? new Dictionary<string, string>() : new Dictionary<string, string>(trigger.Query),
                    Cookies = trigger is null ? new Dictionary<string, string>() : new Dictionary<string, string>(trigger.Cookies),
                    Method = trigger?.Method ?? string.Empty,
                    Url = trigger?.Url ?? string.Empty,
                    BaseUrl = trigger?.BaseUrl ?? string.Empty,
                },
                Response = new Response
                {
                    Data = previousOutput,
                    ContentType = "application/json",
                    Success = true,
                    Error = null,
                },
                Vars = vars,
                Env = state is null ? new Dictionary<string, string>() : new Dictionary<string, string>(state.Env),
            },
        };
    }

    private static ExecuteResponse EncodeExecuteResponse(ExecutionResult result, string nodeName, string sdkVersion)
    {
        var response = new ExecuteResponse
        {
            Success = result.Success,
            ContentType = "application/json",
        };

        if (result.Success && result.Data is not null)
        {
            response.Data = ByteString.CopyFromUtf8(JsonSerializer.Serialize(result.Data, SerializerOptions));
        }

        if (result.Vars is { Count: > 0 })
        {
            response.VarsDelta = ByteString.CopyFromUtf8(JsonSerializer.Serialize(result.Vars, SerializerOptions));
        }

        if (result.Metrics is not null)
        {
            response.Metrics = new Metrics
            {
                DurationMs = result.Metrics.DurationMs ?? 0.0,
                CpuMs = result.Metrics.CpuMs ?? 0.0,
                MemoryBytes = result.Metrics.MemoryBytes ?? 0L,
            };
        }

        if (!result.Success)
        {
            response.Error = InternalErrorToProto(result.Errors, nodeName, sdkVersion);
        }

        return response;
    }

    private static NodeError InternalErrorToProto(object? errVal, string nodeName, string sdkVersion)
    {
        var message = "node error";
        ByteString detailsJson = ByteString.Empty;

        switch (errVal)
        {
            case null:
                break;
            case string s:
                message = s;
                detailsJson = EncodeJsonBytes(new Dictionary<string, object?> { ["message"] = s });
                break;
            case Dictionary<string, object?> dict:
                if (dict.TryGetValue("message", out var msg) && msg is string msgStr && !string.IsNullOrEmpty(msgStr))
                {
                    message = msgStr;
                }
                detailsJson = EncodeJsonBytes(dict);
                break;
            default:
                message = errVal.ToString() ?? "node error";
                detailsJson = EncodeJsonBytes(new Dictionary<string, object?> { ["message"] = message });
                break;
        }

        return new NodeError
        {
            Code = "CSHARP_NODE_ERROR",
            Category = ErrorCategory.Internal,
            Severity = ErrorSeverity.Error,
            Node = nodeName,
            Sdk = "blok-csharp",
            SdkVersion = sdkVersion,
            RuntimeKind = "runtime.csharp",
            Message = message,
            Description = string.Empty,
            Remediation = string.Empty,
            DocUrl = string.Empty,
            Stack = string.Empty,
            HttpStatus = 500,
            Retryable = false,
            RetryAfterMs = 0,
            DetailsJson = detailsJson,
        };
    }

    /// <summary>Decode JSON-encoded bytes into a typed config dictionary.</summary>
    private static Dictionary<string, JsonElement> DecodeJsonObject(ByteString bytes, string field)
    {
        if (bytes.IsEmpty) return new Dictionary<string, JsonElement>();

        try
        {
            using var doc = JsonDocument.Parse(bytes.ToStringUtf8());
            var root = doc.RootElement;
            if (root.ValueKind == JsonValueKind.Object)
            {
                var map = new Dictionary<string, JsonElement>();
                foreach (var prop in root.EnumerateObject())
                {
                    map[prop.Name] = prop.Value.Clone();
                }
                return map;
            }
            // Wrap non-object payloads under a reserved key so handlers
            // expecting a dictionary keep working.
            return new Dictionary<string, JsonElement> { ["_value"] = root.Clone() };
        }
        catch (JsonException ex)
        {
            throw new DecodeException($"invalid `{field}` JSON: {ex.Message}");
        }
    }

    /// <summary>Decode JSON-encoded bytes into a generic <see cref="JsonElement" />.</summary>
    private static JsonElement DecodeJsonValue(ByteString bytes, string field)
    {
        if (bytes.IsEmpty)
        {
            using var nullDoc = JsonDocument.Parse("null");
            return nullDoc.RootElement.Clone();
        }

        try
        {
            using var doc = JsonDocument.Parse(bytes.ToStringUtf8());
            return doc.RootElement.Clone();
        }
        catch (JsonException ex)
        {
            throw new DecodeException($"invalid `{field}` JSON: {ex.Message}");
        }
    }

    /// <summary>Decode JSON-encoded bytes into a <see cref="Dictionary{TKey, TValue}"/> of object values.</summary>
    private static Dictionary<string, object?> DecodeJsonValueObject(ByteString bytes, string field)
    {
        if (bytes.IsEmpty) return new Dictionary<string, object?>();
        try
        {
            var deserialized = JsonSerializer.Deserialize<Dictionary<string, object?>>(bytes.ToStringUtf8(), SerializerOptions);
            return deserialized ?? new Dictionary<string, object?>();
        }
        catch (JsonException ex)
        {
            throw new DecodeException($"invalid `{field}` JSON: {ex.Message}");
        }
    }

    /// <summary>Decode the trigger body. JSON content-types parse as JSON; everything else surfaces as a JSON string.</summary>
    private static JsonElement DecodeRequestBody(ByteString bytes, Google.Protobuf.Collections.MapField<string, string>? headers)
    {
        if (bytes.IsEmpty)
        {
            using var nullDoc = JsonDocument.Parse("null");
            return nullDoc.RootElement.Clone();
        }

        var contentType = headers is null ? string.Empty : PickHeader(headers, "content-type");
        if (contentType.Contains("application/json", StringComparison.OrdinalIgnoreCase))
        {
            try
            {
                using var doc = JsonDocument.Parse(bytes.ToStringUtf8());
                return doc.RootElement.Clone();
            }
            catch (JsonException)
            {
                // fall through to raw-string handling
            }
        }

        var asString = bytes.ToStringUtf8();
        using var stringDoc = JsonDocument.Parse(JsonSerializer.Serialize(asString));
        return stringDoc.RootElement.Clone();
    }

    private static string PickHeader(Google.Protobuf.Collections.MapField<string, string> headers, string name)
    {
        foreach (var entry in headers)
        {
            if (string.Equals(entry.Key, name, StringComparison.OrdinalIgnoreCase))
            {
                return entry.Value;
            }
        }
        return string.Empty;
    }

    private static ByteString EncodeJsonBytes(object value)
    {
        try
        {
            return ByteString.CopyFromUtf8(JsonSerializer.Serialize(value, SerializerOptions));
        }
        catch (Exception)
        {
            return ByteString.Empty;
        }
    }
}
