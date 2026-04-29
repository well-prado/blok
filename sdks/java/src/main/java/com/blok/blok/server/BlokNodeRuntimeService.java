package com.blok.blok.server;

import com.blok.blok.errors.BlokError;
import com.blok.blok.errors.BlokErrorCategory;
import com.blok.blok.errors.BlokErrorSeverity;
import com.blok.blok.node.NodeRegistry;
import com.blok.blok.types.Context;
import com.blok.blok.types.ExecutionRequest;
import com.blok.blok.types.ExecutionResult;
import com.blok.blok.types.NodeConfig;
import com.blok.blok.types.Request;
import com.blok.blok.types.Response;
// `java_multiple_files = true` in runtime.proto puts each message and enum
// at the top level of the `com.blok.runtime.v1` package.
import com.blok.runtime.v1.ErrorCategory;
import com.blok.runtime.v1.ErrorSeverity;
import com.blok.runtime.v1.ExecuteEvent;
import com.blok.runtime.v1.ExecuteRequest;
import com.blok.runtime.v1.ExecuteResponse;
import com.blok.runtime.v1.HealthRequest;
import com.blok.runtime.v1.HealthResponse;
import com.blok.runtime.v1.ListNodesRequest;
import com.blok.runtime.v1.ListNodesResponse;
import com.blok.runtime.v1.Metrics;
import com.blok.runtime.v1.NodeDescriptor;
import com.blok.runtime.v1.NodeError;
import com.blok.runtime.v1.NodeRuntimeGrpc;
import com.blok.runtime.v1.NodeStarted;
import com.blok.runtime.v1.RuntimeState;
import com.blok.runtime.v1.TriggerInfo;
import com.blok.runtime.v1.WorkflowInfo;
import com.google.protobuf.Timestamp;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonSyntaxException;
import com.google.gson.reflect.TypeToken;
import com.google.protobuf.ByteString;
import io.grpc.Status;
import io.grpc.stub.StreamObserver;

import java.lang.reflect.Type;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/**
 * gRPC implementation of the canonical Blok {@code NodeRuntime} v1 service.
 *
 * <p>Wire contract: {@code proto/blok/runtime/v1/runtime.proto}. Generated
 * stubs are produced by {@code protobuf-maven-plugin} at build time
 * (configured in {@code pom.xml}).
 *
 * <p>Single Responsibility: translate proto messages into the SDK's internal
 * {@link ExecutionRequest} / {@link ExecutionResult} and dispatch to
 * {@link NodeRegistry}. All node-level error handling lives in
 * {@code NodeRegistry.execute(ExecutionRequest)}.
 *
 * <p>The proto sends {@code inputs}, {@code previous_output}, {@code vars},
 * and the request {@code body} as raw JSON-encoded {@code bytes}. The SDK
 * JSON-decodes them lazily here at the proto boundary so node handlers see
 * the same map shapes as the HTTP path.
 */
public final class BlokNodeRuntimeService extends NodeRuntimeGrpc.NodeRuntimeImplBase {

    private static final Gson GSON = new GsonBuilder().serializeNulls().create();
    private static final Type MAP_TYPE = new TypeToken<Map<String, Object>>() {}.getType();

    private final NodeRegistry registry;
    private final String sdkVersion;

    public BlokNodeRuntimeService(NodeRegistry registry, String sdkVersion) {
        if (registry == null) {
            throw new IllegalArgumentException("registry must not be null");
        }
        this.registry = registry;
        this.sdkVersion = sdkVersion == null || sdkVersion.isBlank() ? "1.0.0" : sdkVersion;
    }

    @Override
    public void execute(ExecuteRequest request, StreamObserver<ExecuteResponse> responseObserver) {
        ExecutionRequest executionRequest;
        try {
            executionRequest = decodeExecuteRequest(request);
        } catch (DecodeException e) {
            responseObserver.onError(Status.INVALID_ARGUMENT.withDescription(e.getMessage()).asRuntimeException());
            return;
        }

        ExecutionResult result = registry.execute(executionRequest);
        responseObserver.onNext(encodeExecuteResponse(result, executionRequest.getNode().getName()));
        responseObserver.onCompleted();
    }

