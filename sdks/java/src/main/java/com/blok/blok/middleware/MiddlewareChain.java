package com.blok.blok.middleware;

import com.blok.blok.node.NodeHandler;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Composes multiple middleware into a single middleware.
 * Middleware is applied in order: first middleware is outermost.
 */
public class MiddlewareChain implements Middleware {

    private final List<Middleware> middlewares;

    /**
     * Creates a chain from the given middlewares.
     *
     * @param middlewares the middlewares to chain
     */
    public MiddlewareChain(Middleware... middlewares) {
        this.middlewares = new ArrayList<>();
        if (middlewares != null) {
            this.middlewares.addAll(Arrays.asList(middlewares));
        }
    }

    /**
     * Creates a chain from a list of middlewares.
     *
     * @param middlewares the middlewares to chain
     */
    public MiddlewareChain(List<Middleware> middlewares) {
        this.middlewares = middlewares != null ? new ArrayList<>(middlewares) : new ArrayList<>();
    }

    /**
     * Adds a middleware to the end of the chain.
     *
     * @param middleware the middleware to add
     * @return this chain for fluent use
     */
    public MiddlewareChain add(Middleware middleware) {
        if (middleware != null) {
            middlewares.add(middleware);
        }
        return this;
    }

    @Override
    public NodeHandler wrap(NodeHandler handler) {
        NodeHandler current = handler;
        for (int i = middlewares.size() - 1; i >= 0; i--) {
            current = middlewares.get(i).wrap(current);
        }
        return current;
    }
}
