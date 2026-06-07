package com.blok.blok.node;

import com.blok.blok.errors.BlokError;
import com.blok.blok.types.Context;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.util.List;
import java.util.Map;

/**
 * Typed node base (SPEC-B P4) — the Java equivalent of the TypeScript
 * {@code defineNode} / Python {@code @node} / Rust {@code TypedNode} / Go
 * {@code DefineNode}. Declare typed {@code I}/{@code O} types (e.g. records) and
 * implement {@link #run}; the SDK converts the raw config into the typed input
 * BEFORE running (a type mismatch → structured {@link BlokError}, HTTP 400),
 * and reflects both JSON Schemas for the catalog — instead of a raw
 * {@code Map<String, Object>}.
 *
 * <p>Register like any handler:
 * {@code registry.register("@acme/search", new SearchNode());}
 *
 * <pre>{@code
 * public record SearchInput(String query, int limit) {}
 * public record SearchOutput(List<String> results, int count) {}
 *
 * public final class SearchNode extends TypedNode<SearchInput, SearchOutput> {
 *     public String name() { return "@acme/search"; }
 *     public String description() { return "Full-text search"; }
 *     protected Class<SearchInput> inputClass() { return SearchInput.class; }
 *     protected Class<?> outputClass() { return SearchOutput.class; }
 *     protected SearchOutput run(Context ctx, SearchInput input) {
 *         var rows = Collections.nCopies(input.limit(), input.query());
 *         return new SearchOutput(rows, rows.size());
 *     }
 * }
 * }</pre>
 *
 * @param <I> the typed input
 * @param <O> the typed output
 */
public abstract class TypedNode<I, O> implements NodeHandler, NodeReflector {

    private static final Gson GSON = new Gson();

    /** The node's registered name (e.g. {@code "@acme/search"}). */
    public abstract String name();

    /** {@inheritDoc} Human-readable description; override to set. */
    @Override
    public String description() {
        return "";
    }

    /** The class of the typed input (e.g. {@code SearchInput.class}). */
    protected abstract Class<I> inputClass();

    /** The class of the typed output, for schema reflection; {@code null} to skip. */
    protected Class<?> outputClass() {
        return null;
    }

    /** Run the node with a VALIDATED, typed input. */
    protected abstract O run(Context ctx, I input) throws Exception;

    @Override
    public Object execute(Context ctx, Map<String, Object> config) throws Exception {
        I input;
        try {
            input = GSON.fromJson(GSON.toJsonTree(config), inputClass());
        } catch (RuntimeException e) {
            throw BlokError.validation()
                    .code("NODE_INPUT_VALIDATION")
                    .message("Input validation failed for node '" + name() + "': " + e.getMessage())
                    .httpStatus(400)
                    .node(name())
                    .build();
        }
        return run(ctx, input);
    }

    @Override
    public String inputSchemaJson() {
        return reflectSchema(inputClass());
    }

    @Override
    public String outputSchemaJson() {
        Class<?> out = outputClass();
        return out == null ? null : reflectSchema(out);
    }

    /** Build a minimal JSON Schema from the type's declared instance fields. */
    private static String reflectSchema(Class<?> type) {
        try {
            JsonObject schema = new JsonObject();
            schema.addProperty("type", "object");
            JsonObject properties = new JsonObject();
            JsonArray required = new JsonArray();
            for (Field field : type.getDeclaredFields()) {
                if (Modifier.isStatic(field.getModifiers())) {
                    continue;
                }
                JsonObject property = new JsonObject();
                property.addProperty("type", jsonType(field.getType()));
                properties.add(field.getName(), property);
                if (field.getType().isPrimitive()) {
                    required.add(field.getName());
                }
            }
            schema.add("properties", properties);
            if (required.size() > 0) {
                schema.add("required", required);
            }
            return GSON.toJson(schema);
        } catch (RuntimeException e) {
            return null;
        }
    }

    private static String jsonType(Class<?> type) {
        if (type == int.class || type == Integer.class || type == long.class || type == Long.class
                || type == short.class || type == Short.class) {
            return "integer";
        }
        if (type == double.class || type == Double.class || type == float.class || type == Float.class) {
            return "number";
        }
        if (type == boolean.class || type == Boolean.class) {
            return "boolean";
        }
        if (type == String.class) {
            return "string";
        }
        if (type.isArray() || List.class.isAssignableFrom(type)) {
            return "array";
        }
        return "object";
    }
}
