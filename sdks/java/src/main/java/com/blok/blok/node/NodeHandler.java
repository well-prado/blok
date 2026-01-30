package com.blok.blok.node;

import com.blok.blok.types.Context;

import java.util.Map;

/**
 * Interface that all Blok workflow nodes must implement.
 * <p>
 * Nodes receive the workflow context and node-specific configuration,
 * execute their logic, and return data or throw an exception.
 * <p>
 * Example:
 * <pre>{@code
 * public class MyNode implements NodeHandler {
 *     @Override
 *     public Object execute(Context ctx, Map<String, Object> config) throws Exception {
 *         String name = "World";
 *         Map<String, Object> body = ctx.getRequest().bodyMap();
 *         if (body != null && body.get("name") instanceof String s) {
 *             name = s;
 *         }
 *         return Map.of("message", "Hello, " + name + "!");
 *     }
 * }
 * }</pre>
 */
@FunctionalInterface
public interface NodeHandler {

    /**
     * Executes the node logic.
     *
     * @param ctx    the workflow execution context
     * @param config the node-specific configuration map
     * @return the execution result data (any serializable object)
     * @throws Exception if the execution fails
     */
    Object execute(Context ctx, Map<String, Object> config) throws Exception;
}
