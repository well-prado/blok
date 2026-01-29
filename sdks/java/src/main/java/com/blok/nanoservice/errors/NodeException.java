package com.blok.nanoservice.errors;

import java.util.HashMap;
import java.util.Map;
import java.util.Objects;

/**
 * Structured exception for node execution errors.
 * Carries an error code, category, and optional detail map.
 */
public class NodeException extends Exception {

    private final int code;
    private final ErrorCategory category;
    private final Map<String, Object> details;

    /**
     * Constructs a NodeException with full details.
     *
     * @param message  the error message
     * @param code     the HTTP-style error code
     * @param category the error category
     * @param details  additional error details (may be null)
     */
    public NodeException(String message, int code, ErrorCategory category, Map<String, Object> details) {
        super(message != null ? message : "unknown error");
        this.code = code;
        this.category = category != null ? category : ErrorCategory.EXECUTION;
        this.details = details;
    }

    /**
     * Constructs a NodeException with a cause.
     *
     * @param message  the error message
     * @param code     the HTTP-style error code
     * @param category the error category
     * @param details  additional error details (may be null)
     * @param cause    the underlying cause
     */
    public NodeException(String message, int code, ErrorCategory category, Map<String, Object> details, Throwable cause) {
        super(message != null ? message : "unknown error", cause);
        this.code = code;
        this.category = category != null ? category : ErrorCategory.EXECUTION;
        this.details = details;
    }

    // Factory methods

    /**
     * Creates a validation error (HTTP 400).
     *
     * @param message the error message
     * @return a NodeException with VALIDATION category
     */
    public static NodeException validation(String message) {
        return new NodeException(message, 400, ErrorCategory.VALIDATION, null);
    }

    /**
     * Creates an execution error (HTTP 500).
     *
     * @param message the error message
     * @return a NodeException with EXECUTION category
     */
    public static NodeException execution(String message) {
        return new NodeException(message, 500, ErrorCategory.EXECUTION, null);
    }

    /**
     * Creates an execution error with a cause (HTTP 500).
     *
     * @param message the error message
     * @param cause   the underlying cause
     * @return a NodeException with EXECUTION category
     */
    public static NodeException execution(String message, Throwable cause) {
        return new NodeException(message, 500, ErrorCategory.EXECUTION, null, cause);
    }

    /**
     * Creates a configuration error (HTTP 500).
     *
     * @param message the error message
     * @return a NodeException with CONFIGURATION category
     */
    public static NodeException configuration(String message) {
        return new NodeException(message, 500, ErrorCategory.CONFIGURATION, null);
    }

    /**
     * Creates a network error (HTTP 502).
     *
     * @param message the error message
     * @return a NodeException with NETWORK category
     */
    public static NodeException network(String message) {
        return new NodeException(message, 502, ErrorCategory.NETWORK, null);
    }

    /**
     * Creates a network error with a cause (HTTP 502).
     *
     * @param message the error message
     * @param cause   the underlying cause
     * @return a NodeException with NETWORK category
     */
    public static NodeException network(String message, Throwable cause) {
        return new NodeException(message, 502, ErrorCategory.NETWORK, null, cause);
    }

    /**
     * Creates a not-found error (HTTP 404).
     *
     * @param message the error message
     * @return a NodeException with NOT_FOUND category
     */
    public static NodeException notFound(String message) {
        return new NodeException(message, 404, ErrorCategory.NOT_FOUND, null);
    }

    /**
     * Converts this exception to a map for serialization in ExecutionResult.
     *
     * @return the error as a map
     */
    public Map<String, Object> toMap() {
        Map<String, Object> map = new HashMap<>();
        map.put("message", getMessage());
        map.put("code", code);
        map.put("category", category.name());
        if (details != null && !details.isEmpty()) {
            map.put("details", details);
        }
        if (getCause() != null) {
            map.put("cause", getCause().getMessage());
        }
        return map;
    }

    // Getters

    public int getCode() {
        return code;
    }

    public ErrorCategory getCategory() {
        return category;
    }

    public Map<String, Object> getDetails() {
        return details;
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (o == null || getClass() != o.getClass()) return false;
        NodeException that = (NodeException) o;
        return code == that.code &&
                Objects.equals(getMessage(), that.getMessage()) &&
                category == that.category &&
                Objects.equals(details, that.details);
    }

    @Override
    public int hashCode() {
        return Objects.hash(getMessage(), code, category, details);
    }

    @Override
    public String toString() {
        return "[" + category + "] " + getMessage() +
                (getCause() != null ? ": " + getCause().getMessage() : "");
    }
}
