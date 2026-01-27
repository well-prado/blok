package com.blok.runtime;

import java.util.HashMap;
import java.util.Map;
import java.util.Set;

/**
 * NodeRegistry manages registered node handlers
 */
public class NodeRegistry {
    private final Map<String, Blok.NodeHandler> nodes = new HashMap<>();

    /**
     * Register a node handler with the given name
     */
    public void register(String name, Blok.NodeHandler handler) {
        nodes.put(name, handler);
    }

    /**
     * Get a node handler by name
     */
    public Blok.NodeHandler get(String name) throws Exception {
        if (!nodes.containsKey(name)) {
            throw new Exception("Node '" + name + "' not found");
        }
        return nodes.get(name);
    }

    /**
     * Execute a node by name
     */
    public Blok.ExecutionResult execute(Blok.ExecutionRequest request) {
        try {
            Blok.NodeHandler handler = get(request.node.name);
            Object data = handler.execute(request.context, request.node.config);

            return new Blok.ExecutionResult(true, data, null);
        } catch (Exception e) {
            Map<String, String> error = new HashMap<>();
            error.put("message", e.getMessage());
            error.put("type", e.getClass().getSimpleName());

            return new Blok.ExecutionResult(false, null, error);
        }
    }

    /**
     * Get health status
     */
    public Blok.HealthStatus getHealth(String version) {
        Set<String> nodeNames = nodes.keySet();
        String[] nodesArray = nodeNames.toArray(new String[0]);
        return new Blok.HealthStatus(version, nodesArray);
    }

    /**
     * Get the number of registered nodes
     */
    public int size() {
        return nodes.size();
    }
}
