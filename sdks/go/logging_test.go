package nanoservice

import (
	"strings"
	"testing"
)

func TestLoggerLevels(t *testing.T) {
	logger := NewLogger(LogLevelInfo)

	logger.Debug("debug message")
	logger.Info("info message")
	logger.Warn("warn message")
	logger.Error("error message")

	entries := logger.Entries()
	if len(entries) != 3 {
		t.Errorf("expected 3 entries (debug filtered), got %d", len(entries))
	}

	if entries[0].Level != LogLevelInfo {
		t.Errorf("expected INFO, got %v", entries[0].Level)
	}
	if entries[1].Level != LogLevelWarn {
		t.Errorf("expected WARN, got %v", entries[1].Level)
	}
	if entries[2].Level != LogLevelError {
		t.Errorf("expected ERROR, got %v", entries[2].Level)
	}
}

func TestLoggerDebugLevel(t *testing.T) {
	logger := NewLogger(LogLevelDebug)

	logger.Debug("debug message")
	logger.Info("info message")

	entries := logger.Entries()
	if len(entries) != 2 {
		t.Errorf("expected 2 entries, got %d", len(entries))
	}
}

func TestLoggerErrorLevel(t *testing.T) {
	logger := NewLogger(LogLevelError)

	logger.Debug("debug")
	logger.Info("info")
	logger.Warn("warn")
	logger.Error("error")

	entries := logger.Entries()
	if len(entries) != 1 {
		t.Errorf("expected 1 entry, got %d", len(entries))
	}
}

func TestLoggerWithFields(t *testing.T) {
	logger := NewLogger(LogLevelDebug)

	logger.Info("test message", map[string]interface{}{
		"key": "value",
		"num": 42,
	})

	entries := logger.Entries()
	if len(entries) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(entries))
	}

	if entries[0].Fields["key"] != "value" {
		t.Errorf("expected field 'key' = 'value', got %v", entries[0].Fields["key"])
	}
}

func TestLoggerLines(t *testing.T) {
	logger := NewLogger(LogLevelDebug)

	logger.Info("hello world")
	logger.Error("something broke")

	lines := logger.Lines()
	if len(lines) != 2 {
		t.Fatalf("expected 2 lines, got %d", len(lines))
	}

	if !strings.Contains(lines[0], "[INFO]") {
		t.Errorf("expected [INFO] in first line, got %q", lines[0])
	}
	if !strings.Contains(lines[0], "hello world") {
		t.Errorf("expected 'hello world' in first line, got %q", lines[0])
	}

	if !strings.Contains(lines[1], "[ERROR]") {
		t.Errorf("expected [ERROR] in second line, got %q", lines[1])
	}
}

func TestLoggerClear(t *testing.T) {
	logger := NewLogger(LogLevelDebug)

	logger.Info("test")
	if len(logger.Entries()) != 1 {
		t.Fatal("expected 1 entry before clear")
	}

	logger.Clear()
	if len(logger.Entries()) != 0 {
		t.Error("expected 0 entries after clear")
	}
}

func TestLogEntryString(t *testing.T) {
	entry := LogEntry{
		Level:   LogLevelInfo,
		Message: "test message",
	}

	s := entry.String()
	if !strings.Contains(s, "[INFO]") {
		t.Errorf("expected [INFO] in string, got %q", s)
	}
	if !strings.Contains(s, "test message") {
		t.Errorf("expected 'test message' in string, got %q", s)
	}
}

func TestLogEntryStringWithFields(t *testing.T) {
	entry := LogEntry{
		Level:   LogLevelWarn,
		Message: "warning",
		Fields:  map[string]interface{}{"key": "value"},
	}

	s := entry.String()
	if !strings.Contains(s, "key") || !strings.Contains(s, "value") {
		t.Errorf("expected fields in string, got %q", s)
	}
}
