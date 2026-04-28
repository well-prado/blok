package com.blok.blok.server;

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
import com.blok.runtime.v1.RuntimeState;
import com.blok.runtime.v1.TriggerInfo;
import com.blok.runtime.v1.WorkflowInfo;
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

    @Override
    public void executeStream(ExecuteRequest request, StreamObserver<ExecuteEvent> responseObserver) {
        // Phase 5 capability — opt out by setting `stream_logs=false`.
        responseObserver.onError(Status.UNIMPLEMENTED
                .withDescription("ExecuteStream is not implemented yet — opt out via stream_logs=false")
                .asRuntimeException());
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

    private NodeError internalErrorToProto(Object errVal, String nodeName) {
        String message = "node error";
        ByteString detailsJson = ByteString.EMPTY;

        if (errVal == null) {
            // keep defaults
        } else if (errVal instanceof String s) {
            message = s;
            Map<String, Object> wrap = new HashMap<>();
            wrap.put("message", s);
            detailsJson = ByteString.copyFromUtf8(GSON.toJson(wrap));
        } else if (errVal instanceof Map<?, ?> map) {
            Object msg = map.get("message");
            if (msg instanceof String ms && !ms.isEmpty()) {
                message = ms;
            }
            detailsJson = ByteString.copyFromUtf8(GSON.toJson(map));
        } else {
            message = errVal.toString();
            Map<String, Object> wrap = new HashMap<>();
            wrap.put("message", message);
            detailsJson = ByteString.copyFromUtf8(GSON.toJson(wrap));
        }

        return NodeError.newBuilder()
                .setCode("JAVA_NODE_ERROR")
                .setCategory(ErrorCategory.INTERNAL)
                .setSeverity(ErrorSeverity.ERROR)
                .setNode(nodeName)
                .setSdk("blok-java")
                .setSdkVersion(sdkVersion)
                .setRuntimeKind("runtime.java")
                .setMessage(message)
                .setHttpStatus(500)
                .setRetryable(false)
                .setDetailsJson(detailsJson)
                .build();
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
