package com.blok.nanoservice.node;

import com.blok.nanoservice.errors.NodeException;
import com.blok.nanoservice.types.*;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Tests for NodeRegistry.
 */
class NodeRegistryTest {

    private NodeRegistry registry;

    @BeforeEach
    void setUp() {
        registry = new NodeRegistry();
    }

    @Test
    void registerAndGetNode() {
        NodeHandler handler = (ctx, config) -> "result";
        registry.register("test-node", handler);

        NodeHandler retrieved = registry.get("test-node");
        assertNotNull(retrieved);
        assertSame(handler, retrieved);
    }

    @Test
    void getReturnsNullForUnregistered() {
        assertNull(registry.get("nonexistent"));
    }

    @Test
    void getReturnsNullForNullName() {
        assertNull(registry.get(null));
    }

    @Test
    void registerThrowsForNullName() {
        assertThrows(IllegalArgumentException.class,
                () -> registry.register(null, (ctx, config) -> null));
    }

    @Test
    void registerThrowsForBlankName() {
        assertThrows(IllegalArgumentException.class,
                () -> registry.register("  ", (ctx, config) -> null));
    }

    @Test
    void registerThrowsForNullHandler() {
        assertThrows(IllegalArgumentException.class,
                () -> registry.register("test", null));
    }

    @Test
    void nodeNamesReturnsRegisteredNames() {
        registry.register("node-a", (ctx, config) -> null);
        registry.register("node-b", (ctx, config) -> null);

        var names = registry.nodeNames();
        assertEquals(2, names.size());
        assertTrue(names.contains("node-a"));
        assertTrue(names.contains("node-b"));
    }

    @Test
    void executeSuccessful() {
        registry.register("echo", (ctx, config) -> {
            Map<String, Object> data = new HashMap<>();
            data.put("echo", "hello");
            return data;
        });

        NodeConfig nodeConfig = new NodeConfig();
        nodeConfig.setName("echo");
        Context ctx = new Context();
        ExecutionRequest request = new ExecutionRequest(nodeConfig, ctx);

        ExecutionResult result = registry.execute(request);

        assertTrue(result.isSuccess());
        assertNotNull(result.getData());
        assertNotNull(result.getMetrics());
        assertNotNull(result.getMetrics().getDurationMs());
        assertTrue(result.getMetrics().getDurationMs() >= 0);
    }

    @Test
    void executeNotFoundNode() {
        NodeConfig nodeConfig = new NodeConfig();
        nodeConfig.setName("nonexistent");
        Context ctx = new Context();
        ExecutionRequest request = new ExecutionRequest(nodeConfig, ctx);

        ExecutionResult result = registry.execute(request);

        assertFalse(result.isSuccess());
        assertNotNull(result.getErrors());
    }

    @Test
    void executeHandlesNodeException() {
        registry.register("fail", (ctx, config) -> {
            throw NodeException.validation("bad input");
        });

        NodeConfig nodeConfig = new NodeConfig();
        nodeConfig.setName("fail");
        Context ctx = new Context();
        ExecutionRequest request = new ExecutionRequest(nodeConfig, ctx);

        ExecutionResult result = registry.execute(request);

        assertFalse(result.isSuccess());
        assertNotNull(result.getErrors());
        assertNotNull(result.getMetrics());

        @SuppressWarnings("unchecked")
        Map<String, Object> errors = (Map<String, Object>) result.getErrors();
        assertEquals("bad input", errors.get("message"));
        assertEquals("VALIDATION", errors.get("category"));
    }

    @Test
    void executeHandlesGenericException() {
        registry.register("crash", (ctx, config) -> {
            throw new RuntimeException("unexpected");
        });

        NodeConfig nodeConfig = new NodeConfig();
        nodeConfig.setName("crash");
        Context ctx = new Context();
        ExecutionRequest request = new ExecutionRequest(nodeConfig, ctx);

        ExecutionResult result = registry.execute(request);

        assertFalse(result.isSuccess());
        assertNotNull(result.getErrors());
    }

    @Test
    void executeWithNullRequest() {
        ExecutionResult result = registry.execute(null);
        assertFalse(result.isSuccess());
    }

    @Test
    void executeWithMissingNodeConfig() {
        ExecutionRequest request = new ExecutionRequest(null, new Context());
        ExecutionResult result = registry.execute(request);
        assertFalse(result.isSuccess());
    }

    @Test
    void executeCapturesMetrics() {
        registry.register("slow", (ctx, config) -> {
            Thread.sleep(10);
            return "done";
        });

        NodeConfig nodeConfig = new NodeConfig();
        nodeConfig.setName("slow");
        Context ctx = new Context();
        ExecutionRequest request = new ExecutionRequest(nodeConfig, ctx);

        ExecutionResult result = registry.execute(request);

        assertTrue(result.isSuccess());
        assertNotNull(result.getMetrics());
        assertTrue(result.getMetrics().getDurationMs() >= 5.0,
                "Duration should be at least 5ms, was: " + result.getMetrics().getDurationMs());
    }

    @Test
    void healthReturnsCorrectStatus() {
        registry.register("node-a", (ctx, config) -> null);
        registry.register("node-b", (ctx, config) -> null);

        HealthStatus health = registry.health("2.0.0");

        assertEquals("healthy", health.getStatus());
        assertEquals("2.0.0", health.getVersion());
        assertNotNull(health.getNodesLoaded());
        assertEquals(2, health.getNodesLoaded().size());
        assertTrue(health.getNodesLoaded().contains("node-a"));
        assertTrue(health.getNodesLoaded().contains("node-b"));
    }

    @Test
    void healthWithNoNodes() {
        HealthStatus health = registry.health("1.0.0");

        assertEquals("healthy", health.getStatus());
        assertEquals("1.0.0", health.getVersion());
        assertNotNull(health.getNodesLoaded());
        assertTrue(health.getNodesLoaded().isEmpty());
    }

    @Test
    void executePassesConfigToHandler() {
        registry.register("config-test", (ctx, config) -> {
            return config.get("key");
        });

        NodeConfig nodeConfig = new NodeConfig();
        nodeConfig.setName("config-test");
        Map<String, Object> config = new HashMap<>();
        config.put("key", "expected-value");
        nodeConfig.setConfig(config);

        Context ctx = new Context();
        ExecutionRequest request = new ExecutionRequest(nodeConfig, ctx);

        ExecutionResult result = registry.execute(request);

        assertTrue(result.isSuccess());
        assertEquals("expected-value", result.getData());
    }
}