    /**
     * Server-streaming variant of {@link #execute}. Emits, in order:
     * (1) one {@code NodeStarted} event marking call acceptance,
     * (2) one terminal {@code ExecuteResponse} matching the unary payload.
     *
     * <p>Log capture (LogLine events) is intentionally out of scope for the
     * Phase 5 Java pilot — {@code NodeHandler.execute} has no per-call
     * logger sink, and threading one through would change the SDK API.
     * Real-time log streaming arrives in a follow-up.
     */
    @Override
    public void executeStream(ExecuteRequest request, StreamObserver<ExecuteEvent> responseObserver) {
        ExecutionRequest executionRequest;
        try {
            executionRequest = decodeExecuteRequest(request);
        } catch (DecodeException e) {
            responseObserver.onError(Status.INVALID_ARGUMENT.withDescription(e.getMessage()).asRuntimeException());
            return;
        }

        responseObserver.onNext(ExecuteEvent.newBuilder()
                .setStarted(NodeStarted.newBuilder().setAt(currentTimestamp()).build())
                .build());

        ExecutionResult result = registry.execute(executionRequest);
        ExecuteResponse finalResponse = encodeExecuteResponse(result, executionRequest.getNode().getName());

        responseObserver.onNext(ExecuteEvent.newBuilder().setFinal(finalResponse).build());
        responseObserver.onCompleted();
    }

    private static Timestamp currentTimestamp() {
        long millis = System.currentTimeMillis();
        return Timestamp.newBuilder()
                .setSeconds(millis / 1000)
                .setNanos((int) ((millis % 1000) * 1_000_000))
                .build();
    }

    @Override
    public void health(HealthRequest request, StreamObserver<HealthResponse> responseObserver) {
        HealthResponse.Builder builder = HealthResponse.newBuilder()
                .setStatus(HealthResponse.Status.SERVING)
                .setSdkVersion(sdkVersion);
        builder.addAllRegisteredNodes(registry.nodeNames());
        responseObserver.onNext(builder.build());
        responseObserver.onCompleted();
    }

    @Override
    public void listNodes(ListNodesRequest request, StreamObserver<ListNodesResponse> responseObserver) {
        ListNodesResponse.Builder builder = ListNodesResponse.newBuilder()
                .setSdkName("blok-java")
                .setSdkVersion(sdkVersion)
                .setProtoVersion("1.0.0");
        for (String name : registry.nodeNames()) {
            builder.addNodes(NodeDescriptor.newBuilder().setName(name).build());
        }
        responseObserver.onNext(builder.build());
        responseObserver.onCompleted();
    }

    // =========================================================================
    // Codec — proto ↔ internal types
    // =========================================================================

    private static final class DecodeException extends Exception {
        DecodeException(String message) { super(message); }
    }

