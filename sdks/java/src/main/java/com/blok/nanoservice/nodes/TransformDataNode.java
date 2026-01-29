package com.blok.nanoservice.nodes;

import com.blok.nanoservice.errors.NodeException;
import com.blok.nanoservice.node.NodeHandler;
import com.blok.nanoservice.types.Context;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Transforms JSON data based on field mappings.
 * <p>
 * Config:
 * <ul>
 *   <li>mappings (map, optional) - Field mapping from source to target.
 *       Keys are target field names, values are source field paths (dot-notation).</li>
 *   <li>include_only (list, optional) - If set, only include these fields from output.</li>
 *   <li>exclude (list, optional) - Fields to exclude from output.</li>
 *   <li>defaults (map, optional) - Default values for missing fields.</li>
 * </ul>
 * Input (request body): The input data object to transform.
 * Output: The transformed data object.
 */
public class TransformDataNode implements NodeHandler {

    @Override
    @SuppressWarnings("unchecked")
    public Object execute(Context ctx, Map<String, Object> config) throws Exception {
        Map<String, Object> body = ctx.getRequest().bodyMap();
        if (body == null) {
            throw NodeException.validation("request body must be a JSON object");
        }

        Map<String, Object> result = new HashMap<>();

        // Apply field mappings if configured
        Object mappingsVal = config != null ? config.get("mappings") : null;
        if (mappingsVal instanceof Map<?, ?> mappings) {
            for (Map.Entry<?, ?> entry : mappings.entrySet()) {
                String targetField = String.valueOf(entry.getKey());
                if (entry.getValue() instanceof String sourcePath) {
                    Object value = getNestedValue(body, sourcePath);
                    if (value != null) {
                        result.put(targetField, value);
                    }
                }
            }
        } else {
            // No mappings -- copy all fields
            result.putAll(body);
        }

        // Apply include_only filter
        Object includeOnlyVal = config != null ? config.get("include_only") : null;
        if (includeOnlyVal instanceof List<?> includeOnly && !includeOnly.isEmpty()) {
            Map<String, Object> filtered = new HashMap<>();
            for (Object field : includeOnly) {
                String fieldName = String.valueOf(field);
                if (result.containsKey(fieldName)) {
                    filtered.put(fieldName, result.get(fieldName));
                }
            }
            result = filtered;
        }

        // Apply exclude filter
        Object excludeVal = config != null ? config.get("exclude") : null;
        if (excludeVal instanceof List<?> exclude) {
            for (Object field : exclude) {
                result.remove(String.valueOf(field));
            }
        }

        // Apply defaults for missing fields
        Object defaultsVal = config != null ? config.get("defaults") : null;
        if (defaultsVal instanceof Map<?, ?> defaults) {
            for (Map.Entry<?, ?> entry : defaults.entrySet()) {
                String key = String.valueOf(entry.getKey());
                if (!result.containsKey(key)) {
                    result.put(key, entry.getValue());
                }
            }
        }

        // Store transformed data in vars
        ctx.setVar("transformed_data", result);

        return result;
    }

    /**
     * Retrieves a value from a nested map using dot-notation path.
     *
     * @param data the source map
     * @param path dot-separated field path
     * @return the value at the path, or null if not found
     */
    @SuppressWarnings("unchecked")
    private static Object getNestedValue(Map<String, Object> data, String path) {
        if (data == null || path == null || path.isEmpty()) {
            return null;
        }

        String[] parts = path.split("\\.");
        Object current = data;

        for (String part : parts) {
            if (current instanceof Map<?, ?> map) {
                current = map.get(part);
                if (current == null) {
                    return null;
                }
            } else {
                return null;
            }
        }

        return current;
    }
}
