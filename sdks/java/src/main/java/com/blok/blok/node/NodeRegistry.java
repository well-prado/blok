package com.blok.blok.node;

import com.blok.blok.errors.NodeException;
import com.blok.blok.middleware.Middleware;
import com.blok.blok.types.*;

import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Manages registered node handlers and executes them.
 * Thread-safe: uses ConcurrentHashMap for node storage.
 */
public class NodeRegistry {

    private final ConcurrentHashMap<String, NodeHandler> nodes = new ConcurrentHashMap<>();
    private final List<Middleware> middlewares = Collections.synchronizedList(new ArrayList<>());

    /**
     * Registers a node handler with the given name.
     *
     * @param name    the node name
     * @param handler the node handler implementation
     * @throws IllegalArgumentException if name or handler is null
     */
    public void register(String name, NodeHandler handler) {
        if (name == null || name.isBlank()) {
            throw new IllegalArgumentException("node name must not be null or blank");
        }
        if (handler == null) {
            throw new IllegalArgumentException("handler must not be null");
        }
        nodes.put(name, handler);
    }

    /**
     * Adds middleware to be applied to all node executions.
     *
     * @param middleware the middleware to add
     */
    public void use(Middleware middleware) {
        if (middleware == null) {
            throw new IllegalArgumentException("middleware must not be null");
        }
        middlewares.add(middleware);
    }

    /**
     * Retrieves a node handler by name.
     *
     * @param name the node name
     * @return the handler, or null if not found
     */
    public NodeHandler get(String name) {
        if (name == null) {
            return null;
        }
        return nodes.get(name);
    }

    /**
     * Returns the names of all registered nodes.
     *
     * @return a list of node names
     */
    public List<String> nodeNames() {
        return new ArrayList<>(nodes.keySet());
    }

    /**
     * Executes a node by processing an ExecutionRequest.
     * Applies all registered middleware and captures timing/memory metrics.
     *
     * @param request the execution request
     * @return the execution result (never null)
     */
    public ExecutionResult execute(ExecutionRequest request) {
        if (request == null) {
            return ExecutionResult.error("execution request must not be null");
        }

        long startNanos = System.nanoTime();
        Runtime runtime = Runtime.getRuntime();
        long memBefore = runtime.totalMemory() - runtime.freeMemory();

        // Look up handler
        NodeConfig nodeConfig = request.getNode();
        if (nodeConfig == null || nodeConfig.getName() == null) {
            return ExecutionResult.error("node configuration is missing");
        }

        String nodeName = nodeConfig.getName();
        NodeHandler handler = get(nodeName);
        if (handler == null) {
            return ExecutionResult.error("node '" + nodeName + "' not found");
        }

        // Apply middleware chain (outermost first)
        NodeHandler wrapped = handler;
        List<Middleware> mws;
        synchronized (middlewares) {
            mws = new ArrayList<>(middlewares);
        }
        for (int i = mws.size() - 1; i >= 0; i--) {
            wrapped = mws.get(i).wrap(wrapped);
        }

        // Execute
        Context ctx = request.getContext();
        if (ctx == null) {
            ctx = new Context();
        }
        Map<String, Object> config = (nodeConfig.getConfig() != null)
                ? nodeConfig.getConfig()
                : new HashMap<>();

        try {
            Object data = wrapped.execute(ctx, config);

            // Calculate metrics
            long durationNanos = System.nanoTime() - startNanos;
            double durationMs = durationNanos / 1_000_000.0;
            long memAfter = runtime.totalMemory() - runtime.freeMemory();
            long memUsed = Math.max(0, memAfter - memBefore);

            ExecutionMetrics metrics = new ExecutionMetrics(durationMs, null, memUsed);
            ExecutionResult result = ExecutionResult.success(data).withMetrics(metrics);

            // Include context vars so the runner can propagate them downstream
            if (ctx.getVars() != null && !ctx.getVars().isEmpty()) {
                result.setVars(ctx.getVars());
            }

            return result;

        } catch (NodeException e) {
            long durationNanos = System.nanoTime() - startNanos;
            double durationMs = durationNanos / 1_000_000.0;
            long memAfter = runtime.totalMemory() - runtime.freeMemory();
            long memUsed = Math.max(0, memAfter - memBefore);

            ExecutionMetrics metrics = new ExecutionMetrics(durationMs, null, memUsed);

            Map<String, Object> errorMap = new HashMap<>();
            errorMap.put("message", e.getMessage());
            errorMap.put("code", e.getCode());
            errorMap.put("category", e.getCategory().name());
            if (e.getDetails() != null && !e.getDetails().isEmpty()) {
                errorMap.put("details", e.getDetails());
            }

            ExecutionResult result = new ExecutionResult();
            result.setSuccess(false);
            result.setErrors(errorMap);
            result.setMetrics(metrics);
            return result;

        } catch (Exception e) {
            long durationNanos = System.nanoTime() - startNanos;
            double durationMs = durationNanos / 1_000_000.0;
            long memAfter = runtime.totalMemory() - runtime.freeMemory();
            long memUsed = Math.max(0, memAfter - memBefore);

            ExecutionMetrics metrics = new ExecutionMetrics(durationMs, null, memUsed);

            Map<String, String> errorMap = new HashMap<>();
            errorMap.put("message", e.getMessage() != null ? e.getMessage() : "unknown error");

            ExecutionResult result = new ExecutionResult();
            result.setSuccess(false);
            result.setErrors(errorMap);
            result.setMetrics(metrics);
            return result;
        }
    }

    /**
     * Returns the health status of the registry.
     *
     * @param version the runtime version string
     * @return health status
     */
    public HealthStatus health(String version) {
        return new HealthStatus("healthy", version, nodeNames());
    }
}
