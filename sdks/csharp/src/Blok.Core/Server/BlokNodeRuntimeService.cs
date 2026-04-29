using System.Text.Json;
using Blok.Core.Errors;
using Blok.Core.Node;
using Blok.Core.Types;
using Blok.Runtime.V1;
using Google.Protobuf;
using Google.Protobuf.WellKnownTypes;
using Grpc.Core;

// `Blok.Core.Errors.ErrorCategory` (the legacy 5-value enum) and
// `Blok.Runtime.V1.ErrorCategory` (the proto's 12-value enum) collide. Alias
// the proto enums so the switch expressions in this file are unambiguous.
using ProtoErrorCategory = Blok.Runtime.V1.ErrorCategory;
using ProtoErrorSeverity = Blok.Runtime.V1.ErrorSeverity;

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

        long responseBytes = 0;

        if (result.Success && result.Data is not null)
        {
            response.Data = ByteString.CopyFromUtf8(JsonSerializer.Serialize(result.Data, SerializerOptions));
            responseBytes += response.Data.Length;
        }

        if (result.Vars is { Count: > 0 })
        {
            response.VarsDelta = ByteString.CopyFromUtf8(JsonSerializer.Serialize(result.Vars, SerializerOptions));
            responseBytes += response.VarsDelta.Length;
        }

        // Phase 0 follow-up: populate response_bytes so Studio's run-detail
        // Inspector shows the gRPC wire size next to the runner-measured
        // request_bytes. Approximated via JSON-payload length (data +
        // vars_delta) — same approximation as the runner's request_bytes,
        // so the two sides of "1.1 KB → 84 B" are comparable.
        if (result.Metrics is not null || responseBytes > 0)
        {
            response.Metrics = new Metrics
            {
                DurationMs = result.Metrics?.DurationMs ?? 0.0,
                CpuMs = result.Metrics?.CpuMs ?? 0.0,
                MemoryBytes = result.Metrics?.MemoryBytes ?? 0L,
                ResponseBytes = responseBytes,
            };
        }

        if (!result.Success)
        {
            response.Error = InternalErrorToProto(result.Errors, nodeName, sdkVersion);
        }

        return response;
    }

    /// <summary>
    /// Build a proto <see cref="NodeError"/> from whatever
    /// <see cref="ExecutionResult"/> carried.
    ///
    /// <para>Two paths, both producing the same proto shape:</para>
    /// <list type="bullet">
    ///   <item><b>Structured (preferred)</b> — <c>errVal</c> is a typed
    ///     <see cref="BlokError"/>. All 19 fields serialize losslessly via
    ///     <c>BlokErrorToProto</c>. Auto-fills
    ///     <c>node</c>/<c>sdk</c>/<c>sdk_version</c>/<c>runtime_kind</c> if
    ///     the BlokError didn't set them itself.</item>
    ///   <item><b>Loose</b> — <c>errVal</c> is anything else. Wrapped via
    ///     <see cref="BlokError.FromUnknown"/> and serialized through the
    ///     same path.</item>
    /// </list>
    /// </summary>
    private static NodeError InternalErrorToProto(object? errVal, string nodeName, string sdkVersion)
    {
        var origin = BlokErrorOrigin.Defaults(nodeName, sdkVersion);
        if (errVal is BlokError be)
        {
            be.ApplyOriginIfMissing(origin);
            return BlokErrorToProto(be);
        }
        return BlokErrorToProto(BlokError.FromUnknown(errVal, origin));
    }

    /// <summary>
    /// Serialize a fully-populated <see cref="BlokError"/> into the proto
    /// wire format. The cause chain is serialized as a list of proto
    /// NodeError messages; each element's own <c>causes</c> list is left
    /// empty (the chain is already flat at the BlokError layer).
    /// </summary>
    private static NodeError BlokErrorToProto(BlokError err)
    {
        var nodeError = new NodeError
        {
            Code = err.Code,
            Category = CategoryToProto(err.Category),
            Severity = SeverityToProto(err.Severity),
            Node = err.Node,
            Sdk = err.Sdk,
            SdkVersion = err.SdkVersion,
            RuntimeKind = err.RuntimeKind,
            Message = err.Message ?? string.Empty,
            Description = err.Description,
            Remediation = err.Remediation,
            DocUrl = err.DocUrl,
            Stack = err.Stack,
            HttpStatus = err.HttpStatus,
            Retryable = err.Retryable,
            RetryAfterMs = err.RetryAfterMs,
            At = Timestamp.FromDateTime(DateTime.SpecifyKind(err.At, DateTimeKind.Utc)),
        };

        if (err.Details is not null)
        {
            nodeError.DetailsJson = EncodeJsonBytes(err.Details);
        }
        if (err.ContextSnapshot is not null)
        {
            nodeError.ContextSnapshotJson = EncodeJsonBytes(err.ContextSnapshot);
        }

        foreach (var cause in err.Causes)
        {
            nodeError.Causes.Add(CauseMapToProto(cause));
        }

        return nodeError;
    }

    /// <summary>
    /// Convert one cause-chain link (already a snake_case map) into a proto
    /// <see cref="NodeError"/>. Each link's own <c>causes</c> list is left
    /// empty; the chain is already flat at the BlokError layer.
    /// </summary>
    private static NodeError CauseMapToProto(IDictionary<string, object?> cause)
    {
        var category = BlokErrorCategoryExtensions.Parse(StringField(cause, "category"));
        var severity = BlokErrorSeverityExtensions.Parse(StringField(cause, "severity"));
        var nodeError = new NodeError
        {
            Code = StringField(cause, "code"),
            Category = CategoryToProto(category),
            Severity = SeverityToProto(severity),
            Node = StringField(cause, "node"),
            Sdk = StringField(cause, "sdk"),
            SdkVersion = StringField(cause, "sdk_version"),
            RuntimeKind = StringField(cause, "runtime_kind"),
            Message = StringField(cause, "message"),
            Description = StringField(cause, "description"),
            Remediation = StringField(cause, "remediation"),
            DocUrl = StringField(cause, "doc_url"),
            Stack = StringField(cause, "stack"),
            HttpStatus = IntField(cause, "http_status", 500),
            Retryable = BoolField(cause, "retryable", false),
            RetryAfterMs = LongField(cause, "retry_after_ms", 0),
        };

        if (cause.TryGetValue("at", out var atRaw) && atRaw is string atStr
            && DateTime.TryParse(atStr, null, System.Globalization.DateTimeStyles.RoundtripKind, out var parsedAt))
        {
            nodeError.At = Timestamp.FromDateTime(DateTime.SpecifyKind(parsedAt, DateTimeKind.Utc));
        }

        if (cause.TryGetValue("details", out var details) && details is not null)
        {
            nodeError.DetailsJson = EncodeJsonBytes(details);
        }
        if (cause.TryGetValue("context_snapshot", out var snapshot) && snapshot is not null)
        {
            nodeError.ContextSnapshotJson = EncodeJsonBytes(snapshot);
        }
        return nodeError;
    }

    private static ProtoErrorCategory CategoryToProto(BlokErrorCategory c) => c switch
    {
        BlokErrorCategory.Validation => ProtoErrorCategory.Validation,
        BlokErrorCategory.Configuration => ProtoErrorCategory.Configuration,
        BlokErrorCategory.Dependency => ProtoErrorCategory.Dependency,
        BlokErrorCategory.Timeout => ProtoErrorCategory.Timeout,
        BlokErrorCategory.Permission => ProtoErrorCategory.Permission,
        BlokErrorCategory.RateLimit => ProtoErrorCategory.RateLimit,
        BlokErrorCategory.NotFound => ProtoErrorCategory.NotFound,
        BlokErrorCategory.Conflict => ProtoErrorCategory.Conflict,
        BlokErrorCategory.Cancelled => ProtoErrorCategory.Cancelled,
        BlokErrorCategory.Protocol => ProtoErrorCategory.Protocol,
        BlokErrorCategory.Data => ProtoErrorCategory.Data,
        _ => ProtoErrorCategory.Internal,
    };

    private static ProtoErrorSeverity SeverityToProto(BlokErrorSeverity s) => s switch
    {
        BlokErrorSeverity.Info => ProtoErrorSeverity.Info,
        BlokErrorSeverity.Warn => ProtoErrorSeverity.Warn,
        BlokErrorSeverity.Fatal => ProtoErrorSeverity.Fatal,
        _ => ProtoErrorSeverity.Error,
    };

    private static string StringField(IDictionary<string, object?> m, string key)
        => m.TryGetValue(key, out var v) && v is string s ? s : string.Empty;

    private static int IntField(IDictionary<string, object?> m, string key, int fallback)
    {
        if (!m.TryGetValue(key, out var v) || v is null) return fallback;
        return v switch
        {
            int i => i,
            long l => (int)l,
            double d => (int)d,
            _ => fallback,
        };
    }

    private static long LongField(IDictionary<string, object?> m, string key, long fallback)
    {
        if (!m.TryGetValue(key, out var v) || v is null) return fallback;
        return v switch
        {
            int i => i,
            long l => l,
            double d => (long)d,
            _ => fallback,
        };
    }

    private static bool BoolField(IDictionary<string, object?> m, string key, bool fallback)
        => m.TryGetValue(key, out var v) && v is bool b ? b : fallback;

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
