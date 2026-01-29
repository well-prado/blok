package com.blok.nanoservice.logging;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Structured logger with a capture buffer.
 * Log entries are captured in memory and can be retrieved via {@link #lines()}
 * for inclusion in {@code ExecutionResult.logs}.
 * <p>
 * Thread-safe: all operations on the entry buffer are synchronized.
 */
public class Logger {

    private final LogLevel minLevel;
    private final List<LogEntry> entries;

    /**
     * Creates a new logger with the specified minimum log level.
     *
     * @param minLevel the minimum severity level to capture
     */
    public Logger(LogLevel minLevel) {
        this.minLevel = minLevel != null ? minLevel : LogLevel.INFO;
        this.entries = new ArrayList<>();
    }

    /**
     * Returns whether the given level meets the minimum threshold.
     *
     * @param level the level to check
     * @return true if the level should be logged
     */
    public boolean shouldLog(LogLevel level) {
        if (level == null) return false;
        return level.getPriority() >= minLevel.getPriority();
    }

    private void log(LogLevel level, String message, Map<String, Object> fields) {
        if (!shouldLog(level)) {
            return;
        }
        LogEntry entry = new LogEntry(level, message, Instant.now(), fields);
        synchronized (entries) {
            entries.add(entry);
        }
    }

    /**
     * Logs a DEBUG-level message.
     *
     * @param message the message
     */
    public void debug(String message) {
        log(LogLevel.DEBUG, message, null);
    }

    /**
     * Logs a DEBUG-level message with fields.
     *
     * @param message the message
     * @param fields  additional structured fields
     */
    public void debug(String message, Map<String, Object> fields) {
        log(LogLevel.DEBUG, message, fields);
    }

    /**
     * Logs an INFO-level message.
     *
     * @param message the message
     */
    public void info(String message) {
        log(LogLevel.INFO, message, null);
    }

    /**
     * Logs an INFO-level message with fields.
     *
     * @param message the message
     * @param fields  additional structured fields
     */
    public void info(String message, Map<String, Object> fields) {
        log(LogLevel.INFO, message, fields);
    }

    /**
     * Logs a WARN-level message.
     *
     * @param message the message
     */
    public void warn(String message) {
        log(LogLevel.WARN, message, null);
    }

    /**
     * Logs a WARN-level message with fields.
     *
     * @param message the message
     * @param fields  additional structured fields
     */
    public void warn(String message, Map<String, Object> fields) {
        log(LogLevel.WARN, message, fields);
    }

    /**
     * Logs an ERROR-level message.
     *
     * @param message the message
     */
    public void error(String message) {
        log(LogLevel.ERROR, message, null);
    }

    /**
     * Logs an ERROR-level message with fields.
     *
     * @param message the message
     * @param fields  additional structured fields
     */
    public void error(String message, Map<String, Object> fields) {
        log(LogLevel.ERROR, message, fields);
    }

    /**
     * Returns a copy of all captured log entries.
     *
     * @return list of log entries
     */
    public List<LogEntry> entries() {
        synchronized (entries) {
            return new ArrayList<>(entries);
        }
    }

    /**
     * Returns all log entries as formatted strings for {@code ExecutionResult.logs}.
     *
     * @return list of formatted log lines
     */
    public List<String> lines() {
        List<LogEntry> snapshot = entries();
        List<String> result = new ArrayList<>(snapshot.size());
        for (LogEntry entry : snapshot) {
            result.add(entry.format());
        }
        return result;
    }

    /**
     * Clears all captured log entries.
     */
    public void clear() {
        synchronized (entries) {
            entries.clear();
        }
    }
}
