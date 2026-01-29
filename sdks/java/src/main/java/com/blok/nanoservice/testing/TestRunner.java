package com.blok.nanoservice.testing;

import com.blok.nanoservice.node.NodeHandler;
import com.blok.nanoservice.node.NodeRegistry;
import com.blok.nanoservice.types.*;

import java.util.Map;

/**
 * Test runner for executing nodes in-process without starting an HTTP server.
 * <p>
 * Example:
 * <pre>{@code
 * TestRunner runner = new TestRunner();
 * runner.register("hello", new HelloWorldNode());
 *
 * Context ctx = new MockContext().withBody(Map.of("name", "World")).build();
 * ExecutionResult result = runner.execute("hello", ctx, Map.of("prefix", "Hi"));
 *
 * assert result.isSuccess();
 * }</pre>
 */
public class TestRunner {

    private final NodeRegistry registry;

    public TestRunner() {
        this.registry = new NodeRegistry();
    }

    /**
     * Registers a node handler for testing.
     *
     * @param name    the node name
     * @param handler the node handler
     * @return this runner for fluent use
     */
    public TestRunner register(String name, NodeHandler handler) {
        registry.register(name, handler);
        return this;
    }

    /**
     * Executes a node by name with the given context and config.
     *
     * @param name   the node name
     * @param ctx    the execution context
     * @param config the node config map
     * @return the execution result
     */
    public ExecutionResult execute(String name, Context ctx, Map<String, Object> config) {
        NodeConfig nodeConfig = new NodeConfig();
        nodeConfig.setName(name);
        nodeConfig.setConfig(config);

        ExecutionRequest request = new ExecutionRequest(nodeConfig, ctx);
        return registry.execute(request);
    }
}
