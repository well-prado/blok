package com.blok.blok;

import com.blok.blok.config.ServerConfig;
import com.blok.blok.logging.Logger;
import com.blok.blok.middleware.LoggingMiddleware;
import com.blok.blok.middleware.RecoveryMiddleware;
import com.blok.blok.node.NodeRegistry;
import com.blok.blok.nodes.ApiCallNode;
import com.blok.blok.nodes.ChainTestNode;
import com.blok.blok.nodes.HelloWorldNode;
import com.blok.blok.nodes.TransformDataNode;
import com.blok.blok.server.BlokGrpcServer;
import com.blok.blok.server.RuntimeServer;

/**
 * Entry point for the Blok blok Java runtime.
 * <p>
 * Registers all built-in example nodes, configures middleware, and starts
 * the configured server(s). The {@code BLOK_TRANSPORT} environment variable
 * selects between HTTP-only ({@code "http"}, default), gRPC-only
 * ({@code "grpc"}), or both transports concurrently ({@code "both"}).
 */
public class Main {

    public static void main(String[] args) {
        ServerConfig config = ServerConfig.fromEnv();

        NodeRegistry registry = new NodeRegistry();
        registry.register("hello-world", new HelloWorldNode());
        registry.register("api-call", new ApiCallNode());
        registry.register("transform-data", new TransformDataNode());
        registry.register("chain-test", new ChainTestNode());

        Logger logger = new Logger(config.getLogLevel());
        registry.use(new RecoveryMiddleware());
        registry.use(new LoggingMiddleware(logger));

        try {
            switch (config.getTransport()) {
                case HTTP -> runHttp(registry, config);
                case GRPC -> runGrpc(registry, config);
                case BOTH -> runBoth(registry, config);
            }
        } catch (Exception e) {
            System.err.println("Failed to start server: " + e.getMessage());
            System.exit(1);
        }
    }

    private static void runHttp(NodeRegistry registry, ServerConfig config) throws Exception {
        RuntimeServer server = new RuntimeServer(registry, config);
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            server.stop();
            System.out.println("Blok HTTP server stopped.");
        }));
        server.start();
    }

    private static void runGrpc(NodeRegistry registry, ServerConfig config) throws Exception {
        BlokGrpcServer grpc = new BlokGrpcServer(registry, config.getGrpcPort(), config.getVersion());
        grpc.start();
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            grpc.stop();
            System.out.println("Blok gRPC server stopped.");
        }));
        grpc.blockUntilShutdown();
    }

    private static void runBoth(NodeRegistry registry, ServerConfig config) throws Exception {
        BlokGrpcServer grpc = new BlokGrpcServer(registry, config.getGrpcPort(), config.getVersion());
        grpc.start();

        RuntimeServer http = new RuntimeServer(registry, config);

        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            grpc.stop();
            http.stop();
            System.out.println("Blok runtime servers stopped.");
        }));

        http.start();
    }
}
