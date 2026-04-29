package com.blok.blok.errors;

/**
 * How serious an error is. Mirrors the proto
 * {@code blok.runtime.v1.ErrorSeverity} enum. Default for thrown errors is
 * {@link #ERROR}.
 */
public enum BlokErrorSeverity {

    /** Informational, no action needed. */
    INFO,
    /** Recoverable, worth surfacing. */
    WARN,
    /** Standard error level. */
    ERROR,
    /** Process must terminate. */
    FATAL;

    /**
     * Parse a string into a severity, falling back to {@link #ERROR} for
     * unknown values.
     */
    public static BlokErrorSeverity parse(String value) {
        if (value == null) return ERROR;
        try {
            return BlokErrorSeverity.valueOf(value);
        } catch (IllegalArgumentException ex) {
            return ERROR;
        }
    }
}
