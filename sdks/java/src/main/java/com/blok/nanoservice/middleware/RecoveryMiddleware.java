package com.blok.nanoservice.middleware;

import com.blok.nanoservice.errors.ErrorCategory;
import com.blok.nanoservice.errors.NodeException;
import com.blok.nanoservice.node.NodeHandler;

import java.io.PrintWriter;
import java.io.StringWriter;
import java.util.HashMap;
import java.util.Map;

/**
 * Middleware that catches all exceptions during node execution
 * and converts them to structured NodeExceptions.
 * <p>
 * NodeExceptions are re-thrown as-is. All other exceptions
 * (including RuntimeExceptions) are wrapped in an EXECUTION NodeException
 * with the stack trace captured in the details.
 */
public class RecoveryMiddleware implements Middleware {

    @Override
    public NodeHandler wrap(NodeHandler next) {
        return (ctx, config) -> {
            try {
                return next.execute(ctx, config);
            } catch (NodeException e) {
                // Structured exceptions pass through as-is
                throw e;
            } catch (Exception e) {
                // Capture stack trace
                StringWriter sw = new StringWriter();
                e.printStackTrace(new PrintWriter(sw));

                Map<String, Object> details = new HashMap<>();
                details.put("stack", sw.toString());

                String message = e.getMessage() != null
                        ? "recovered: " + e.getMessage()
                        : "recovered: " + e.getClass().getSimpleName();

                throw new NodeException(message, 500, ErrorCategory.EXECUTION, details, e);
            }
        };
    }
}
