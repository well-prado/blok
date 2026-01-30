package com.blok.blok.errors;

/**
 * Classifies the type of error that occurred during node execution.
 */
public enum ErrorCategory {

    /** Schema or input validation failure. */
    VALIDATION,

    /** Error during node execution. */
    EXECUTION,

    /** Misconfiguration of node or server. */
    CONFIGURATION,

    /** Network or connectivity issue. */
    NETWORK,

    /** Requested resource was not found. */
    NOT_FOUND
}
