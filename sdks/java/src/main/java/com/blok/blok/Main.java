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
import com.blok.blok.server.RuntimeServer;

/**
 * Entry point for the Blok blok Java runtime.
 * <p>
 * Registers all built-in example nodes, configures middleware,
 * and starts the HTTP server.
 */
public class Main {

    public static void main(String[] args) {
        // Load configuration from environment
        ServerConfig config = ServerConfig.fromEnv();

        // Create registry and register nodes
        NodeRegistry registry = new NodeRegistry();
        registry.register("hello-world", new HelloWorldNode());
        registry.register("api-call", new ApiCallNode());
        registry.register("transform-data", new TransformDataNode());
        registry.register("chain-test", new ChainTestNode());

        // Add middleware
        Logger logger = new Logger(config.getLogLevel());
        registry.use(new RecoveryMiddleware());
        registry.use(new LoggingMiddleware(logger));

        // Create and start server
        RuntimeServer server = new RuntimeServer(registry, config);

        // Set up graceful shutdown
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            server.stop();
            System.out.println("Blok runtime stopped.");
        }));

        try {
            server.start();
        } catch (Exception e) {
            System.err.println("Failed to start server: " + e.getMessage());
            System.exit(1);
        }
    }
}
