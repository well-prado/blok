package com.blok.blok.errors;

import com.google.gson.Gson;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * Bounded slice of inputs + recent vars for the
 * {@code BlokError.contextSnapshot} field, per master plan §17.6.
 *
 * <p>Default budget: 4 KB serialized + last-16 vars keys, with progressive
 * trimming when oversize. {@code inputs} is preserved as-is — it's the most
 * LLM-actionable context. Mirrors Python's {@code build_context_snapshot},
 * Go's {@code BuildContextSnapshot}, and Rust's
 * {@code build_context_snapshot}.
 */
public final class BuildContextSnapshot {

    private static final Gson GSON = new Gson();

    private BuildContextSnapshot() {
        // static helpers only
    }

    /** Snapshot of {@code inputs} + last-16 vars keys, capped at 4 KB. */
    public static Map<String, Object> of(Map<String, Object> inputs, Map<String, Object> vars) {
        return of(inputs, vars, BlokError.CONTEXT_SNAPSHOT_MAX_BYTES, 16);
    }

    /**
     * Customizable variant of {@link #of(Map, Map)}.
     *
     * <p>{@code maxVarsKeys = 0} drops vars entirely.
     * {@code maxBytes <= 0} disables byte-budget trimming.
     */
    public static Map<String, Object> of(
            Map<String, Object> inputs,
            Map<String, Object> vars,
            int maxBytes,
            int maxVarsKeys
    ) {
        Map<String, Object> safeInputs = jsonSafeMap(inputs);

        // Use TreeMap to give a deterministic "last N" slice (Java HashMap
        // iteration order isn't guaranteed). LLM/Studio consumers don't care
        // about ordering, but tests do.
        TreeMap<String, Object> sorted = new TreeMap<>(vars != null ? vars : Map.of());
        List<String> keys = new ArrayList<>(sorted.keySet());
        if (maxVarsKeys >= 0 && keys.size() > maxVarsKeys) {
            keys = keys.subList(keys.size() - maxVarsKeys, keys.size());
        }

        Map<String, Object> recent = new LinkedHashMap<>();
        for (String k : keys) recent.put(k, jsonSafe(sorted.get(k)));

        Map<String, Object> snapshot = new LinkedHashMap<>();
        snapshot.put("inputs", safeInputs);
        snapshot.put("vars", recent);

        if (maxBytes <= 0) {
            return snapshot;
        }

        if (encodedBytes(snapshot) <= maxBytes) {
            return snapshot;
        }

        // Trim from the front (oldest keys) until the snapshot fits.
        while (!keys.isEmpty()) {
            keys = keys.subList(1, keys.size());
            recent = new LinkedHashMap<>();
            for (String k : keys) recent.put(k, jsonSafe(sorted.get(k)));
            snapshot.put("vars", recent);
            if (encodedBytes(snapshot) <= maxBytes) {
                return snapshot;
            }
        }

        Map<String, Object> truncated = new LinkedHashMap<>();
        truncated.put("inputs", safeInputs);
        truncated.put("vars", new LinkedHashMap<>());
        truncated.put("_truncated", true);
        return truncated;
    }

    private static int encodedBytes(Object value) {
        return GSON.toJson(value).getBytes(StandardCharsets.UTF_8).length;
    }

    private static Map<String, Object> jsonSafeMap(Map<String, Object> m) {
        Map<String, Object> out = new LinkedHashMap<>();
        if (m == null) return out;
        for (Map.Entry<String, Object> e : m.entrySet()) {
            out.put(e.getKey(), jsonSafe(e.getValue()));
        }
        return out;
    }

    @SuppressWarnings("unchecked")
    private static Object jsonSafe(Object v) {
        if (v == null
                || v instanceof String
                || v instanceof Number
                || v instanceof Boolean) {
            return v;
        }
        if (v instanceof Map<?, ?> raw) {
            Map<String, Object> sm = new LinkedHashMap<>();
            for (Map.Entry<?, ?> e : raw.entrySet()) {
                sm.put(String.valueOf(e.getKey()), jsonSafe(e.getValue()));
            }
            return sm;
        }
        if (v instanceof List<?> list) {
            List<Object> out = new ArrayList<>(list.size());
            for (Object x : list) out.add(jsonSafe(x));
            return out;
        }
        // Anything else — try a JSON round-trip via Gson; on failure fall
        // back to the toString() representation.
        try {
            return GSON.fromJson(GSON.toJson(v), Object.class);
        } catch (Exception ex) {
            return String.valueOf(v);
        }
    }
}
