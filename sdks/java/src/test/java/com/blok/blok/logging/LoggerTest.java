package com.blok.blok.logging;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Tests for Logger.
 */
class LoggerTest {

    @Test
    void logsAtOrAboveMinLevel() {
        Logger logger = new Logger(LogLevel.INFO);

        logger.debug("debug message");
        logger.info("info message");
        logger.warn("warn message");
        logger.error("error message");

        List<LogEntry> entries = logger.entries();
        assertEquals(3, entries.size());
        assertEquals(LogLevel.INFO, entries.get(0).getLevel());
        assertEquals(LogLevel.WARN, entries.get(1).getLevel());
        assertEquals(LogLevel.ERROR, entries.get(2).getLevel());
    }

    @Test
    void debugLevelCapturesAll() {
        Logger logger = new Logger(LogLevel.DEBUG);

        logger.debug("d");
        logger.info("i");
        logger.warn("w");
        logger.error("e");

        assertEquals(4, logger.entries().size());
    }

    @Test
    void errorLevelCapturesOnlyErrors() {
        Logger logger = new Logger(LogLevel.ERROR);

        logger.debug("d");
        logger.info("i");
        logger.warn("w");
        logger.error("e");

        List<LogEntry> entries = logger.entries();
        assertEquals(1, entries.size());
        assertEquals(LogLevel.ERROR, entries.get(0).getLevel());
    }

    @Test
    void logWithFields() {
        Logger logger = new Logger(LogLevel.DEBUG);

        Map<String, Object> fields = Map.of("key", "value", "count", 42);
        logger.info("message with fields", fields);

        List<LogEntry> entries = logger.entries();
        assertEquals(1, entries.size());
        assertNotNull(entries.get(0).getFields());
        assertEquals("value", entries.get(0).getFields().get("key"));
        assertEquals(42, entries.get(0).getFields().get("count"));
    }

    @Test
    void linesReturnsFormattedStrings() {
        Logger logger = new Logger(LogLevel.INFO);

        logger.info("test message");
        logger.error("error message");

        List<String> lines = logger.lines();
        assertEquals(2, lines.size());
        assertTrue(lines.get(0).contains("[INFO]"));
        assertTrue(lines.get(0).contains("test message"));
        assertTrue(lines.get(1).contains("[ERROR]"));
        assertTrue(lines.get(1).contains("error message"));
    }

    @Test
    void linesIncludesTimestamp() {
        Logger logger = new Logger(LogLevel.INFO);
        logger.info("timestamped");

        List<String> lines = logger.lines();
        assertEquals(1, lines.size());
        // ISO 8601 timestamps contain 'T' and 'Z' or offset
        assertTrue(lines.get(0).matches(".*\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}.*"));
    }

    @Test
    void linesIncludesFields() {
        Logger logger = new Logger(LogLevel.INFO);
        logger.info("with fields", Map.of("workflow", "test-wf"));

        List<String> lines = logger.lines();
        assertTrue(lines.get(0).contains("workflow"));
        assertTrue(lines.get(0).contains("test-wf"));
    }

    @Test
    void clearResetsBuffer() {
        Logger logger = new Logger(LogLevel.DEBUG);

        logger.info("one");
        logger.info("two");
        assertEquals(2, logger.entries().size());

        logger.clear();
        assertEquals(0, logger.entries().size());
    }

    @Test
    void entriesReturnsDefensiveCopy() {
        Logger logger = new Logger(LogLevel.INFO);
        logger.info("test");

        List<LogEntry> entries1 = logger.entries();
        List<LogEntry> entries2 = logger.entries();

        assertNotSame(entries1, entries2);
        assertEquals(entries1.size(), entries2.size());
    }

    @Test
    void shouldLogReturnsFalseForNull() {
        Logger logger = new Logger(LogLevel.INFO);
        assertFalse(logger.shouldLog(null));
    }

    @Test
    void logEntryFormat() {
        LogEntry entry = new LogEntry(LogLevel.WARN, "test warning", java.time.Instant.now(), null);
        String formatted = entry.format();

        assertTrue(formatted.startsWith("[WARN]"));
        assertTrue(formatted.contains("test warning"));
    }

    @Test
    void logEntryFormatWithFields() {
        Map<String, Object> fields = Map.of("key", "val");
        LogEntry entry = new LogEntry(LogLevel.INFO, "msg", java.time.Instant.now(), fields);
        String formatted = entry.format();

        assertTrue(formatted.contains("\"key\""));
        assertTrue(formatted.contains("\"val\""));
    }

    @Test
    void logLevelFromStringValid() {
        assertEquals(LogLevel.DEBUG, LogLevel.fromString("DEBUG", LogLevel.INFO));
        assertEquals(LogLevel.ERROR, LogLevel.fromString("error", LogLevel.INFO));
        assertEquals(LogLevel.WARN, LogLevel.fromString("Warn", LogLevel.INFO));
    }

    @Test
    void logLevelFromStringInvalid() {
        assertEquals(LogLevel.INFO, LogLevel.fromString("INVALID", LogLevel.INFO));
        assertEquals(LogLevel.INFO, LogLevel.fromString(null, LogLevel.INFO));
        assertEquals(LogLevel.INFO, LogLevel.fromString("", LogLevel.INFO));
    }

    @Test
    void logLevelPriorityOrdering() {
        assertTrue(LogLevel.DEBUG.getPriority() < LogLevel.INFO.getPriority());
        assertTrue(LogLevel.INFO.getPriority() < LogLevel.WARN.getPriority());
        assertTrue(LogLevel.WARN.getPriority() < LogLevel.ERROR.getPriority());
    }
}
