package com.blok.blok.server;

import com.blok.blok.node.NodeRegistry;
import io.grpc.Server;
import io.grpc.ServerBuilder;

import java.io.IOException;
import java.util.concurrent.TimeUnit;

/**
 * gRPC server bootstrap for the Blok Java SDK.
 *
 * <p>Binds {@link BlokNodeRuntimeService} on the configured port and runs
 * until shutdown. Provides {@link #start()}, {@link #blockUntilShutdown()},
 * and {@link #stop()} so callers can choose between blocking and
 * non-blocking lifecycles (the latter enables the dual-listen mode where
 * the same process serves HTTP and gRPC concurrently).
 *
 * <p>Single Responsibility: own the gRPC {@link Server} lifecycle. Codec
 * and dispatch logic live in {@link BlokNodeRuntimeService}.
 */
public final class BlokGrpcServer {

    /** 16 MiB max send/receive — matches the runner-side default and the
     *  PHP buffer ceiling from BLOK_FRAMEWORK_FIXES.md #5. */
    private static final int MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

    private final NodeRegistry registry;
    private final int port;
    private final String sdkVersion;
    private Server server;

    public BlokGrpcServer(NodeRegistry registry, int port, String sdkVersion) {
        if (registry == null) {
            throw new IllegalArgumentException("registry must not be null");
        }
        if (port <= 0) {
            throw new IllegalArgumentException("port must be > 0");
        }
        this.registry = registry;
        this.port = port;
        this.sdkVersion = sdkVersion == null || sdkVersion.isBlank() ? "1.0.0" : sdkVersion;
    }

    /** Bind the gRPC server and start serving. Non-blocking. */
    public void start() throws IOException {
        if (server != null && !server.isShutdown()) {
            throw new IllegalStateException("gRPC server already started");
        }
        server = ServerBuilder.forPort(port)
                .addService(new BlokNodeRuntimeService(registry, sdkVersion))
                .maxInboundMessageSize(MAX_MESSAGE_BYTES)
                .build()
                .start();
        System.out.println(
                "Blok gRPC server (NodeRuntime v1) listening on port " + port +
                " with " + registry.nodeNames().size() + " nodes registered");
    }

    /** Block the calling thread until the server terminates. */
    public void blockUntilShutdown() throws InterruptedException {
        if (server != null) {
            server.awaitTermination();
        }
    }

    /** Initiate graceful shutdown with a 5s grace period. */
    public void stop() {
        if (server == null) return;
        try {
            server.shutdown().awaitTermination(5, TimeUnit.SECONDS);
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
        }
    }

    /** True after {@link #start()} returns and before {@link #stop()} completes. */
    public boolean isRunning() {
        return server != null && !server.isShutdown() && !server.isTerminated();
    }
}
