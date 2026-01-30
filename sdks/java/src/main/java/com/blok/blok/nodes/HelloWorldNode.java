package com.blok.blok.nodes;

import com.blok.blok.node.NodeHandler;
import com.blok.blok.types.Context;

import java.time.Instant;
import java.util.HashMap;
import java.util.Map;

/**
 * Simple example node that greets the user.
 * <p>
 * Input (request body):
 * <ul>
 *   <li>name (string, optional) - Name to greet (default: "World")</li>
 * </ul>
 * Config:
 * <ul>
 *   <li>prefix (string, optional) - Greeting prefix (default: "Hello")</li>
 * </ul>
 * Output:
 * <ul>
 *   <li>message (string) - The greeting message</li>
 *   <li>timestamp (string) - ISO 8601 timestamp</li>
 *   <li>language (string) - "java"</li>
 * </ul>
 */
public class HelloWorldNode implements NodeHandler {

    @Override
    public Object execute(Context ctx, Map<String, Object> config) {
        // Get name from request body, default to "World"
        String name = "World";
        Map<String, Object> body = ctx.getRequest().bodyMap();
        if (body != null) {
            Object nameVal = body.get("name");
            if (nameVal instanceof String s && !s.isEmpty()) {
                name = s;
            }
        }

        // Get prefix from config, default to "Hello"
        String prefix = "Hello";
        if (config != null) {
            Object prefixVal = config.get("prefix");
            if (prefixVal instanceof String s && !s.isEmpty()) {
                prefix = s;
            }
        }

        String message = prefix + ", " + name + "!";

        // Store greeting in context vars for downstream nodes
        ctx.setVar("greeting", message);

        Map<String, Object> result = new HashMap<>();
        result.put("message", message);
        result.put("timestamp", Instant.now().toString());
        result.put("language", "java");
        return result;
    }
}
