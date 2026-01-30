package com.blok.blok.nodes;

import com.blok.blok.node.NodeHandler;
import com.blok.blok.types.Context;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * ChainTestNode is used in cross-runtime integration tests.
 * It reads a chain array from the request body, appends its own entry,
 * and returns the updated chain — proving data flows between languages.
 */
public class ChainTestNode implements NodeHandler {

    @Override
    @SuppressWarnings("unchecked")
    public Object execute(Context ctx, Map<String, Object> config) throws Exception {
        Map<String, Object> body = null;
        if (ctx.getRequest() != null && ctx.getRequest().getBody() instanceof Map) {
            body = (Map<String, Object>) ctx.getRequest().getBody();
        }

        // Read existing chain (default to empty list)
        List<Object> chain = new ArrayList<>();
        if (body != null && body.get("chain") instanceof List) {
            chain = new ArrayList<>((List<Object>) body.get("chain"));
        }

        // Read origin
        String origin = "unknown";
        if (body != null && body.get("origin") instanceof String) {
            origin = (String) body.get("origin");
        }

        // Append this language's entry
        Map<String, Object> entry = new HashMap<>();
        entry.put("language", "java");
        entry.put("order", chain.size() + 1);
        entry.put("timestamp", Instant.now().toString());
        chain.add(entry);

        // Store in context vars
        if (ctx.getVars() != null) {
            ctx.getVars().put("chain", chain);
        }

        // Return updated chain
        Map<String, Object> result = new HashMap<>();
        result.put("chain", chain);
        result.put("origin", origin);
        return result;
    }
}
