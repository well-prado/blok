package com.blok.nanoservice.logging;

import com.google.gson.Gson;

import java.time.Instant;
import java.util.Map;
import java.util.Objects;

/**
 * Represents a single structured log entry.
 */
public class LogEntry {

    private final LogLevel level;
    private final String message;
    private final Instant timestamp;
    private final Map<String, Object> fields;

    public LogEntry(LogLevel level, String message, Instant timestamp, Map<String, Object> fields) {
        this.level = level != null ? level : LogLevel.INFO;
        this.message = message != null ? message : "";
        this.timestamp = timestamp != null ? timestamp : Instant.now();
        this.fields = fields;
    }

    public LogLevel getLevel() {
        return level;
    }

    public String getMessage() {
        return message;
    }

    public Instant getTimestamp() {
        return timestamp;
    }

    public Map<String, Object> getFields() {
        return fields;
    }

    /**
     * Formats this entry as a human-readable string.
     *
     * @return formatted log line
     */
    public String format() {
        StringBuilder sb = new StringBuilder();
        sb.append("[").append(level).append("] ");
        sb.append(timestamp.toString()).append(" ");
        sb.append(message);
        if (fields != null && !fields.isEmpty()) {
            sb.append(" ").append(new Gson().toJson(fields));
        }
        return sb.toString();
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (o == null || getClass() != o.getClass()) return false;
        LogEntry logEntry = (LogEntry) o;
        return level == logEntry.level &&
                Objects.equals(message, logEntry.message) &&
                Objects.equals(timestamp, logEntry.timestamp) &&
                Objects.equals(fields, logEntry.fields);
    }

    @Override
    public int hashCode() {
        return Objects.hash(level, message, timestamp, fields);
    }

    @Override
    public String toString() {
        return format();
    }
}
