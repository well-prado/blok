package com.blok.server;

import com.blok.runtime.Blok;
import com.blok.runtime.NodeRegistry;
import com.blok.nodes.HelloWorldNode;
import com.google.gson.Gson;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.Scanner;

/**
 * RuntimeServer is the HTTP server for the Blok Java runtime
 */
public class RuntimeServer {
    private static final String VERSION = "1.0.0";
    private static final Gson gson = new Gson();
    private static final NodeRegistry registry = new NodeRegistry();

    public static void main(String[] args) throws IOException {
        // Register nodes
        registry.register("hello-world", new HelloWorldNode());
        // Add more nodes here as needed
        // registry.register("another-node", new AnotherNode());

        // Get port from environment or use default
        String portStr = System.getenv("PORT");
        int port = portStr != null ? Integer.parseInt(portStr) : 8080;

        // Create HTTP server
        HttpServer server = HttpServer.create(new InetSocketAddress(port), 0);

        // Register handlers
        server.createContext("/execute", new ExecuteHandler());
        server.createContext("/health", new HealthHandler());

        // Start server
        server.setExecutor(null); // Use default executor
        server.start();

        System.out.println("Blok Java Runtime v" + VERSION + " starting on port " + port);
        System.out.println("Registered nodes: " + registry.size());
    }

    /**
     * ExecuteHandler handles node execution requests
     */
    static class ExecuteHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            if (!"POST".equals(exchange.getRequestMethod())) {
                sendResponse(exchange, 405, "{\"error\":\"Method not allowed\"}");
                return;
            }

            try {
                // Parse request body
                String requestBody = readRequestBody(exchange);
                Blok.ExecutionRequest request = gson.fromJson(requestBody, Blok.ExecutionRequest.class);

                // Execute node
                Blok.ExecutionResult result = registry.execute(request);

                // Send response
                String responseJson = gson.toJson(result);
                sendResponse(exchange, 200, responseJson);

            } catch (Exception e) {
                String errorJson = gson.toJson(new Blok.ExecutionResult(
                    false,
                    null,
                    java.util.Map.of("message", e.getMessage())
                ));
                sendResponse(exchange, 400, errorJson);
            }
        }
    }

    /**
     * HealthHandler handles health check requests
     */
    static class HealthHandler implements HttpHandler {
        @Override
        public void handle(HttpExchange exchange) throws IOException {
            if (!"GET".equals(exchange.getRequestMethod())) {
                sendResponse(exchange, 405, "{\"error\":\"Method not allowed\"}");
                return;
            }

            Blok.HealthStatus health = registry.getHealth(VERSION);
            String responseJson = gson.toJson(health);
            sendResponse(exchange, 200, responseJson);
        }
    }

    /**
     * Read the request body as a string
     */
    private static String readRequestBody(HttpExchange exchange) {
        Scanner scanner = new Scanner(exchange.getRequestBody(), StandardCharsets.UTF_8);
        return scanner.useDelimiter("\\A").next();
    }

    /**
     * Send an HTTP response
     */
    private static void sendResponse(HttpExchange exchange, int statusCode, String response) throws IOException {
        byte[] bytes = response.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.sendResponseHeaders(statusCode, bytes.length);

        try (OutputStream os = exchange.getResponseBody()) {
            os.write(bytes);
        }
    }
}
