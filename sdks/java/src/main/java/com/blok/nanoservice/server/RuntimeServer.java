package com.blok.nanoservice.server;

import com.blok.nanoservice.config.ServerConfig;
import com.blok.nanoservice.node.NodeRegistry;
import com.blok.nanoservice.types.ExecutionRequest;
import com.blok.nanoservice.types.ExecutionResult;
import com.blok.nanoservice.types.HealthStatus;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonSyntaxException;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.Executors;

/**
 * HTTP server for the Blok nanoservice runtime.
 * Uses the JDK built-in {@code com.sun.net.httpserver.HttpServer}.
 * <p>
 * Exposes two endpoints:
 * <ul>
 *   <li>POST /execute - Execute a workflow node</li>
 *   <li>GET /health - Health check</li>
 * </ul>
 */
public class RuntimeServer {

    private final NodeRegistry registry;
    private final ServerConfig config;
    private final Gson gson;
    private HttpServer httpServer;

    /**
     * Creates a new RuntimeServer.
     *
     * @param registry the node registry
     * @param config   the server configuration
     * @throws IllegalArgumentException if registry or config is null
     */
    public RuntimeServer(NodeRegistry registry, ServerConfig config) {
        if (registry == null) {
            throw new IllegalArgumentException("registry must not be null");
        }
        if (config == null) {
            throw new IllegalArgumentException("config must not be null");
        }
        this.registry = registry;
        this.config = config;
        this.gson = new GsonBuilder()
                .serializeNulls()
                .create();
    }

    /**
     * Starts the HTTP server. Blocks until the server is stopped.
     *
     * @throws IOException if the server cannot bind to the port
     */
    public void start() throws IOException {
        InetSocketAddress address = new InetSocketAddress(config.getHost(), config.getPort());
        httpServer = HttpServer.create(address, 0);
        httpServer.setExecutor(Executors.newCachedThreadPool());

        httpServer.createContext("/execute", this::handleExecute);
        httpServer.createContext("/health", this::handleHealth);

        httpServer.start();

        System.out.println("Nanoservice runtime v" + config.getVersion()
                + " starting on " + config.address());
        System.out.println("Registered nodes: " + registry.nodeNames());
    }

    /**
     * Stops the HTTP server gracefully.
     */
    public void stop() {
        if (httpServer != null) {
            System.out.println("Shutting down nanoservice runtime...");
            httpServer.stop(config.getShutdownTimeoutSec());
        }
    }

    /**
     * Returns the underlying HttpServer for testing or advanced use.
     *
     * @return the HttpServer, or null if not started
     */
    public HttpServer getHttpServer() {
        return httpServer;
    }

    private void handleExecute(HttpExchange exchange) throws IOException {
        // CORS preflight
        if (config.isEnableCors()) {
            setCorsHeaders(exchange);
            if ("OPTIONS".equalsIgnoreCase(exchange.getRequestMethod())) {
                exchange.sendResponseHeaders(204, -1);
                exchange.close();
                return;
            }
        }

        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            ExecutionResult error = ExecutionResult.error("method not allowed, use POST");
            writeJson(exchange, 405, error);
            return;
        }

        try {
            InputStreamReader reader = new InputStreamReader(
                    exchange.getRequestBody(), StandardCharsets.UTF_8);
            ExecutionRequest request = gson.fromJson(reader, ExecutionRequest.class);

            if (request == null) {
                writeJson(exchange, 400, ExecutionResult.error("invalid JSON: empty body"));
                return;
            }

            ExecutionResult result = registry.execute(request);
            writeJson(exchange, 200, result);

        } catch (JsonSyntaxException e) {
            ExecutionResult error = ExecutionResult.error("invalid JSON: " + e.getMessage());
            writeJson(exchange, 400, error);
        } catch (Exception e) {
            ExecutionResult error = ExecutionResult.error("internal server error: " + e.getMessage());
            writeJson(exchange, 200, error);
        }
    }

    private void handleHealth(HttpExchange exchange) throws IOException {
        if (config.isEnableCors()) {
            setCorsHeaders(exchange);
            if ("OPTIONS".equalsIgnoreCase(exchange.getRequestMethod())) {
                exchange.sendResponseHeaders(204, -1);
                exchange.close();
                return;
            }
        }

        if (!"GET".equalsIgnoreCase(exchange.getRequestMethod())) {
            exchange.sendResponseHeaders(405, -1);
            exchange.close();
            return;
        }

        HealthStatus health = registry.health(config.getVersion());
        writeJson(exchange, 200, health);
    }

    private void writeJson(HttpExchange exchange, int statusCode, Object data) throws IOException {
        // Build JSON with null exclusion for optional fields
        Gson responseGson = new GsonBuilder().create();
        String json = responseGson.toJson(data);
        byte[] bytes = json.getBytes(StandardCharsets.UTF_8);

        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.sendResponseHeaders(statusCode, bytes.length);

        try (OutputStream os = exchange.getResponseBody()) {
            os.write(bytes);
        }
    }

    private void setCorsHeaders(HttpExchange exchange) {
        exchange.getResponseHeaders().set("Access-Control-Allow-Origin", "*");
        exchange.getResponseHeaders().set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        exchange.getResponseHeaders().set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    }
}
