package com.blok.nanoservice.middleware;

import com.blok.nanoservice.node.NodeHandler;

/**
 * Functional interface for middleware that wraps node handler execution.
 * Middleware can add cross-cutting behavior such as logging, recovery, or validation.
 * <p>
 * Example:
 * <pre>{@code
 * Middleware timing = next -> (ctx, config) -> {
 *     long start = System.nanoTime();
 *     Object result = next.execute(ctx, config);
 *     System.out.println("Took " + (System.nanoTime() - start) / 1_000_000 + "ms");
 *     return result;
 * };
 * }</pre>
 */
@FunctionalInterface
public interface Middleware {

    /**
     * Wraps the given handler with additional behavior.
     *
     * @param next the next handler in the chain
     * @return a wrapped handler
     */
    NodeHandler wrap(NodeHandler next);
}
