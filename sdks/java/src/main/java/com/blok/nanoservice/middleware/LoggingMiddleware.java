package com.blok.nanoservice.middleware;

import com.blok.nanoservice.logging.Logger;
import com.blok.nanoservice.node.NodeHandler;

import java.util.HashMap;
import java.util.Map;

/**
 * Middleware that logs node execution start and end with timing information.
 */
public class LoggingMiddleware implements Middleware {

    private final Logger logger;

    /**
     * Creates a LoggingMiddleware with the given logger.
     *
     * @param logger the logger to write to
     * @throws IllegalArgumentException if logger is null
     */
    public LoggingMiddleware(Logger logger) {
        if (logger == null) {
            throw new IllegalArgumentException("logger must not be null");
        }
        this.logger = logger;
    }

    @Override
    public NodeHandler wrap(NodeHandler next) {
        return (ctx, config) -> {
            long start = System.nanoTime();

            Map<String, Object> startFields = new HashMap<>();
            startFields.put("workflow", ctx.getWorkflowName());
            logger.info("node execution started", startFields);

            try {
                Object result = next.execute(ctx, config);

                long durationNanos = System.nanoTime() - start;
                double durationMs = durationNanos / 1_000_000.0;

                Map<String, Object> endFields = new HashMap<>();
                endFields.put("workflow", ctx.getWorkflowName());
                endFields.put("duration_ms", durationMs);
                logger.info("node execution completed", endFields);

                return result;

            } catch (Exception e) {
                long durationNanos = System.nanoTime() - start;
                double durationMs = durationNanos / 1_000_000.0;

                Map<String, Object> errorFields = new HashMap<>();
                errorFields.put("workflow", ctx.getWorkflowName());
                errorFields.put("duration_ms", durationMs);
                errorFields.put("error", e.getMessage());
                logger.error("node execution failed", errorFields);

                throw e;
            }
        };
    }
}
