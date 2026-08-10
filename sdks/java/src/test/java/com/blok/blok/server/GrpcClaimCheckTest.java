package com.blok.blok.server;

import com.blok.blok.node.NodeRegistry;
import com.blok.runtime.v1.ExecuteRequest;
import com.blok.runtime.v1.ExecuteResponse;
import com.blok.runtime.v1.ListNodesRequest;
import com.blok.runtime.v1.ListNodesResponse;
import com.blok.runtime.v1.NodeRef;
import com.blok.runtime.v1.NodeRuntimeGrpc;
import com.google.gson.Gson;
import com.google.gson.reflect.TypeToken;
import com.google.protobuf.ByteString;
import io.grpc.ManagedChannel;
import io.grpc.ManagedChannelBuilder;
import io.grpc.StatusRuntimeException;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.lang.reflect.Type;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * ADR 0014 — claim-check ($blokBlob) resolution, exercised through a REAL
 * gRPC client (issue #749).
 *
 * <p>{@link BlobClaimCheckTest} covers the trust-boundary logic by calling
 * {@code BlokNodeRuntimeService.resolveInputBlob} directly — real unit
 * coverage, but it never proves the claim-check leg works when a node is
 * actually run through {@code Execute} over the wire, the way python3, ruby
 * and go's gRPC test suites do for the rest of the service. This class dials
 * a real {@link BlokGrpcServer} the same way those SDKs' test clients do.
 *
 * <p>{@code BLOK_BLOB_DIR} is set once for the whole test JVM via
 * {@code maven-surefire-plugin}'s {@code environmentVariables} (pom.xml) —
 * Java has no per-test env-var scoping like Go's {@code t.Setenv}. Every
 * other suite in this module reads the {@code root} parameter explicitly
 * instead of the environment, so that fixed value doesn't affect them.
 */
class GrpcClaimCheckTest {

    private static final Gson GSON = new Gson();
    private static final Type MAP_TYPE = new TypeToken<Map<String, Object>>() {}.getType();

    private static BlokGrpcServer server;
    private static ManagedChannel channel;
    private static NodeRuntimeGrpc.NodeRuntimeBlockingStub client;
    private static String blobDir;

    @BeforeAll
    static void startServerAndClient() throws IOException {
        blobDir = System.getenv("BLOK_BLOB_DIR");
        assertTrue(blobDir != null && !blobDir.isBlank(),
                "BLOK_BLOB_DIR must be set by the surefire plugin config in pom.xml");
        Files.createDirectories(Path.of(blobDir));

        NodeRegistry registry = new NodeRegistry();
        // Echoes back the resolved node config (not the trigger body), so a
        // successful response proves the $blokBlob sentinel was substituted
        // for the real payload before the node ever saw it.
        registry.register("echo-config", (ctx, config) -> config);

        int port = 19180 + (int) (Math.random() * 1000);
        server = new BlokGrpcServer(registry, port, "1.0.0-test");
        server.start();

        channel = ManagedChannelBuilder.forAddress("127.0.0.1", port).usePlaintext().build();
        client = NodeRuntimeGrpc.newBlockingStub(channel);
    }

    @AfterAll
    static void stopServerAndClient() {
        if (channel != null) channel.shutdownNow();
        if (server != null) server.stop();
    }

    private static Map<String, Object> writeBlob(String runId, Map<String, Object> payload) throws IOException {
        Path runDir = Path.of(blobDir, runId);
        Files.createDirectories(runDir);
        String json = GSON.toJson(payload);
        Files.writeString(runDir.resolve("blob.json"), json);
        Map<String, Object> ref = new HashMap<>();
        ref.put("id", runId + "/blob.json");
        ref.put("bytes", (double) json.length());
        ref.put("codec", "json");
        Map<String, Object> sentinel = new HashMap<>();
        sentinel.put("$blokBlob", ref);
        return sentinel;
    }

    private static ExecuteRequest requestFor(String nodeName, Map<String, Object> inputs) {
        return ExecuteRequest.newBuilder()
                .setNode(NodeRef.newBuilder().setName(nodeName).setType("runtime.java").build())
                .setInputs(ByteString.copyFromUtf8(GSON.toJson(inputs)))
                .build();
    }

    @Test
    void executeResolvesClaimCheckBlobThroughRealClient() throws IOException {
        Map<String, Object> payload = Map.of("big", "x".repeat(4096));
        Map<String, Object> sentinel = writeBlob("run_1", payload);

        ExecuteResponse resp = client.execute(requestFor("echo-config", sentinel));

        assertTrue(resp.getSuccess(), "expected success, got error: " + resp.getError());
        Map<String, Object> data = GSON.fromJson(resp.getData().toStringUtf8(), MAP_TYPE);
        assertEquals(payload.get("big"), data.get("big"));
    }

    @Test
    void listNodesAdvertisesBlobCapabilityThroughRealClient() {
        ListNodesResponse resp = client.listNodes(ListNodesRequest.newBuilder().build());
        assertTrue(resp.getCapabilitiesList().contains("blob-v1"),
                "expected blob-v1 in " + resp.getCapabilitiesList());
    }

    @Test
    void executeRefusesAnEscapingBlobIdThroughRealClient() {
        Map<String, Object> ref = new HashMap<>();
        ref.put("id", "../../etc/passwd");
        ref.put("bytes", 1);
        ref.put("codec", "json");
        Map<String, Object> sentinel = new HashMap<>();
        sentinel.put("$blokBlob", ref);

        StatusRuntimeException ex = assertThrows(StatusRuntimeException.class,
                () -> client.execute(requestFor("echo-config", sentinel)));
        assertEquals(io.grpc.Status.Code.INVALID_ARGUMENT, ex.getStatus().getCode());
        assertTrue(ex.getStatus().getDescription().contains("invalid $blokBlob id"), ex.getStatus().getDescription());
    }
}
