package com.blok.blok.node;

/**
 * Implemented by typed nodes ({@link TypedNode}) to expose a description + JSON
 * Schema for the node catalog (GET /__blok/nodes) via gRPC ListNodes
 * (SPEC-B P4). Legacy {@link NodeHandler} nodes do not implement it.
 */
public interface NodeReflector {

    /** Human-readable description, surfaced in the node catalog. */
    String description();

    /** JSON Schema for the input, or {@code null}. */
    String inputSchemaJson();

    /** JSON Schema for the output, or {@code null}. */
    String outputSchemaJson();
}