    private static ExecutionRequest decodeExecuteRequest(ExecuteRequest req) throws DecodeException {
        if (!req.hasNode() || req.getNode().getName().isEmpty()) {
            throw new DecodeException("ExecuteRequest.node is required");
        }

        Map<String, Object> inputs = decodeJsonObject(req.getInputs(), "inputs");

        RuntimeState state = req.getState();
        Object previousOutput = decodeJsonValue(state.getPreviousOutput(), "previous_output");
        Map<String, Object> vars = decodeJsonObject(state.getVars(), "vars");

        TriggerInfo trigger = req.getTrigger();
        Object body = decodeRequestBody(trigger.getBody(), trigger.getHeadersMap());

        WorkflowInfo workflow = req.getWorkflow();

        Context ctx = new Context();
        ctx.setId(workflow.getRunId());
        ctx.setWorkflowName(workflow.getName());
        ctx.setWorkflowPath(workflow.getPath());

        Request internalRequest = new Request();
        internalRequest.setBody(body);
        internalRequest.setHeaders(new HashMap<>(trigger.getHeadersMap()));
        internalRequest.setParams(new HashMap<>(trigger.getParamsMap()));
        internalRequest.setQuery(new HashMap<>(trigger.getQueryMap()));
        internalRequest.setCookies(new HashMap<>(trigger.getCookiesMap()));
        internalRequest.setMethod(trigger.getMethod());
        internalRequest.setUrl(trigger.getUrl());
        internalRequest.setBaseUrl(trigger.getBaseUrl());
        ctx.setRequest(internalRequest);

        Response internalResponse = new Response();
        internalResponse.setData(previousOutput);
        internalResponse.setContentType("application/json");
        internalResponse.setSuccess(true);
        ctx.setResponse(internalResponse);

        ctx.setVars(vars);
        ctx.setEnv(new HashMap<>(state.getEnvMap()));

        NodeConfig nodeConfig = new NodeConfig();
        nodeConfig.setName(req.getNode().getName());
        nodeConfig.setType(req.getNode().getType());
        nodeConfig.setConfig(inputs);

        ExecutionRequest exec = new ExecutionRequest();
        exec.setNode(nodeConfig);
        exec.setContext(ctx);
        return exec;
    }

    private ExecuteResponse encodeExecuteResponse(ExecutionResult result, String nodeName) {
        ExecuteResponse.Builder builder = ExecuteResponse.newBuilder()
                .setSuccess(result.isSuccess())
                .setContentType("application/json");

        if (result.isSuccess() && result.getData() != null) {
            builder.setData(ByteString.copyFromUtf8(GSON.toJson(result.getData())));
        }

        if (result.getVars() != null && !result.getVars().isEmpty()) {
            builder.setVarsDelta(ByteString.copyFromUtf8(GSON.toJson(result.getVars())));
        }

        if (result.getMetrics() != null) {
            Metrics.Builder metrics = Metrics.newBuilder();
            if (result.getMetrics().getDurationMs() != null) {
                metrics.setDurationMs(result.getMetrics().getDurationMs());
            }
            if (result.getMetrics().getCpuMs() != null) {
                metrics.setCpuMs(result.getMetrics().getCpuMs());
            }
            if (result.getMetrics().getMemoryBytes() != null) {
                metrics.setMemoryBytes(result.getMetrics().getMemoryBytes());
            }
            builder.setMetrics(metrics.build());
        }

        if (!result.isSuccess()) {
            builder.setError(internalErrorToProto(result.getErrors(), nodeName));
        }

        return builder.build();
    }

    /**
     * Build a proto {@link NodeError} from whatever {@link ExecutionResult}
     * carried.
     *
     * <p>Two paths, both producing the same proto shape:
     * <ul>
     *   <li><b>Structured (preferred)</b> — {@code errVal} is a typed
     *       {@link BlokError}. All 19 fields serialize losslessly via
     *       {@link #blokErrorToProto}. Auto-fills
     *       {@code node}/{@code sdk}/{@code sdk_version}/{@code runtime_kind}
     *       if the BlokError didn't set them itself.</li>
     *   <li><b>Loose</b> — {@code errVal} is anything else (Map, String,
     *       null, Throwable). Wrapped via {@link BlokError#fromUnknown}
     *       (always produces {@code category=INTERNAL} with the original
     *       payload preserved in {@code details_json}) and then serialized
     *       via the structured path.</li>
     * </ul>
     */
    private NodeError internalErrorToProto(Object errVal, String nodeName) {
        BlokError.Origin origin = BlokError.Origin.defaults(nodeName, sdkVersion);
        if (errVal instanceof BlokError be) {
            be.applyOriginIfMissing(origin);
            return blokErrorToProto(be);
        }
        return blokErrorToProto(BlokError.fromUnknown(errVal, origin));
    }

