package com.blok.blok.server;

import com.blok.blok.node.NodeRegistry;
import io.grpc.Server;
import io.grpc.ServerBuilder;
import io.grpc.netty.shaded.io.grpc.netty.NettyServerBuilder;

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

    /** Bind the gRPC server and start serving. Non-blocking.
     *
     * <p>Uses {@link NettyServerBuilder} (not the generic
     * {@link ServerBuilder}) so we can lower {@code permitKeepAliveTime}
     * to match the runner-side keepalive cadence. Java gRPC's default
     * {@code permitKeepAliveTime} is 5 minutes, which causes Java
     * servers to send {@code GOAWAY ENHANCE_YOUR_CALM} when the runner
     * pings every 10s (the master plan §9 keepalive). The runner then
     * surfaces a scary-looking
     * {@code TypeError: null is not an object (evaluating 'self.emit')}
     * inside Node's http2 GOAWAY handler. Setting the permit window to
     * 5s + permit-without-calls=true keeps the connection happy and
     * silences that whole class of log noise.
     */
    public void start() throws IOException {
        if (server != null && !server.isShutdown()) {
            throw new IllegalStateException("gRPC server already started");
        }
        server = NettyServerBuilder.forPort(port)
                .addService(new BlokNodeRuntimeService(registry, sdkVersion))
                .maxInboundMessageSize(MAX_MESSAGE_BYTES)
                // Accept the runner's master plan §9 keepalive cadence
                // (10s ping interval, 5s timeout). Without this, the
                // Java server's default 5-minute permitKeepAliveTime
                // rejects every ping after the first as "excess pings"
                // and sends GOAWAY, which trips a separate Node http2
                // bug on the client. See doc comment above.
                .permitKeepAliveTime(5, TimeUnit.SECONDS)
                .permitKeepAliveWithoutCalls(true)
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
