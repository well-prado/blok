package com.blok.blok.logging;

/**
 * Log severity levels with priority ordering.
 * Higher priority values indicate more severe levels.
 */
public enum LogLevel {

    DEBUG(0),
    INFO(1),
    WARN(2),
    ERROR(3);

    private final int priority;

    LogLevel(int priority) {
        this.priority = priority;
    }

    /**
     * Returns the priority value for this level.
     * Higher values are more severe.
     *
     * @return the priority
     */
    public int getPriority() {
        return priority;
    }

    /**
     * Parses a log level from a string, case-insensitive.
     * Returns the default level if the string is not recognized.
     *
     * @param value        the string to parse
     * @param defaultLevel the fallback level
     * @return the parsed log level
     */
    public static LogLevel fromString(String value, LogLevel defaultLevel) {
        if (value == null || value.isBlank()) {
            return defaultLevel;
        }
        try {
            return LogLevel.valueOf(value.trim().toUpperCase());
        } catch (IllegalArgumentException e) {
            return defaultLevel;
        }
    }
}