    /**
     * Serialize a fully-populated {@link BlokError} into the proto wire
     * format. The cause chain is serialized as a list of proto NodeError
     * messages; each element's own {@code causes} list is left empty (the
     * chain is already flat at the BlokError layer).
     */
    private NodeError blokErrorToProto(BlokError err) {
        NodeError.Builder b = NodeError.newBuilder()
                .setCode(err.getCode() != null ? err.getCode() : "")
                .setCategory(categoryToProto(err.getCategory()))
                .setSeverity(severityToProto(err.getSeverity()))
                .setNode(err.getNode())
                .setSdk(err.getSdk())
                .setSdkVersion(err.getSdkVersion())
                .setRuntimeKind(err.getRuntimeKind())
                .setMessage(err.getMessage() != null ? err.getMessage() : "")
                .setDescription(err.getDescription())
                .setRemediation(err.getRemediation())
                .setDocUrl(err.getDocUrl())
                .setStack(err.getStack())
                .setHttpStatus(err.getHttpStatus())
                .setRetryable(err.isRetryable())
                .setRetryAfterMs(err.getRetryAfterMs());

        long epochSec = err.getAt().getEpochSecond();
        int nanos = err.getAt().getNano();
        b.setAt(Timestamp.newBuilder().setSeconds(epochSec).setNanos(nanos).build());

        if (err.getDetails() != null) {
            b.setDetailsJson(ByteString.copyFromUtf8(GSON.toJson(err.getDetails())));
        }
        if (err.getContextSnapshot() != null) {
            b.setContextSnapshotJson(ByteString.copyFromUtf8(GSON.toJson(err.getContextSnapshot())));
        }

        for (Map<String, Object> cause : err.getCauses()) {
            b.addCauses(causeMapToProto(cause));
        }
        return b.build();
    }

    /**
     * Convert one cause-chain link (already a snake_case map) into a proto
     * NodeError. Each link's own {@code causes} list is left empty; the chain
     * is already flat at the BlokError layer.
     */
    private NodeError causeMapToProto(Map<String, Object> cause) {
        BlokErrorCategory category = BlokErrorCategory.parse(stringField(cause, "category"));
        BlokErrorSeverity severity = BlokErrorSeverity.parse(stringField(cause, "severity"));
        NodeError.Builder b = NodeError.newBuilder()
                .setCode(stringField(cause, "code"))
                .setCategory(categoryToProto(category))
                .setSeverity(severityToProto(severity))
                .setNode(stringField(cause, "node"))
                .setSdk(stringField(cause, "sdk"))
                .setSdkVersion(stringField(cause, "sdk_version"))
                .setRuntimeKind(stringField(cause, "runtime_kind"))
                .setMessage(stringField(cause, "message"))
                .setDescription(stringField(cause, "description"))
                .setRemediation(stringField(cause, "remediation"))
                .setDocUrl(stringField(cause, "doc_url"))
                .setStack(stringField(cause, "stack"))
                .setHttpStatus(intField(cause, "http_status", 500))
                .setRetryable(boolField(cause, "retryable", false))
                .setRetryAfterMs(longField(cause, "retry_after_ms", 0L));

        Object atRaw = cause.get("at");
        if (atRaw instanceof String at) {
            try {
                java.time.Instant instant = java.time.Instant.parse(at);
                b.setAt(Timestamp.newBuilder()
                        .setSeconds(instant.getEpochSecond())
                        .setNanos(instant.getNano())
                        .build());
            } catch (Exception ignored) {
                // best effort
            }
        }

        Object det = cause.get("details");
        if (det != null) {
            b.setDetailsJson(ByteString.copyFromUtf8(GSON.toJson(det)));
        }
        Object snap = cause.get("context_snapshot");
        if (snap != null) {
            b.setContextSnapshotJson(ByteString.copyFromUtf8(GSON.toJson(snap)));
        }
        return b.build();
    }

