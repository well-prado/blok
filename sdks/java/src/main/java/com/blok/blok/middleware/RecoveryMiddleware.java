package com.blok.blok.middleware;

import com.blok.blok.errors.BlokError;
import com.blok.blok.errors.ErrorCategory;
import com.blok.blok.errors.NodeException;
import com.blok.blok.node.NodeHandler;

import java.io.PrintWriter;
import java.io.StringWriter;
import java.util.HashMap;
import java.util.Map;

/**
 * Middleware that catches all exceptions during node execution
 * and converts them to structured NodeExceptions.
 * <p>
 * Structured exceptions ({@link BlokError}, {@link NodeException}) are
 * re-thrown as-is so the registry / gRPC servicer can serialize them
 * losslessly. All other exceptions are wrapped in an EXECUTION
 * NodeException with the stack trace captured in the details.
 */
public class RecoveryMiddleware implements Middleware {

    @Override
    public NodeHandler wrap(NodeHandler next) {
        return (ctx, config) -> {
            try {
                return next.execute(ctx, config);
            } catch (BlokError e) {
                // Master plan §17 BlokError passes through verbatim — the
                // registry catches it directly and stashes the typed instance
                // on `ExecutionResult.errors` for the gRPC servicer.
                throw e;
            } catch (NodeException e) {
                // Legacy structured exceptions pass through as-is too.
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
