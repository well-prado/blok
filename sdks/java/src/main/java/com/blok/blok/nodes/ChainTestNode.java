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

        // Read existing chain — gRPC inputs first (carried on
        // `node.config`), HTTP body fallback (legacy wire shape where
        // the runner mapped resolvedInputs → request.body). Dual-read
        // keeps the cross-runtime-chain demo working over both
        // transports during the §11 deprecation window.
        List<Object> chain = new ArrayList<>();
        if (config != null && config.get("chain") instanceof List) {
            chain = new ArrayList<>((List<Object>) config.get("chain"));
        } else if (body != null && body.get("chain") instanceof List) {
            chain = new ArrayList<>((List<Object>) body.get("chain"));
        }

        // Read origin — same dual-read.
        String origin = "unknown";
        if (config != null && config.get("origin") instanceof String s && !s.isEmpty()) {
            origin = s;
        } else if (body != null && body.get("origin") instanceof String s && !s.isEmpty()) {
            origin = s;
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