    private static ErrorCategory categoryToProto(BlokErrorCategory c) {
        return switch (c) {
            case VALIDATION -> ErrorCategory.VALIDATION;
            case CONFIGURATION -> ErrorCategory.CONFIGURATION;
            case DEPENDENCY -> ErrorCategory.DEPENDENCY;
            case TIMEOUT -> ErrorCategory.TIMEOUT;
            case PERMISSION -> ErrorCategory.PERMISSION;
            case RATE_LIMIT -> ErrorCategory.RATE_LIMIT;
            case NOT_FOUND -> ErrorCategory.NOT_FOUND;
            case CONFLICT -> ErrorCategory.CONFLICT;
            case CANCELLED -> ErrorCategory.CANCELLED;
            case PROTOCOL -> ErrorCategory.PROTOCOL;
            case DATA -> ErrorCategory.DATA;
            case INTERNAL -> ErrorCategory.INTERNAL;
        };
    }

    private static ErrorSeverity severityToProto(BlokErrorSeverity s) {
        return switch (s) {
            case INFO -> ErrorSeverity.INFO;
            case WARN -> ErrorSeverity.WARN;
            case FATAL -> ErrorSeverity.FATAL;
            case ERROR -> ErrorSeverity.ERROR;
        };
    }

    private static String stringField(Map<String, Object> m, String key) {
        Object v = m.get(key);
        return v instanceof String s ? s : "";
    }

    private static int intField(Map<String, Object> m, String key, int fallback) {
        Object v = m.get(key);
        if (v instanceof Number n) return n.intValue();
        return fallback;
    }

    private static long longField(Map<String, Object> m, String key, long fallback) {
        Object v = m.get(key);
        if (v instanceof Number n) return n.longValue();
        return fallback;
    }

    private static boolean boolField(Map<String, Object> m, String key, boolean fallback) {
        Object v = m.get(key);
        if (v instanceof Boolean b) return b;
        return fallback;
    }

    /** Decode JSON-encoded bytes into a typed map. Empty bytes → empty map. */
    private static Map<String, Object> decodeJsonObject(ByteString bytes, String field) throws DecodeException {
        if (bytes.isEmpty()) return new HashMap<>();
        String json = bytes.toStringUtf8();
        try {
            JsonElement element = JsonParser.parseString(json);
            if (element.isJsonObject()) {
                Map<String, Object> map = GSON.fromJson(element, MAP_TYPE);
                return map != null ? map : new HashMap<>();
            }
            // Wrap non-object payloads under a reserved key so handlers
            // expecting a map don't crash.
            Map<String, Object> wrapped = new HashMap<>();
            wrapped.put("_value", GSON.fromJson(element, Object.class));
            return wrapped;
        } catch (JsonSyntaxException ex) {
            throw new DecodeException("invalid `" + field + "` JSON: " + ex.getMessage());
        }
    }

    /** Decode JSON-encoded bytes into an arbitrary value. Empty bytes → null. */
    private static Object decodeJsonValue(ByteString bytes, String field) throws DecodeException {
        if (bytes.isEmpty()) return null;
        try {
            return GSON.fromJson(bytes.toStringUtf8(), Object.class);
        } catch (JsonSyntaxException ex) {
            throw new DecodeException("invalid `" + field + "` JSON: " + ex.getMessage());
        }
    }

    /**
     * Decode the trigger body. JSON content-types parse as JSON; everything
     * else surfaces as a raw string for the node to interpret.
     */
    private static Object decodeRequestBody(ByteString bytes, Map<String, String> headers) {
        if (bytes.isEmpty()) return null;
        String contentType = pickHeader(headers, "content-type");
        if (contentType.toLowerCase().contains("application/json")) {
            try {
                return GSON.fromJson(bytes.toStringUtf8(), Object.class);
            } catch (JsonSyntaxException ignored) {
                // fall through
            }
        }
        return new String(bytes.toByteArray(), StandardCharsets.UTF_8);
    }

    private static String pickHeader(Map<String, String> headers, String name) {
        if (headers == null) return "";
        for (Map.Entry<String, String> entry : headers.entrySet()) {
            if (entry.getKey().equalsIgnoreCase(name)) return entry.getValue();
        }
        return "";
    }
}
