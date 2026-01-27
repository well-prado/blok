package com.blok.nodes;

import com.blok.runtime.Blok;

import java.time.Instant;
import java.util.HashMap;
import java.util.Map;

/**
 * HelloWorldNode is an example Blok node in Java
 */
public class HelloWorldNode implements Blok.NodeHandler {

    @Override
    public Object execute(Blok.Context context, Map<String, Object> config) throws Exception {
        // Get name from request body or use default
        String name = "World";

        if (context.request.body != null && context.request.body instanceof Map) {
            @SuppressWarnings("unchecked")
            Map<String, Object> bodyMap = (Map<String, Object>) context.request.body;
            if (bodyMap.containsKey("name")) {
                name = (String) bodyMap.get("name");
            }
        }

        // Get greeting prefix from config or use default
        String prefix = "Hello";
        if (config != null && config.containsKey("prefix")) {
            prefix = (String) config.get("prefix");
        }

        String message = prefix + ", " + name + "!";

        // Store in context vars for downstream nodes
        context.vars.put("greeting", message);
        context.vars.put("timestamp", Instant.now().getEpochSecond());

        // Return response
        Map<String, Object> response = new HashMap<>();
        response.put("message", message);
        response.put("timestamp", Instant.now().toString());
        response.put("language", "Java");

        return response;
    }
}
