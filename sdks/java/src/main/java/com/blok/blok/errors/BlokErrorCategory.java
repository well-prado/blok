package com.blok.blok.errors;

/**
 * The 12 canonical error categories every Blok node error falls into.
 *
 * <p>Mirrors the proto {@code blok.runtime.v1.ErrorCategory} enum value-for-value
 * and matches the Python {@code BlokErrorCategory}, Go {@code CategoryDependency},
 * and Rust {@code BlokErrorCategory::Dependency} constants. Each category carries
 * a default HTTP status and retryable hint that authors can override per-error.
 */
public enum BlokErrorCategory {

    /** Input failed schema validation. Default HTTP 400, non-retryable. */
    VALIDATION(400, false),
    /** Misconfiguration of the runner / node / environment. Default 500, non-retryable. */
    CONFIGURATION(500, false),
    /** External dependency unreachable (DB, API). Default 502, retryable. */
    DEPENDENCY(502, true),
    /** Deadline exceeded. Default 504, retryable. */
    TIMEOUT(504, true),
    /** Caller lacks the right role/scope. Default 403, non-retryable. */
    PERMISSION(403, false),
    /** Caller exceeded a quota. Default 429, retryable with retry_after_ms. */
    RATE_LIMIT(429, true),
    /** Resource not found. Default 404, non-retryable. */
    NOT_FOUND(404, false),
    /** Idempotency violation, concurrent update. Default 409, non-retryable. */
    CONFLICT(409, false),
    /** Caller cancelled before completion. Default 499, non-retryable. */
    CANCELLED(499, false),
    /** SDK threw without classification — default fallback. Default 500, non-retryable. */
    INTERNAL(500, false),
    /** Wire-format / framing / serialization error. Default 502, non-retryable. */
    PROTOCOL(502, false),
    /** Payload schema OK but values are unprocessable. Default 422, non-retryable. */
    DATA(422, false);

    private final int defaultHttpStatus;
    private final boolean defaultRetryable;

    BlokErrorCategory(int defaultHttpStatus, boolean defaultRetryable) {
        this.defaultHttpStatus = defaultHttpStatus;
        this.defaultRetryable = defaultRetryable;
    }

    /** HTTP status conventionally associated with this category. */
    public int defaultHttpStatus() {
        return defaultHttpStatus;
    }

    /** Retryable hint conventionally associated with this category. */
    public boolean defaultRetryable() {
        return defaultRetryable;
    }

    /**
     * Parse a string into a category, falling back to {@link #INTERNAL} for
     * unknown values (matches Python/Go/Rust behaviour).
     */
    public static BlokErrorCategory parse(String value) {
        if (value == null) return INTERNAL;
        try {
            return BlokErrorCategory.valueOf(value);
        } catch (IllegalArgumentException ex) {
            return INTERNAL;
        }
    }
}
