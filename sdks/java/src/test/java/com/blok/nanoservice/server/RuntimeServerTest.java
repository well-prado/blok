package com.blok.nanoservice.server;

import com.blok.nanoservice.config.ServerConfig;
import com.blok.nanoservice.node.NodeRegistry;
import com.blok.nanoservice.types.HealthStatus;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.reflect.TypeToken;
import org.junit.jupiter.api.*;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.HashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Tests for RuntimeServer using an actual HTTP connection.
 */
class RuntimeServerTest {

    private static RuntimeServer server;
    private static HttpClient client;
    private static int port;
    private static final Gson GSON = new GsonBuilder().create();

    @BeforeAll
    static void startServer() throws IOException, InterruptedException {
        NodeRegistry registry = new NodeRegistry();
        registry.register("echo", (ctx, config) -> {
            Map<String, Object> result = new HashMap<>();
            result.put("echo", ctx.getRequest().bodyMap());
            return result;
        });

        // Find an available port
        port = 18080 + (int) (Math.random() * 1000);
        ServerConfig config = new ServerConfig();
        config.setPort(port);
        config.setHost("127.0.0.1");
        config.setVersion("test-1.0.0");

        server = new RuntimeServer(registry, config);
        server.start();

        client = HttpClient.newHttpClient();

        // Wait for server to be ready
        Thread.sleep(200);
    }

    @AfterAll
    static void stopServer() {
        if (server != null) {
            server.stop();
        }
    }

    @Test
    void executeEndpointSuccess() throws Exception {
        String body = """
                {
                    "node": {"name": "echo", "config": {}},
                    "context": {
                        "id": "test-1",
                        "workflow_name": "test",
                        "workflow_path": "/test",
                        "request": {
                            "body": {"message": "hello"},
                            "method": "POST",
                            "url": "/test",
                            "headers": {},
                            "params": {},
                            "query": {},
                            "cookies": {},
                            "baseUrl": "http://localhost"
                        },
                        "response": {"success": true},
                        "vars": {},
                        "env": {}
                    }
                }
                """;

        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port + "/execute"))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body))
                .build();

        HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());

        assertEquals(200, response.statusCode());
        assertTrue(response.headers().firstValue("Content-Type")
                .orElse("").contains("application/json"));

        Map<String, Object> result = GSON.fromJson(response.body(),
                new TypeToken<Map<String, Object>>() {}.getType());
        assertTrue((Boolean) result.get("success"));
        assertNotNull(result.get("data"));
    }

    @Test
    void executeEndpointInvalidJson() throws Exception {
        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port + "/execute"))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString("{invalid json!!!"))
                .build();

        HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());

        assertEquals(400, response.statusCode());

        Map<String, Object> result = GSON.fromJson(response.body(),
                new TypeToken<Map<String, Object>>() {}.getType());
        assertFalse((Boolean) result.get("success"));
    }

    @Test
    void executeEndpointWrongMethod() throws Exception {
        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port + "/execute"))
                .GET()
                .build();

        HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());

        assertEquals(405, response.statusCode());
    }

    @Test
    void healthEndpointSuccess() throws Exception {
        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port + "/health"))
                .GET()
                .build();

        HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());

        assertEquals(200, response.statusCode());
        assertTrue(response.headers().firstValue("Content-Type")
                .orElse("").contains("application/json"));

        HealthStatus health = GSON.fromJson(response.body(), HealthStatus.class);
        assertEquals("healthy", health.getStatus());
        assertEquals("test-1.0.0", health.getVersion());
        assertNotNull(health.getNodesLoaded());
        assertTrue(health.getNodesLoaded().contains("echo"));
    }

    @Test
    void healthEndpointWrongMethod() throws Exception {
        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port + "/health"))
                .POST(HttpRequest.BodyPublishers.ofString("{}"))
                .build();

        HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());

        assertEquals(405, response.statusCode());
    }

    @Test
    void executeNodeNotFound() throws Exception {
        String body = """
                {
                    "node": {"name": "nonexistent", "config": {}},
                    "context": {
                        "id": "test-1",
                        "request": {"body": {}, "method": "POST", "url": "/test", "headers": {}, "params": {}, "query": {}, "cookies": {}, "baseUrl": ""},
                        "response": {},
                        "vars": {},
                        "env": {}
                    }
                }
                """;

        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port + "/execute"))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body))
                .build();

        HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());

        assertEquals(200, response.statusCode());

        Map<String, Object> result = GSON.fromJson(response.body(),
                new TypeToken<Map<String, Object>>() {}.getType());
        assertFalse((Boolean) result.get("success"));
    }
}
